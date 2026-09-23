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

function assertDataProperties(
  value: object,
  allowArrayLength: boolean,
  maxStringBytes: number,
): readonly string[] {
  const keys = Reflect.ownKeys(value);
  const stringKeys: string[] = [];

  for (const key of keys) {
    if (typeof key !== "string") {
      invalidArgument("Bridge values cannot contain symbol keys.");
    }
    if (allowArrayLength && key === "length") {
      continue;
    }
    if (textEncoder.encode(key).byteLength > maxStringBytes) {
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
    stringKeys.push(key);
  }

  return stringKeys;
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

  const ancestors = new WeakSet<object>();
  const pending: TraversalFrame[] = [{ kind: "enter", depth: 0, value }];
  let entries = 0;

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

    switch (typeof frame.value) {
      case "undefined":
      case "boolean":
      case "number":
      case "bigint":
        continue;
      case "string":
        if (
          textEncoder.encode(frame.value).byteLength > limits.maxStringBytes
        ) {
          invalidArgument(
            "Bridge string exceeds the configured maximum byte length.",
          );
        }
        continue;
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

    const keys = assertDataProperties(
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
