import type { ComposedContract, RpcDescriptor } from "../contract/index.js";
import {
  BridgeProtocolError,
  parseBridgeValue,
  type BridgeValue,
  type PayloadLimits,
  type RpcResponse,
  type WireRpcRequest,
} from "../protocol/index.js";
import { serializeError } from "./error-serializer.js";
import { parseOutput } from "./output-boundary.js";
import type {
  BridgeContext,
  DiagnosticsSink,
  DomainImplementation,
} from "./types.js";

export interface RpcRegistration {
  readonly descriptor: RpcDescriptor<BridgeValue, BridgeValue, string>;
  readonly handler: DomainImplementation["rpc"][string];
}
export function findRpc(
  contract: ComposedContract,
  implementations: readonly DomainImplementation[],
  key: string,
): RpcRegistration | undefined {
  if (!key.startsWith("rpc:")) return undefined;
  const path = key.slice(4);
  const split = path.lastIndexOf("/");
  if (split < 1) return undefined;
  const domain = contract.domains[path.slice(0, split)];
  const operation = path.slice(split + 1);
  const descriptor = domain?.definitions.rpc?.[operation];
  const implementation = implementations.find(
    (item) => item.domainName === domain?.name,
  )?.rpc[operation];
  return descriptor === undefined || implementation === undefined
    ? undefined
    : { descriptor, handler: implementation };
}
export async function dispatchRegistered(
  registration: RpcRegistration,
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
  let input: BridgeValue;
  try {
    input = registration.descriptor.input.parse(
      parseBridgeValue(envelope.input, limits),
    );
  } catch {
    if (context.signal.aborted)
      return respond({
        type: "error",
        error: { code: "CANCELLED", message: "Request cancelled." },
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
      error: serializeError(error, registration.descriptor.errors, limits),
    });
  }
  if (context.signal.aborted)
    return respond({
      type: "error",
      error: { code: "CANCELLED", message: "Request cancelled." },
    });
  let output: BridgeValue;
  try {
    output = parseOutput(registration.descriptor.output, result, limits);
  } catch {
    diagnostics?.record({ type: "validation-failed", key: envelope.key });
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
