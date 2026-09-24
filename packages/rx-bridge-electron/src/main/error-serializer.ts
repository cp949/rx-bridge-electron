import {
  parseBridgeValue,
  type PayloadLimits,
  type RpcErrorPayload,
} from "../protocol/index.js";

/** Main의 `INTERNAL` 응답 payload 단일 정의(ADR 0011). */
export const internalError: RpcErrorPayload = Object.freeze({
  code: "INTERNAL",
  message: "Internal bridge error.",
});

export function serializeError(
  error: unknown,
  declared: readonly string[],
  limits: PayloadLimits,
): RpcErrorPayload {
  if (error === null || typeof error !== "object") return internalError;
  try {
    // Read each field once so accessors cannot change the value after checks.
    const { code, message, details } = error as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
    };
    if (
      typeof code !== "string" ||
      !declared.includes(code) ||
      typeof message !== "string"
    )
      return internalError;
    parseBridgeValue(message, limits);
    return details === undefined
      ? { code, message }
      : {
          code,
          message,
          details: parseBridgeValue(
            structuredClone(parseBridgeValue(details, limits)),
            limits,
          ),
        };
  } catch {
    return internalError;
  }
}
