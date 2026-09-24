import type { RpcResponse } from "../protocol/index.js";

/**
 * 파싱조차 실패한 `value`에서 `clientId`·`requestId`를 최대한 복구해 에러
 * 응답을 만든다. server와 adapter fallback이 함께 쓴다. `electron-adapter.ts`가
 * preload 번들에 들어가므로 이 파일은 타입 전용 import 외에는 런타임 import를
 * 두지 않는다(server·`rxjs`가 preload로 끌려오면 안 된다, TRP-002).
 */
export function protocolError(
  value: unknown,
  code: string,
  message: string,
): RpcResponse {
  const record = value !== null && typeof value === "object" ? value : {};
  const clientValue = (record as Record<string, unknown>).clientId;
  const requestValue = (record as Record<string, unknown>).requestId;
  const clientId =
    typeof clientValue === "string" ? clientValue : "invalid-client";
  const requestId =
    typeof requestValue === "string" ? requestValue : "invalid-request";
  return {
    protocolVersion: 1,
    clientId,
    requestId,
    type: "error",
    error: { code, message },
  };
}

/** envelope parse·admission 거부 공통 응답(`INVALID_ARGUMENT "Invalid bridge request."`). */
export function invalidRequest(value: unknown): RpcResponse {
  return protocolError(value, "INVALID_ARGUMENT", "Invalid bridge request.");
}
