import { Observable } from "rxjs";

import type {
  BridgeContext,
  BroadcastEventSource,
  CurrentValueSource,
  EventSourceBuffer,
  ScopedEventSource,
} from "../contract/impl-types.js";
import type { BridgeValue } from "../protocol/index.js";

export type {
  BroadcastEventSource,
  CurrentValueSource,
  EventSource,
  EventSourceBuffer,
  OverflowPolicy,
  ScopedEventSource,
} from "../contract/impl-types.js";

export function currentValueSource<T extends BridgeValue>(
  source: CurrentValueSource<T>,
): CurrentValueSource<T> {
  if (
    !(source instanceof Observable) ||
    typeof source.getValue !== "function"
  ) {
    throw new TypeError(
      "State source must have a synchronous getValue() and Observable subscription.",
    );
  }
  return Object.assign(
    new Observable<T>((subscriber) => {
      const current = source.getValue();
      subscriber.next(current);
      let first = true;
      return source.subscribe({
        next(value) {
          if (first && Object.is(value, current)) {
            first = false;
            return;
          }
          first = false;
          subscriber.next(value);
        },
        error: (error: unknown) => subscriber.error(error),
        complete: () => subscriber.complete(),
      });
    }),
    { getValue: () => source.getValue() },
  );
}

/** `capacity`가 양의 안전 정수인지 source 생성 시점에 검증한다. */
function assertEventBuffer(
  buffer: EventSourceBuffer | undefined,
): EventSourceBuffer | undefined {
  if (buffer === undefined) return undefined;
  if (!Number.isSafeInteger(buffer.capacity) || buffer.capacity < 1) {
    throw new TypeError(
      "Event buffer capacity must be a positive safe integer.",
    );
  }
  return Object.freeze({ ...buffer });
}

export function broadcastEvent<T extends BridgeValue>(
  source: Observable<T>,
  options: { readonly buffer?: EventSourceBuffer } = {},
): BroadcastEventSource<T> {
  if (!(source instanceof Observable))
    throw new TypeError("Event source must be an Observable.");
  const buffer = assertEventBuffer(options.buffer);
  return Object.freeze({
    mode: "broadcast" as const,
    source,
    ...(buffer === undefined ? {} : { buffer }),
  });
}

export function scopedEvent<T extends BridgeValue>(
  factory: (context: BridgeContext) => Observable<T>,
  options: { readonly buffer?: EventSourceBuffer } = {},
): ScopedEventSource<T> {
  if (typeof factory !== "function")
    throw new TypeError("Scoped Event source must be a factory.");
  const buffer = assertEventBuffer(options.buffer);
  return Object.freeze({
    mode: "scoped" as const,
    factory,
    ...(buffer === undefined ? {} : { buffer }),
  });
}
