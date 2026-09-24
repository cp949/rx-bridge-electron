import { BridgeProtocolError } from "../protocol/index.js";
import { recordDiagnostic } from "./diagnostics.js";
import type { ResourceLimits } from "./resource-limits.js";
import type {
  AttachedTarget,
  DiagnosticsSink,
  SenderIdentity,
} from "./types.js";

export interface DocumentSession {
  readonly target: AttachedTarget;
  readonly clientId: string;
  readonly signal: AbortSignal;
}

type LifecycleReason =
  "main-frame-navigation" | "render-process-gone" | "destroyed";

interface SessionState {
  readonly controller: AbortController;
  readonly active: Map<
    string,
    { readonly key: string; readonly controller: AbortController }
  >;
  runningRpc: number;
}

interface Attachment {
  readonly target: AttachedTarget;
  readonly removeLifecycle: () => void;
  current: DocumentSession | undefined;
}

export class DocumentSessions {
  readonly #attachments = new Map<number, Attachment>();
  readonly #retiredClients = new Map<number, Set<string>>();
  readonly #states = new WeakMap<DocumentSession, SessionState>();
  readonly #diagnostics: DiagnosticsSink | undefined;
  readonly #resourceLimits: ResourceLimits;
  #disposed = false;
  #globalRunningRpc = 0;

  public constructor(
    resourceLimits: ResourceLimits,
    diagnostics?: DiagnosticsSink,
  ) {
    this.#resourceLimits = resourceLimits;
    this.#diagnostics = diagnostics;
  }

  public attach(target: AttachedTarget): () => void {
    if (this.#disposed)
      throw new BridgeProtocolError("FORBIDDEN", "Bridge server is disposed.");
    this.#detach(target.webContentsId);
    if (this.#attachments.has(target.webContentsId)) return () => {};
    const attachment: Attachment = {
      target,
      removeLifecycle: target.onLifecycle((reason) =>
        this.#retire(attachment, reason),
      ),
      current: undefined,
    };
    this.#attachments.set(target.webContentsId, attachment);
    return () => {
      if (this.#attachments.get(target.webContentsId) === attachment)
        this.#detach(target.webContentsId);
    };
  }

  public establish(
    sender: SenderIdentity,
    clientId: string,
  ): DocumentSession | undefined {
    if (this.#disposed) return undefined;
    const attachment = this.#attachments.get(sender.webContentsId);
    if (
      attachment === undefined ||
      !sender.isMainFrame ||
      !attachment.target.isCurrentMainFrame(sender) ||
      !attachment.target.isAllowedOrigin(sender.origin)
    )
      return undefined;
    const current = attachment.current;
    if (current?.clientId === clientId) return current;
    if (this.#retiredClients.get(sender.webContentsId)?.has(clientId))
      return undefined;
    this.#retire(attachment);
    if (
      this.#attachments.get(sender.webContentsId) !== attachment ||
      attachment.current !== undefined
    )
      return undefined;
    const controller = new AbortController();
    const session: DocumentSession = {
      target: attachment.target,
      clientId,
      signal: controller.signal,
    };
    this.#states.set(session, {
      controller,
      active: new Map(),
      runningRpc: 0,
    });
    attachment.current = session;
    recordDiagnostic(this.#diagnostics, { type: "session-opened" });
    return session;
  }

  public current(
    sender: SenderIdentity,
    clientId: string,
  ): DocumentSession | undefined {
    if (this.#disposed) return undefined;
    const attachment = this.#attachments.get(sender.webContentsId);
    if (
      attachment === undefined ||
      !sender.isMainFrame ||
      !attachment.target.isCurrentMainFrame(sender) ||
      !attachment.target.isAllowedOrigin(sender.origin)
    )
      return undefined;
    const session = attachment.current;
    return session?.clientId === clientId && !session.signal.aborted
      ? session
      : undefined;
  }

  public tryAcquireRpc(session: DocumentSession): boolean {
    const state = this.#states.get(session);
    if (state === undefined) return false;
    if (state.runningRpc >= this.#resourceLimits.maxConcurrentRpc) return false;
    state.runningRpc += 1;
    this.#globalRunningRpc += 1;
    return true;
  }

  public releaseRpc(session: DocumentSession): void {
    const state = this.#states.get(session);
    if (state !== undefined)
      state.runningRpc = Math.max(0, state.runningRpc - 1);
    this.#globalRunningRpc = Math.max(0, this.#globalRunningRpc - 1);
  }

  public sessionCount(): number {
    let count = 0;
    for (const attachment of this.#attachments.values())
      if (attachment.current !== undefined) count += 1;
    return count;
  }

  public rpcInFlightCount(): number {
    return this.#globalRunningRpc;
  }

  public beginRpc(
    session: DocumentSession,
    id: string,
    key: string,
  ): AbortController {
    this.cancelRpc(session, id);
    const controller = new AbortController();
    this.#states.get(session)?.active.set(id, { key, controller });
    return controller;
  }

  public finishRpc(
    session: DocumentSession,
    id: string,
    controller: AbortController,
  ): void {
    const state = this.#states.get(session);
    if (state?.active.get(id)?.controller === controller)
      state.active.delete(id);
  }

  public cancelRpc(session: DocumentSession, id: string): void {
    const state = this.#states.get(session);
    const work = state?.active.get(id);
    if (work === undefined) return;
    state?.active.delete(id);
    work.controller.abort();
    recordDiagnostic(this.#diagnostics, {
      type: "rpc-cancelled",
      key: work.key,
    });
  }

  public retiredClientCount(webContentsId: number): number {
    return this.#retiredClients.get(webContentsId)?.size ?? 0;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const id of [...this.#attachments.keys()]) this.#detach(id);
  }

  #detach(id: number): void {
    const attachment = this.#attachments.get(id);
    if (attachment === undefined) return;
    this.#attachments.delete(id);
    attachment.removeLifecycle();
    this.#retire(attachment);
  }

  #retire(attachment: Attachment, reason?: LifecycleReason): void {
    const webContentsId = attachment.target.webContentsId;
    const session = attachment.current;
    if (session !== undefined) {
      attachment.current = undefined;
      recordDiagnostic(this.#diagnostics, { type: "session-closed" });
      let retired = this.#retiredClients.get(webContentsId);
      if (retired === undefined) {
        retired = new Set();
        this.#retiredClients.set(webContentsId, retired);
      }
      retired.add(session.clientId);
      while (
        retired.size > this.#resourceLimits.maxRetiredClientsPerWebContents
      ) {
        const oldest = retired.values().next().value;
        if (oldest === undefined) break;
        retired.delete(oldest);
      }
      const state = this.#states.get(session);
      state?.controller.abort();
      for (const id of [...(state?.active.keys() ?? [])])
        this.cancelRpc(session, id);
    }
    if (reason === "destroyed") this.#retiredClients.delete(webContentsId);
  }
}
