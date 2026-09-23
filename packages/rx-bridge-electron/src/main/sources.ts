import { Observable } from "rxjs";

import type { BridgeValue } from "../protocol/index.js";
import type { BridgeContext } from "./types.js";

export interface CurrentValueSource<T> extends Observable<T> {
  getValue(): T;
}

export interface BroadcastEventSource<T> {
  readonly mode: "broadcast";
  readonly source: Observable<T>;
}

export interface ScopedEventSource<T> {
  readonly mode: "scoped";
  readonly factory: (context: BridgeContext) => Observable<T>;
}

export type EventSource<T extends BridgeValue = BridgeValue> =
  Observable<T> | BroadcastEventSource<T> | ScopedEventSource<T>;

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

export function broadcastEvent<T extends BridgeValue>(
  source: Observable<T>,
): BroadcastEventSource<T> {
  if (!(source instanceof Observable))
    throw new TypeError("Event source must be an Observable.");
  return Object.freeze({ mode: "broadcast" as const, source });
}

export function scopedEvent<T extends BridgeValue>(
  factory: (context: BridgeContext) => Observable<T>,
): ScopedEventSource<T> {
  if (typeof factory !== "function")
    throw new TypeError("Scoped Event source must be a factory.");
  return Object.freeze({ mode: "scoped" as const, factory });
}
