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
  /** retire 사유. 살아 있는 세션은 `undefined`다. */
  readonly retireReason: RetireReason | undefined;
  /**
   * retire 통지를 등록한다. 이미 retire된 세션이면 `listener`를 반환 전에
   * 동기 호출하고 no-op 해제 함수를 돌려준다. 그 외에는 호출마다 독립
   * 등록이다 — 같은 함수를 두 번 등록하면 두 번 호출된다. 반환된 해제
   * 함수는 자기 등록만 지우고 멱등이다.
   */
  onRetire(listener: () => void): () => void;
}

/** sender admission이 낼 수 있는 사유만 좁힌 부분집합. */
export type SenderRejectReason = Extract<
  RejectReason,
  "frame-not-main" | "origin-not-allowed" | "sender-unauthorized"
>;

/** RPC·stream subscribe admission 거부가 함께 쓰는 `FORBIDDEN` 문구. */
export const SENDER_UNAUTHORIZED_MESSAGE = "Bridge sender is not authorized.";

/** `establish`·`current`의 판정 결과. 세션 아니면 사유, 둘 중 하나다. */
export type Admission =
  | { readonly session: DocumentSession }
  | { readonly reason: SenderRejectReason };

type LifecycleReason =
  "main-frame-navigation" | "render-process-gone" | "destroyed";

/** `retireReason`에 실리는 retire 사유. lifecycle 3종에 detach·dispose·새 clientId를 더한다. */
export type RetireReason = LifecycleReason | "detach" | "dispose" | "replaced";

/** `DocumentSession` 구현. 비공개 `AbortController`와 사유를 쥔다. module 밖에는 interface로만 보인다. */
class SessionImpl implements DocumentSession {
  public readonly target: AttachedTarget;
  public readonly clientId: string;
  readonly #controller = new AbortController();
  #reason: RetireReason | undefined;

  public constructor(target: AttachedTarget, clientId: string) {
    this.target = target;
    this.clientId = clientId;
  }

  public get signal(): AbortSignal {
    return this.#controller.signal;
  }

  public get retireReason(): RetireReason | undefined {
    return this.#reason;
  }

  /** 사유를 먼저 설정하고 abort한다. 두 번째 호출은 no-op이다. */
  public retire(reason: RetireReason): void {
    if (this.#reason !== undefined) return;
    this.#reason = reason;
    this.#controller.abort(reason);
  }

  public onRetire(listener: () => void): () => void {
    if (this.#reason !== undefined) {
      listener();
      return () => {};
    }
    const wrapper = (): void => listener();
    this.#controller.signal.addEventListener("abort", wrapper, {
      once: true,
    });
    return () => {
      this.#controller.signal.removeEventListener("abort", wrapper);
    };
  }
}

interface Attachment {
  readonly target: AttachedTarget;
  readonly removeLifecycle: () => void;
  current: SessionImpl | undefined;
}

export class DocumentSessions {
  readonly #attachments = new Map<number, Attachment>();
  readonly #retiredClients = new Map<number, Set<string>>();
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
    this.#detach(target.webContentsId, "detach");
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
        this.#detach(target.webContentsId, "detach");
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
    this.#retire(attachment, "replaced");
    if (
      this.#attachments.get(sender.webContentsId) !== attachment ||
      attachment.current !== undefined
    )
      return { reason: "sender-unauthorized" };
    const session = new SessionImpl(attachment.target, clientId);
    attachment.current = session;
    recordDiagnostic(this.#diagnostics, { type: "session-opened" });
    return { session };
  }

  public current(sender: SenderIdentity, clientId: string): Admission {
    const admitted = this.#admit(sender);
    if (typeof admitted === "string") return { reason: admitted };
    const session = admitted.current;
    return session?.clientId === clientId && session.retireReason === undefined
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
    for (const id of [...this.#attachments.keys()]) this.#detach(id, "dispose");
  }

  #detach(id: number, reason: RetireReason): void {
    const attachment = this.#attachments.get(id);
    if (attachment === undefined) return;
    this.#attachments.delete(id);
    attachment.removeLifecycle();
    this.#retire(attachment, reason);
  }

  #retire(attachment: Attachment, reason: RetireReason): void {
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
      session.retire(reason);
    }
    if (reason === "destroyed") this.#retiredClients.delete(webContentsId);
  }
}
