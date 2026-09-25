/**
 * RPC·stream이 공유하는 authorize 판정 단계(ADR 0011 결정 1·2·4, ADR 0018
 * `BridgeOperation` 전달, ADR 0010 `authorize-denied` 진단)가 소유하는 불변식은
 * 여기 하나에 모인다: context 조립, `authorize` 호출, 예외·거부 분류,
 * `authorize-denied` 진단 기록이다.
 *
 * 번역(RPC 응답으로 만들지 stream 프레임으로 만들지)과 slot 반환은 이 module이
 * 모른다 — 호출자(`RpcRequests`·`Subscriptions`)가 `AuthorizeVerdict`를 받아
 * 각자의 방식으로 옮긴다.
 *
 * `authorize`가 생략된 경우 결과를 동기로 돌려준다: 두 호출자 모두 지금까지
 * `authorize === undefined`일 때 같은 tick 안에서 진행했고(요청 시작과 handler
 * 호출, 또는 구독과 `subscribed` 전송 사이에 await가 없었다), 이 module을
 * 무조건 `await`하면 microtask 하나가 끼어들어 그 순서가 깨진다.
 */

import type { RpcErrorPayload } from "../protocol/index.js";
import type { LibraryErrorPayload } from "../protocol/messages.js";
import type { DocumentSession } from "./document-sessions.js";
import { recordDiagnostic } from "./diagnostics.js";
import { internalError } from "./error-serializer.js";
import type {
  Authorize,
  BridgeContext,
  BridgeOperation,
  DiagnosticsSink,
  SenderIdentity,
} from "./types.js";

/** authorize 판정 단계의 결과. 호출자가 RPC 응답이나 stream 프레임으로 번역한다. */
export type AuthorizeVerdict =
  | { readonly type: "allowed" }
  | { readonly type: "rejected"; readonly error: RpcErrorPayload }
  | { readonly type: "cancelled" };

const ALLOWED: AuthorizeVerdict = { type: "allowed" };
const CANCELLED: AuthorizeVerdict = { type: "cancelled" };

const forbiddenError: LibraryErrorPayload = Object.freeze({
  code: "FORBIDDEN",
  message: "Bridge operation is forbidden.",
});

/** `authorize`·delivery factory가 받는 `BridgeContext`를 조립한다. */
export function bridgeContext(
  session: DocumentSession,
  sender: SenderIdentity,
  ids: { readonly requestId: string; readonly clientId: string },
  signal: AbortSignal,
): BridgeContext {
  return {
    requestId: ids.requestId,
    clientId: ids.clientId,
    windowRole: session.target.role,
    sender,
    signal,
  };
}

function settle(
  context: BridgeContext,
  diagnostics: DiagnosticsSink | undefined,
  operation: BridgeOperation,
  allowed: boolean,
): AuthorizeVerdict {
  if (context.signal.aborted) return CANCELLED;
  if (!allowed) {
    recordDiagnostic(diagnostics, {
      type: "rejected",
      reason: "authorize-denied",
      key: operation.key,
    });
    return { type: "rejected", error: forbiddenError };
  }
  return ALLOWED;
}

/**
 * authorize 판정 단계. `authorize`가 없으면 동기로, 있으면 settle을 기다린
 * 뒤 판정을 돌려준다(위 module doc의 동기 진행 불변식).
 */
export function authorizeOperation(
  authorize: Authorize | undefined,
  diagnostics: DiagnosticsSink | undefined,
  context: BridgeContext,
  operation: BridgeOperation,
): AuthorizeVerdict | Promise<AuthorizeVerdict> {
  if (authorize === undefined)
    return context.signal.aborted ? CANCELLED : ALLOWED;
  return (async (): Promise<AuthorizeVerdict> => {
    let allowed: boolean;
    try {
      allowed = await authorize(context, operation);
    } catch {
      // authorize 예외는 진단을 남기지 않는다(ADR 0011 결정 4).
      return context.signal.aborted
        ? CANCELLED
        : { type: "rejected", error: internalError };
    }
    return settle(context, diagnostics, operation, allowed);
  })();
}
