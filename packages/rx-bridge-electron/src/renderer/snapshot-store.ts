import type { Subscription } from "rxjs";

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
 * `state`를 `RemoteStateStore<T>`로 감싼다. 네 가지를 지킨다.
 * - listener들은 `state` 구독 하나를 공유한다. 구독이 없거나 끝난 상태에서
 *   listener가 들어오면 새로 구독하고, 마지막 listener가 나가면 해제한다.
 *   그래서 새 listener가 연 generation의 변경도 기존 listener 전원에게 알린다.
 * - `error`는 알림으로만 쓰고 삼킨다: onChange를 호출할 뿐 예외를 다시 던지지
 *   않는다. 원인이 필요하면 `state`를 직접 구독한다.
 * - 원격 `complete`·`error` 뒤에는 스스로 재구독하지 않는다. 새 listener가
 *   들어올 때까지 snapshot은 `stale`(또는 `uninitialized`)에서 멈춘다.
 * - 같은 `state` 객체로 다시 부르면 같은 store(같은 `subscribe`·`getSnapshot`
 *   참조)를 돌려준다. `WeakMap` 캐시가 이를 보장한다.
 */
export function snapshotStore<T>(state: RemoteState<T>): RemoteStateStore<T> {
  const cached = cache.get(state as RemoteState<unknown>);
  if (cached !== undefined) {
    return cached as RemoteStateStore<T>;
  }

  // 같은 onChange가 두 번 구독해도 해제가 서로를 지우지 않도록 구독마다 새
  // 항목을 넣는다.
  const listeners = new Set<{ readonly onChange: () => void }>();
  let upstream: Subscription | undefined;
  // `state.subscribe`가 반환되기 전(동기 알림 중)에도 열린 상태를 알아야
  // 중첩 구독이 state를 다시 구독하지 않는다. `upstream.closed`로는 알 수 없다.
  let open = false;
  const notify = (): void => {
    // 알림 중 새로 들어온 listener는 이번 알림에서 빼고, 해제된 listener는
    // 부르지 않는다.
    for (const listener of [...listeners]) {
      if (listeners.has(listener)) {
        listener.onChange();
      }
    }
  };
  const finish = (): void => {
    open = false;
    notify();
  };

  const store: RemoteStateStore<T> = Object.freeze({
    subscribe: (onChange: () => void): (() => void) => {
      const listener = { onChange };
      listeners.add(listener);
      if (!open) {
        open = true;
        upstream = state.subscribe({
          next: notify,
          error: finish,
          complete: finish,
        });
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) {
          return;
        }
        open = false;
        upstream?.unsubscribe();
        upstream = undefined;
      };
    },
    getSnapshot: () => state.snapshot,
  });

  cache.set(state as RemoteState<unknown>, store as RemoteStateStore<unknown>);
  return store;
}
