import {
  BridgeProtocolError,
  parseBridgeValue,
  type BridgeValue,
  type PayloadLimits,
  type RpcResponse,
  type WireRpcRequest,
} from "../protocol/index.js";
import { PayloadLimitError } from "../protocol/bridge-value.js";
import { recordDiagnostic } from "./diagnostics.js";
import { serializeError } from "./error-serializer.js";
import { parseOutput } from "./output-boundary.js";
import type { RegistrationTable, RpcRegistrationEntry } from "./registration.js";
import type { BridgeContext, DiagnosticsSink } from "./types.js";

export function findRpc(
  table: RegistrationTable,
  key: string,
): RpcRegistrationEntry | undefined {
  if (!key.startsWith("rpc:")) return undefined;
  return table.rpc.get(key.slice(4));
}
export async function dispatchRegistered(
  registration: RpcRegistrationEntry,
  envelope: WireRpcRequest,
  context: BridgeContext,
  limits: PayloadLimits,
  diagnostics?: DiagnosticsSink,
): Promise<RpcResponse> {
  const respond = (
    response:
      | { readonly type: "success"; readonly result: BridgeValue }
      | {
          readonly type: "error";
          readonly error: {
            readonly code: string;
            readonly message: string;
            readonly details?: BridgeValue;
          };
        },
  ): RpcResponse =>
    ({
      protocolVersion: 1,
      clientId: envelope.clientId,
      requestId: envelope.requestId,
      ...response,
    }) as RpcResponse;
  let parsed: BridgeValue;
  try {
    parsed = parseBridgeValue(envelope.input, limits);
  } catch (cause) {
    if (context.signal.aborted)
      return respond({
        type: "error",
        error: { code: "CANCELLED", message: "Request cancelled." },
      });
    recordDiagnostic(diagnostics, {
      type: "rejected",
      reason:
        cause instanceof PayloadLimitError
          ? "payload-too-large"
          : "invalid-input",
      key: envelope.key,
    });
    return respond({
      type: "error",
      error: {
        code: "INVALID_ARGUMENT",
        message: "Invalid bridge argument.",
      },
    });
  }
  let input: BridgeValue;
  try {
    input = registration.input === undefined ? parsed : registration.input.parse(parsed);
  } catch {
    if (context.signal.aborted)
      return respond({
        type: "error",
        error: { code: "CANCELLED", message: "Request cancelled." },
      });
    recordDiagnostic(diagnostics, {
      type: "rejected",
      reason: "invalid-input",
      key: envelope.key,
    });
    return respond({
      type: "error",
      error: {
        code: "INVALID_ARGUMENT",
        message: "Invalid bridge argument.",
      },
    });
  }
  let result: BridgeValue;
  try {
    result = await registration.handler(input, context);
  } catch (error) {
    if (context.signal.aborted)
      return respond({
        type: "error",
        error: { code: "CANCELLED", message: "Request cancelled." },
      });
    if (error instanceof BridgeProtocolError)
      return respond({
        type: "error",
        error: { code: "INTERNAL", message: "Internal bridge error." },
      });
    return respond({
      type: "error",
      error: serializeError(error, registration.errors, limits),
    });
  }
  if (context.signal.aborted)
    return respond({
      type: "error",
      error: { code: "CANCELLED", message: "Request cancelled." },
    });
  let output: BridgeValue;
  try {
    output = parseOutput(registration.output, result, limits);
  } catch {
    recordDiagnostic(diagnostics, {
      type: "validation-failed",
      key: envelope.key,
    });
    if (context.signal.aborted)
      return respond({
        type: "error",
        error: { code: "CANCELLED", message: "Request cancelled." },
      });
    return respond({
      type: "error",
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
  }
  return respond({ type: "success", result: output });
}
