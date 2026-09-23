import {
  parseBridgeValue,
  type PayloadLimits,
  type RpcErrorPayload,
} from "../protocol/index.js";

export function serializeError(
  error: unknown,
  declared: readonly string[],
  limits: PayloadLimits,
): RpcErrorPayload {
  if (error !== null && typeof error === "object") {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
    };
    if (
      typeof candidate.code === "string" &&
      declared.includes(candidate.code) &&
      typeof candidate.message === "string"
    ) {
      try {
        return candidate.details === undefined
          ? { code: candidate.code, message: candidate.message }
          : {
              code: candidate.code,
              message: candidate.message,
              details: parseBridgeValue(candidate.details, limits),
            };
      } catch {
        return { code: "INTERNAL", message: "Internal bridge error." };
      }
    }
  }
  return { code: "INTERNAL", message: "Internal bridge error." };
}
