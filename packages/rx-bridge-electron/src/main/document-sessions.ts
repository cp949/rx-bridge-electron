import { BridgeProtocolError } from "../protocol/index.js";
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

interface SessionState {
  readonly controller: AbortController;
  readonly usedStreamIds: Set<string>;
  readonly pendingStreams: Map<string, AbortController>;
  readonly active: Map<
    string,
    { readonly key: string; readonly controller: AbortController }
  >;
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
  #disposed = false;

  public constructor(diagnostics?: DiagnosticsSink) {
    this.#diagnostics = diagnostics;
  }

  public attach(target: AttachedTarget): () => void {
    if (this.#disposed)
      throw new BridgeProtocolError("FORBIDDEN", "Bridge server is disposed.");
    this.#detach(target.webContentsId);
    if (this.#attachments.has(target.webContentsId)) return () => {};
    const attachment: Attachment = {
      target,
      removeLifecycle: target.onLifecycle(() => this.#retire(attachment)),
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
      usedStreamIds: new Set(),
      pendingStreams: new Map(),
      active: new Map(),
    });
    attachment.current = session;
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
    this.#diagnostics?.record({ type: "rpc-cancelled", key: work.key });
  }

  public beginStream(
    session: DocumentSession,
    id: string,
  ): AbortController | undefined {
    const state = this.#states.get(session);
    if (state === undefined || state.usedStreamIds.has(id)) return undefined;
    state.usedStreamIds.add(id);
    const controller = new AbortController();
    state.pendingStreams.set(id, controller);
    return controller;
  }

  public finishStream(
    session: DocumentSession,
    id: string,
    controller: AbortController,
  ): boolean {
    const state = this.#states.get(session);
    if (
      state?.pendingStreams.get(id) !== controller ||
      controller.signal.aborted ||
      session.signal.aborted
    )
      return false;
    state.pendingStreams.delete(id);
    return true;
  }

  public cancelStream(session: DocumentSession, id: string): void {
    const state = this.#states.get(session);
    const controller = state?.pendingStreams.get(id);
    if (controller === undefined) return;
    state?.pendingStreams.delete(id);
    controller.abort();
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

  #retire(attachment: Attachment): void {
    const session = attachment.current;
    if (session === undefined) return;
    attachment.current = undefined;
    let retired = this.#retiredClients.get(attachment.target.webContentsId);
    if (retired === undefined) {
      retired = new Set();
      this.#retiredClients.set(attachment.target.webContentsId, retired);
    }
    retired.add(session.clientId);
    const state = this.#states.get(session);
    state?.controller.abort();
    for (const id of [...(state?.active.keys() ?? [])])
      this.cancelRpc(session, id);
    for (const id of [...(state?.pendingStreams.keys() ?? [])])
      this.cancelStream(session, id);
    state?.usedStreamIds.clear();
  }
}
