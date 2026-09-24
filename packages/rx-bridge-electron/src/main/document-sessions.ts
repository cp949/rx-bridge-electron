import { BridgeProtocolError } from "../protocol/index.js";
import { recordDiagnostic } from "./diagnostics.js";
import type { ResourceLimits } from "./resource-limits.js";
import type {
  AttachedTarget,
  DiagnosticsSink,
  RejectReason,
  SenderIdentity,
} from "./types.js";

export interface DocumentSession {
  readonly target: AttachedTarget;
  readonly clientId: string;
  readonly signal: AbortSignal;
}

/** sender admission이 낼 수 있는 사유만 좁힌 부분집합. */
export type SenderRejectReason = Extract<
  RejectReason,
  "frame-not-main" | "origin-not-allowed" | "sender-unauthorized"
>;

/** `establish`·`current`의 판정 결과. 세션 아니면 사유, 둘 중 하나다. */
export type Admission =
  | { readonly session: DocumentSession }
  | { readonly reason: SenderRejectReason };

type LifecycleReason =
  "main-frame-navigation" | "render-process-gone" | "destroyed";

interface Attachment {
  readonly target: AttachedTarget;
  readonly removeLifecycle: () => void;
  current: DocumentSession | undefined;
}

export class DocumentSessions {
  readonly #attachments = new Map<number, Attachment>();
  readonly #retiredClients = new Map<number, Set<string>>();
  readonly #controllers = new WeakMap<DocumentSession, AbortController>();
  readonly #diagnostics: DiagnosticsSink | undefined;
  readonly #resourceLimits: ResourceLimits;
  #disposed = false;

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

  /**
   * frame·origin·attachment 판정 하나. 채널과 무관하게 같은 사유를 낸다
   * (`establish`·`current`가 공유). 순서: disposed·미attach →
   * `sender-unauthorized`, subframe이거나 현재 main frame이 아님 →
   * `frame-not-main`, 허용 목록 밖 origin → `origin-not-allowed`.
   */
  #admit(sender: SenderIdentity): Attachment | SenderRejectReason {
    if (this.#disposed) return "sender-unauthorized";
    const attachment = this.#attachments.get(sender.webContentsId);
    if (attachment === undefined) return "sender-unauthorized";
    if (!sender.isMainFrame || !attachment.target.isCurrentMainFrame(sender))
      return "frame-not-main";
    if (!attachment.target.isAllowedOrigin(sender.origin))
      return "origin-not-allowed";
    return attachment;
  }

  public establish(sender: SenderIdentity, clientId: string): Admission {
    const admitted = this.#admit(sender);
    if (typeof admitted === "string") return { reason: admitted };
    const attachment = admitted;
    const current = attachment.current;
    if (current?.clientId === clientId) return { session: current };
    if (this.#retiredClients.get(sender.webContentsId)?.has(clientId))
      return { reason: "sender-unauthorized" };
    this.#retire(attachment);
    if (
      this.#attachments.get(sender.webContentsId) !== attachment ||
      attachment.current !== undefined
    )
      return { reason: "sender-unauthorized" };
    const controller = new AbortController();
    const session: DocumentSession = {
      target: attachment.target,
      clientId,
      signal: controller.signal,
    };
    this.#controllers.set(session, controller);
    attachment.current = session;
    recordDiagnostic(this.#diagnostics, { type: "session-opened" });
    return { session };
  }

  public current(sender: SenderIdentity, clientId: string): Admission {
    const admitted = this.#admit(sender);
    if (typeof admitted === "string") return { reason: admitted };
    const session = admitted.current;
    return session?.clientId === clientId && !session.signal.aborted
      ? { session }
      : { reason: "sender-unauthorized" };
  }

  public sessionCount(): number {
    let count = 0;
    for (const attachment of this.#attachments.values())
      if (attachment.current !== undefined) count += 1;
    return count;
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
      this.#controllers.get(session)?.abort();
    }
    if (reason === "destroyed") this.#retiredClients.delete(webContentsId);
  }
}
