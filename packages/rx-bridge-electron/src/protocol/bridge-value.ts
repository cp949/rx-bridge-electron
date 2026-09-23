/** Values permitted to cross the v1 bridge boundary. */
export type BridgeValue =
  | undefined
  | null
  | boolean
  | number
  | string
  | bigint
  | readonly BridgeValue[]
  | { readonly [key: string]: BridgeValue };

export interface PayloadLimits {
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxStringBytes: number;
  readonly maxTotalBytes?: number;
}

/** Error safe to return across the bridge for malformed protocol input. */
export class BridgeProtocolError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeProtocolError";
    this.code = code;
  }
}

interface EnterFrame {
  readonly kind: "enter";
  readonly depth: number;
  readonly value: unknown;
}

interface ExitFrame {
  readonly kind: "exit";
  readonly value: object;
}

type TraversalFrame = EnterFrame | ExitFrame;

const textEncoder = new TextEncoder();

function invalidArgument(message: string): never {
  throw new BridgeProtocolError("INVALID_ARGUMENT", message);
}

function assertLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalidArgument(`${name} must be a non-negative safe integer.`);
  }
}

interface DataProperties {
  readonly keys: readonly string[];
  readonly keyBytesTotal: number;
}

function assertDataProperties(
  value: object,
  allowArrayLength: boolean,
  maxStringBytes: number,
): DataProperties {
  const keys = Reflect.ownKeys(value);
  const stringKeys: string[] = [];
  let keyBytesTotal = 0;

  for (const key of keys) {
    if (typeof key !== "string") {
      invalidArgument("Bridge values cannot contain symbol keys.");
    }
    if (allowArrayLength && key === "length") {
      continue;
    }
    const keyBytes = textEncoder.encode(key).byteLength;
    if (keyBytes > maxStringBytes) {
      invalidArgument(
        "Bridge object key exceeds the configured maximum byte length.",
      );
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      invalidArgument(
        "Bridge objects must contain enumerable data properties only.",
      );
    }
    keyBytesTotal += keyBytes;
    stringKeys.push(key);
  }

  return { keys: stringKeys, keyBytesTotal };
}

/**
 * Validates the narrow, clone-safe v1 payload profile without serializing or
 * mutating the supplied value.
 */
export function parseBridgeValue(
  value: unknown,
  limits: PayloadLimits,
): BridgeValue {
  assertLimit("maxDepth", limits.maxDepth);
  assertLimit("maxEntries", limits.maxEntries);
  assertLimit("maxStringBytes", limits.maxStringBytes);
  const maxTotalBytes = limits.maxTotalBytes;
  if (maxTotalBytes !== undefined) {
    assertLimit("maxTotalBytes", maxTotalBytes);
  }

  const ancestors = new WeakSet<object>();
  const pending: TraversalFrame[] = [{ kind: "enter", depth: 0, value }];
  let entries = 0;
  let totalBytes = 0;

  function addBytes(delta: number): void {
    if (maxTotalBytes === undefined) {
      return;
    }
    totalBytes += delta;
    if (totalBytes > maxTotalBytes) {
      invalidArgument(
        "Bridge value exceeds the configured maximum total byte size.",
      );
    }
  }

  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) {
      continue;
    }
    if (frame.kind === "exit") {
      ancestors.delete(frame.value);
      continue;
    }
    if (frame.depth > limits.maxDepth) {
      invalidArgument("Bridge value exceeds the configured maximum depth.");
    }

    addBytes(8);

    switch (typeof frame.value) {
      case "undefined":
      case "boolean":
      case "number":
        continue;
      case "bigint": {
        const magnitude = frame.value < 0n ? -frame.value : frame.value;
        addBytes(Math.ceil(magnitude.toString(16).length / 2));
        continue;
      }
      case "string": {
        const byteLength = textEncoder.encode(frame.value).byteLength;
        if (byteLength > limits.maxStringBytes) {
          invalidArgument(
            "Bridge string exceeds the configured maximum byte length.",
          );
        }
        addBytes(byteLength);
        continue;
      }
      case "function":
      case "symbol":
        invalidArgument("Bridge value contains an unsupported value type.");
        break;
      case "object":
        break;
      default:
        invalidArgument("Bridge value contains an unsupported value type.");
    }

    if (frame.value === null) {
      continue;
    }

    const objectValue = frame.value;
    if (ancestors.has(objectValue)) {
      invalidArgument("Bridge value contains a cycle.");
    }
    ancestors.add(objectValue);

    const isArray = Array.isArray(objectValue);
    const prototype = Object.getPrototypeOf(objectValue);
    if (
      (isArray && prototype !== Array.prototype) ||
      (!isArray && prototype !== Object.prototype && prototype !== null)
    ) {
      invalidArgument(
        "Bridge value contains an object with an unsupported prototype.",
      );
    }

    const { keys, keyBytesTotal } = assertDataProperties(
      objectValue,
      isArray,
      limits.maxStringBytes,
    );
    entries += keys.length;
    if (entries > limits.maxEntries) {
      invalidArgument(
        "Bridge value exceeds the configured maximum entry count.",
      );
    }
    addBytes(keyBytesTotal);

    pending.push({ kind: "exit", value: objectValue });
    for (const key of keys) {
      pending.push({
        kind: "enter",
        depth: frame.depth + 1,
        value: objectValue[key as keyof typeof objectValue],
      });
    }
  }

  return value as BridgeValue;
}
