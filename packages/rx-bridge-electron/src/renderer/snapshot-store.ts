import type { RemoteState, RemoteStateSnapshot } from "../contract/index.js";

/**
 * `RemoteState<T>`를 외부 store 계약(React `useSyncExternalStore` 등이 기대하는
 * `subscribe(onChange) → unsubscribe` + `getSnapshot()`)으로 옮긴 값이다.
 */
export interface RemoteStateStore<T> {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => RemoteStateSnapshot<T>;
}

const cache = new WeakMap<RemoteState<unknown>, RemoteStateStore<unknown>>();

/**
 * `state`를 `RemoteStateStore<T>`로 감싼다. 세 가지를 지킨다.
 * - `error`는 알림으로만 쓰고 삼킨다: onChange를 호출할 뿐 예외를 다시 던지지
 *   않는다. 원인이 필요하면 `state`를 직접 구독한다.
 * - 원격 `complete`·`error` 뒤에는 재구독하지 않는다. snapshot은 `stale`(또는
 *   `uninitialized`)에서 멈춘다.
 * - 같은 `state` 객체로 다시 부르면 같은 store(같은 `subscribe`·`getSnapshot`
 *   참조)를 돌려준다. `WeakMap` 캐시가 이를 보장한다.
 */
export function snapshotStore<T>(state: RemoteState<T>): RemoteStateStore<T> {
  const cached = cache.get(state as RemoteState<unknown>);
  if (cached !== undefined) {
    return cached as RemoteStateStore<T>;
  }

  const store: RemoteStateStore<T> = Object.freeze({
    subscribe: (onChange: () => void): (() => void) => {
      const subscription = state.subscribe({
        next: () => onChange(),
        error: () => onChange(),
        complete: () => onChange(),
      });
      return () => subscription.unsubscribe();
    },
    getSnapshot: () => state.snapshot,
  });

  cache.set(
    state as RemoteState<unknown>,
    store as RemoteStateStore<unknown>,
  );
  return store;
}
