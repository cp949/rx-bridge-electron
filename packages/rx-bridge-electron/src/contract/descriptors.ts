import type { Schema } from "./schema.js";
import type { BridgeValue } from "../protocol/index.js";

declare const descriptorBrand: unique symbol;

interface DescriptorBrand {
  readonly [descriptorBrand]: true;
}

export interface RpcDescriptor<
  I extends BridgeValue,
  O extends BridgeValue,
  E extends string = string,
> extends DescriptorBrand {
  readonly kind: "rpc";
  readonly input: Schema<I>;
  readonly output: Schema<O>;
  readonly errors: readonly E[];
}

export interface StateDescriptor<
  T extends BridgeValue,
> extends DescriptorBrand {
  readonly kind: "state";
  readonly output: Schema<T>;
  readonly delivery: "latest";
}

export type OverflowPolicy = "error" | "drop-oldest" | "drop-newest";

export interface EventDescriptor<
  T extends BridgeValue,
> extends DescriptorBrand {
  readonly kind: "event";
  readonly output: Schema<T>;
  readonly buffer: {
    readonly capacity: number;
    readonly overflow: OverflowPolicy;
  };
}

export function rpc<
  I extends BridgeValue,
  O extends BridgeValue,
  E extends string,
>(options: {
  readonly input: Schema<I>;
  readonly output: Schema<O>;
  readonly errors?: readonly E[];
}): RpcDescriptor<I, O, E> {
  return Object.freeze({
    kind: "rpc" as const,
    input: options.input,
    output: options.output,
    errors: Object.freeze([...(options.errors ?? [])]),
  }) as RpcDescriptor<I, O, E>;
}

export function state<T extends BridgeValue>(
  output: Schema<T>,
  options: { readonly delivery?: "latest" } = {},
): StateDescriptor<T> {
  return Object.freeze({
    kind: "state" as const,
    output,
    delivery: options.delivery ?? "latest",
  }) as StateDescriptor<T>;
}

export function event<T extends BridgeValue>(
  output: Schema<T>,
  options: {
    readonly buffer?: {
      readonly capacity: number;
      readonly overflow: OverflowPolicy;
    };
  } = {},
): EventDescriptor<T> {
  const buffer = options.buffer ?? {
    capacity: 100,
    overflow: "error" as const,
  };
  if (!Number.isSafeInteger(buffer.capacity) || buffer.capacity < 1) {
    throw new TypeError(
      "Event buffer capacity must be a positive safe integer.",
    );
  }
  return Object.freeze({
    kind: "event" as const,
    output,
    buffer: Object.freeze({ ...buffer }),
  }) as EventDescriptor<T>;
}

export type AnyDescriptor =
  | RpcDescriptor<BridgeValue, BridgeValue, string>
  | StateDescriptor<BridgeValue>
  | EventDescriptor<BridgeValue>;
