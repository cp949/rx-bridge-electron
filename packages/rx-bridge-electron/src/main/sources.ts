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

/**
 * event source 동결 객체를 만드는 순수 생성자. 모양·buffer 검증은
 * registration(`buildRegistrationTableFromImpl`)이 등록 시점에 한다 — 직접
 * 작성한 source 리터럴도 같은 검증을 받으므로 여기서는 검증하지 않는다.
 */
export function broadcastEvent<T extends BridgeValue>(
  source: Observable<T>,
  options: { readonly buffer?: EventSourceBuffer } = {},
): BroadcastEventSource<T> {
  const buffer =
    options.buffer === undefined
      ? undefined
      : Object.freeze({ ...options.buffer });
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
  const buffer =
    options.buffer === undefined
      ? undefined
      : Object.freeze({ ...options.buffer });
  return Object.freeze({
    mode: "scoped" as const,
    factory,
    ...(buffer === undefined ? {} : { buffer }),
  });
}
