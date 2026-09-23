import type { Schema } from "../contract/index.js";
import {
  parseBridgeValue,
  type BridgeValue,
  type PayloadLimits,
} from "../protocol/index.js";

/**
 * Re-validates a handler/schema-produced output against the wire boundary.
 * Shared by the RPC dispatcher and the stream hub so both paths reject the
 * same non-`BridgeValue` shapes, oversized payloads, and TOCTOU mutation via
 * the same clone-then-reparse sequence. Throws on any failure; callers
 * translate the exception into a protocol error.
 *
 * `schema`는 선택이다(경량 계약: operation 단위 부분 도입). 스키마가 없으면
 * `parseBridgeValue`가 만든 값을 그대로 쓰되, 구조·크기 검사와
 * clone-then-reparse는 스키마 유무와 무관하게 항상 수행한다.
 */
export function parseOutput(
  schema: Schema<BridgeValue> | undefined,
  raw: unknown,
  limits: PayloadLimits,
): BridgeValue {
  const parsedRaw = parseBridgeValue(raw, limits);
  let value = schema === undefined ? parsedRaw : schema.parse(parsedRaw);
  parseBridgeValue(value, limits);
  value = parseBridgeValue(structuredClone(value), limits);
  return value;
}
