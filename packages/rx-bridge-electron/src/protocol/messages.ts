import {
  BridgeProtocolError,
  type BridgeValue,
  type PayloadLimits,
  parseBridgeValue,
} from "./bridge-value.js";

export type TransportErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CANCELLED"
  | "DEADLINE_EXCEEDED"
  | "RESOURCE_EXHAUSTED"
  | "VERSION_MISMATCH"
  | "INTERNAL";

export interface ProtocolEnvelope {
  readonly protocolVersion: 1;
  readonly clientId: string;
}

export type HandshakeRequest = ProtocolEnvelope;
export type HandshakeManifest = {
  readonly rpc: readonly string[];
  readonly state: readonly string[];
  readonly event: readonly string[];
};
export type HandshakeResponse = ProtocolEnvelope & {
  readonly manifest: HandshakeManifest;
};

export interface RendererRpcRequest {
  readonly requestId: string;
  readonly key: string;
  readonly input: BridgeValue;
}

export type WireRpcRequest = ProtocolEnvelope & RendererRpcRequest;

export type RpcErrorPayload = {
  readonly code: string;
  readonly message: string;
  readonly details?: BridgeValue;
};

export type RpcResponse = ProtocolEnvelope &
  (
    | {
        readonly type: "success";
        readonly requestId: string;
        readonly result: BridgeValue;
      }
    | {
        readonly type: "error";
        readonly requestId: string;
        readonly error: RpcErrorPayload;
      }
  );

export type WireCancelRequest = ProtocolEnvelope & {
  readonly requestId: string;
};

export type RendererStreamCommand =
  | {
      readonly type: "subscribe";
      readonly subscriptionId: string;
      readonly key: string;
    }
  | { readonly type: "unsubscribe"; readonly subscriptionId: string }
  | {
      readonly type: "acknowledge";
      readonly subscriptionId: string;
      readonly sequence: number;
    };

export type WireStreamCommand = ProtocolEnvelope & RendererStreamCommand;

export type StreamMessage = ProtocolEnvelope &
  (
    | {
        readonly type: "subscribed";
        readonly subscriptionId: string;
        readonly sequence: number;
      }
    | {
        readonly type: "batch";
        readonly subscriptionId: string;
        readonly sequence: number;
        readonly values: readonly BridgeValue[];
      }
    | {
        readonly type: "error";
        readonly subscriptionId: string;
        readonly sequence: number;
        readonly error: RpcErrorPayload;
      }
    | {
        readonly type: "complete";
        readonly subscriptionId: string;
        readonly sequence: number;
      }
  );

type RecordValue = Record<string, BridgeValue>;

function invalidArgument(message: string): never {
  throw new BridgeProtocolError("INVALID_ARGUMENT", message);
}

function parseRecord(value: unknown, limits: PayloadLimits): RecordValue {
  const parsed = parseBridgeValue(value, limits);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    invalidArgument("Protocol message must be a plain object.");
  }
  return parsed as RecordValue;
}

function assertKeys(
  record: RecordValue,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  if (keys.length < required.length || keys.some((key) => !allowed.has(key))) {
    invalidArgument("Protocol message contains missing or unknown fields.");
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      invalidArgument("Protocol message contains missing fields.");
    }
  }
}

function readId(record: RecordValue, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    invalidArgument(`${key} must be a non-empty string.`);
  }
  return value;
}

function readSequence(record: RecordValue): number {
  const value = record.sequence;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalidArgument("sequence must be a non-negative safe integer.");
  }
  return value;
}

function readEnvelope(record: RecordValue): ProtocolEnvelope {
  const protocolVersion = record.protocolVersion;
  if (protocolVersion !== 1) {
    if (typeof protocolVersion === "number") {
      throw new BridgeProtocolError(
        "VERSION_MISMATCH",
        "Unsupported protocol version.",
      );
    }
    invalidArgument("protocolVersion must be 1.");
  }
  return { protocolVersion, clientId: readId(record, "clientId") };
}

function readErrorPayload(
  value: BridgeValue,
  limits: PayloadLimits,
): RpcErrorPayload {
  const record = parseRecord(value, limits);
  assertKeys(record, ["code", "message"], ["details"]);
  const error: RpcErrorPayload = {
    code: readId(record, "code"),
    message: readId(record, "message"),
  };
  if (Object.hasOwn(record, "details")) {
    return { ...error, details: parseBridgeValue(record.details, limits) };
  }
  return error;
}

export function parseHandshakeRequest(
  value: unknown,
  limits: PayloadLimits,
): HandshakeRequest {
  const record = parseRecord(value, limits);
  assertKeys(record, ["protocolVersion", "clientId"]);
  return readEnvelope(record);
}

export function parseHandshakeResponse(
  value: unknown,
  limits: PayloadLimits,
): HandshakeResponse {
  const record = parseRecord(value, limits);
  assertKeys(record, ["protocolVersion", "clientId", "manifest"]);
  const manifest = parseRecord(record.manifest, limits);
  assertKeys(manifest, ["rpc", "state", "event"]);
  const categories = ["rpc", "state", "event"] as const;
  for (const category of categories) {
    const values = manifest[category];
    if (
      !Array.isArray(values) ||
      values.some((entry) => typeof entry !== "string")
    ) {
      invalidArgument("Handshake manifest categories must contain strings.");
    }
  }
  return {
    ...readEnvelope(record),
    manifest: {
      rpc: manifest.rpc as readonly string[],
      state: manifest.state as readonly string[],
      event: manifest.event as readonly string[],
    },
  };
}

export function parseRendererRpcRequest(
  value: unknown,
  limits: PayloadLimits,
): RendererRpcRequest {
  const record = parseRecord(value, limits);
  assertKeys(record, ["requestId", "key", "input"]);
  return {
    requestId: readId(record, "requestId"),
    key: readId(record, "key"),
    input: parseBridgeValue(record.input, limits),
  };
}

export function parseWireRpcRequest(
  value: unknown,
  limits: PayloadLimits,
): WireRpcRequest {
  const record = parseRecord(value, limits);
  assertKeys(record, [
    "protocolVersion",
    "clientId",
    "requestId",
    "key",
    "input",
  ]);
  return {
    ...readEnvelope(record),
    ...parseRendererRpcRequest(
      { requestId: record.requestId, key: record.key, input: record.input },
      limits,
    ),
  };
}

export function parseRpcResponse(
  value: unknown,
  limits: PayloadLimits,
): RpcResponse {
  const record = parseRecord(value, limits);
  const envelope = readEnvelope(record);
  const type = record.type;
  if (type === "success") {
    assertKeys(record, [
      "protocolVersion",
      "clientId",
      "type",
      "requestId",
      "result",
    ]);
    return {
      ...envelope,
      type,
      requestId: readId(record, "requestId"),
      result: parseBridgeValue(record.result, limits),
    };
  }
  if (type === "error") {
    assertKeys(record, [
      "protocolVersion",
      "clientId",
      "type",
      "requestId",
      "error",
    ]);
    return {
      ...envelope,
      type,
      requestId: readId(record, "requestId"),
      error: readErrorPayload(record.error, limits),
    };
  }
  invalidArgument("Unknown RPC response type.");
}

export function parseWireCancelRequest(
  value: unknown,
  limits: PayloadLimits,
): WireCancelRequest {
  const record = parseRecord(value, limits);
  assertKeys(record, ["protocolVersion", "clientId", "requestId"]);
  return { ...readEnvelope(record), requestId: readId(record, "requestId") };
}

export function parseRendererStreamCommand(
  value: unknown,
  limits: PayloadLimits,
): RendererStreamCommand {
  const record = parseRecord(value, limits);
  const type = record.type;
  if (type === "subscribe") {
    assertKeys(record, ["type", "subscriptionId", "key"]);
    return {
      type,
      subscriptionId: readId(record, "subscriptionId"),
      key: readId(record, "key"),
    };
  }
  if (type === "unsubscribe") {
    assertKeys(record, ["type", "subscriptionId"]);
    return { type, subscriptionId: readId(record, "subscriptionId") };
  }
  if (type === "acknowledge") {
    assertKeys(record, ["type", "subscriptionId", "sequence"]);
    return {
      type,
      subscriptionId: readId(record, "subscriptionId"),
      sequence: readSequence(record),
    };
  }
  invalidArgument("Unknown stream command type.");
}

export function parseWireStreamCommand(
  value: unknown,
  limits: PayloadLimits,
): WireStreamCommand {
  const record = parseRecord(value, limits);
  const envelope = readEnvelope(record);
  const command = parseRendererStreamCommand(
    Object.fromEntries(
      Object.entries(record).filter(
        ([key]) => key !== "protocolVersion" && key !== "clientId",
      ),
    ),
    limits,
  );
  assertKeys(
    record,
    ["protocolVersion", "clientId", "type", "subscriptionId"],
    command.type === "subscribe"
      ? ["key"]
      : command.type === "acknowledge"
        ? ["sequence"]
        : [],
  );
  return { ...envelope, ...command };
}

export function parseStreamMessage(
  value: unknown,
  limits: PayloadLimits,
): StreamMessage {
  const record = parseRecord(value, limits);
  const envelope = readEnvelope(record);
  const type = record.type;
  if (type === "subscribed" || type === "complete") {
    assertKeys(record, [
      "protocolVersion",
      "clientId",
      "type",
      "subscriptionId",
      "sequence",
    ]);
    return {
      ...envelope,
      type,
      subscriptionId: readId(record, "subscriptionId"),
      sequence: readSequence(record),
    };
  }
  if (type === "batch") {
    assertKeys(record, [
      "protocolVersion",
      "clientId",
      "type",
      "subscriptionId",
      "sequence",
      "values",
    ]);
    if (!Array.isArray(record.values)) {
      invalidArgument("Stream batch values must be an array.");
    }
    return {
      ...envelope,
      type,
      subscriptionId: readId(record, "subscriptionId"),
      sequence: readSequence(record),
      values: record.values,
    };
  }
  if (type === "error") {
    assertKeys(record, [
      "protocolVersion",
      "clientId",
      "type",
      "subscriptionId",
      "sequence",
      "error",
    ]);
    return {
      ...envelope,
      type,
      subscriptionId: readId(record, "subscriptionId"),
      sequence: readSequence(record),
      error: readErrorPayload(record.error, limits),
    };
  }
  invalidArgument("Unknown stream message type.");
}
