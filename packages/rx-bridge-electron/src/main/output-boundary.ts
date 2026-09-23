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
 */
export function parseOutput(
  schema: Schema<BridgeValue>,
  raw: unknown,
  limits: PayloadLimits,
): BridgeValue {
  let value = schema.parse(parseBridgeValue(raw, limits));
  parseBridgeValue(value, limits);
  value = parseBridgeValue(structuredClone(value), limits);
  return value;
}
