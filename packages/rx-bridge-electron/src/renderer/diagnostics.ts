/**
 * Renderer 진단 이벤트 타입과 격리 함수. 결정은
 * `docs/adr/0022-renderer-diagnostics.md` 결정 3(타입)·결정 11(격리 함수)을
 * 따른다. `RpcClient`·`StreamMultiplexer`·`create-renderer-api.ts`가
 * import한다 — Renderer main world에서 실행되며 `src/main`을 import하지
 * 않는다(ADR 0022 결정 11).
 */

/** `rpc-settled` 이벤트의 확정 원인. */
export type RpcSettleCause =
  | "ok"
  | "remote-error"
  | "deadline"
  | "aborted"
  | "disposed"
  | "invalid-options"
  | "transport-failed"
  | "malformed-response";

/** `subscription-closed` 이벤트의 종료 원인. */
export type SubscriptionCloseCause =
  | "unsubscribed"
  | "completed"
  | "remote-error"
  | "disposed"
  | "transport-failed";

/** `handshake-failed` 이벤트의 실패 원인. */
export type HandshakeFailureReason =
  "transport" | "malformed" | "version-mismatch" | "invalid-manifest";

/** `message-dropped` 이벤트의 폐기 원인. */
export type DroppedMessageReason =
  "malformed" | "envelope-mismatch" | "out-of-order";

/**
 * Renderer 진단 이벤트. 닫힌 판별 유니온이다. 식별자(`requestId`·
 * `subscriptionId`·`clientId`)와 원문 payload(`message`·`stack`·`details`)는
 * 싣지 않는다 — ADR 0010 결정 3을 준용한다(ADR 0022 결정 4). 예외는 `code`이며
 * `cause: "remote-error"`일 때만 있다.
 */
export type RendererDiagnostic =
  | {
      readonly type: "rpc-settled";
      readonly key: string;
      readonly durationMs: number;
      readonly cause: RpcSettleCause;
      readonly code?: string;
    }
  | { readonly type: "subscription-opened"; readonly key: string }
  | {
      readonly type: "subscription-closed";
      readonly key: string;
      readonly cause: SubscriptionCloseCause;
      readonly code?: string;
    }
  | {
      readonly type: "handshake-failed";
      readonly reason: HandshakeFailureReason;
    }
  | { readonly type: "message-dropped"; readonly reason: DroppedMessageReason }
  | {
      readonly type: "transport-failed";
      readonly channel: "cancel" | "control";
    };

/** Renderer가 진단 이벤트를 관측하기 위해 구현하는 sink. */
export interface RendererDiagnosticsSink {
  record(event: RendererDiagnostic): void;
}

/**
 * sink에 이벤트를 기록한다. sink가 없으면 아무것도 하지 않는다. `record`의
 * 동기 throw는 삼켜 API 동작에 영향을 주지 않는다(ADR 0022 결정 11, ADR 0010
 * 결정 11과 동일). `record`가 Promise를 반환해도 await하지 않는다.
 */
export function recordRendererDiagnostic(
  sink: RendererDiagnosticsSink | undefined,
  event: RendererDiagnostic,
): void {
  if (sink === undefined) return;
  try {
    sink.record(event);
  } catch {
    // A sink failure must not affect renderer API behavior.
  }
}
