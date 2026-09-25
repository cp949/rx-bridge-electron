import type { Subscription } from "rxjs";

import type { RemoteState, RemoteStateSnapshot } from "../contract/index.js";
import { onGenerationOpened } from "./local-generation.js";

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
 *   listener가 들어오면 새로 구독한다. listener가 있는 동안 새로 열린
 *   generation(남이 연 것 포함)에도 합류해 유지하고 알린다 — 스스로 새
 *   generation을 열지는 않는다(새 listener 진입 때는 예외). 마지막
 *   listener가 나가면 해제한다.
 * - `error`는 알림으로만 쓰고 삼킨다: onChange를 호출할 뿐 예외를 다시 던지지
 *   않는다. 원인이 필요하면 `state`를 직접 구독한다.
 * - 원격 `complete`·`error` 뒤에는 스스로 재구독하지 않는다. 새 listener가
 *   들어올 때까지 snapshot은 `stale`(또는 `uninitialized`)에서 멈춘다.
 * - 같은 `state` 객체로 다시 부르면 같은 store(같은 `subscribe`·`getSnapshot`
 *   참조)를 돌려준다. `WeakMap` 캐시가 이를 보장한다. `state`가 사용자
 *   fake(내부 신호를 못 받는 `RemoteState` 구현)이면 이 합류 없이
 *   RD-043 그대로 이벤트 기반으로 동작한다.
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
  let openedListenerHandle: (() => void) | undefined;
  let joins = 0;
  const notify = (): void => {
    // 알림 중 새로 들어온 listener는 이번 알림에서 빼고, 해제된 listener는
    // 부르지 않는다.
    for (const listener of [...listeners]) {
      if (listeners.has(listener)) {
        listener.onChange();
      }
    }
  };
  const join = (): void => {
    open = true;
    const joined = ++joins;
    const subscription = state.subscribe({
      next: notify,
      error: finish,
      complete: finish,
    });
    // transport가 값을 동기로 보내면 합류 중 replay 알림 안에서 마지막
    // listener가 떠나거나 다른 합류가 끼어들 수 있다. 그러면 이 구독은 주인이
    // 없으므로 바로 놓는다.
    if (joined !== joins || listeners.size === 0) {
      subscription.unsubscribe();
      return;
    }
    upstream = subscription;
  };
  const finish = (): void => {
    open = false;
    // 종료를 store보다 먼저 받은 구독자(`repeat`·`retry` 등)가 그 안에서
    // 동기로 새 generation을 열면, 그 신호는 store가 아직 `open === true`일
    // 때 와서 합류 없이 지나간다. 활성 generation이 있으면 여기서 합류한다.
    // 활성일 때만 합류하므로 새 generation을 열지 않는다.
    if (openedListenerHandle !== undefined && state.snapshot.active) {
      join();
    }
    notify();
  };
  // 남이(또는 store 자신이) 연 generation의 "열렸다" 신호. 합류 먼저, 알림은
  // 그다음이다 — 먼저 notify하면 listener가 동기로 generation을 닫을 수
  // 있고, 그 뒤의 합류는 자동 재구독이 되어 버린다.
  const handleOpened = (): void => {
    if (!open) {
      join();
    }
    notify();
  };

  const store: RemoteStateStore<T> = Object.freeze({
    subscribe: (onChange: () => void): (() => void) => {
      const listener = { onChange };
      const isFirstListener = listeners.size === 0;
      listeners.add(listener);
      // `state.subscribe` 호출(아래)보다 먼저 등록해야 store 자신이 여는
      // generation의 신호도 받는다(listener가 자기 구독의 connecting 알림을
      // 받는다).
      if (isFirstListener) {
        openedListenerHandle = onGenerationOpened(state, handleOpened);
      }
      if (!open) {
        join();
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) {
          return;
        }
        open = false;
        upstream?.unsubscribe();
        upstream = undefined;
        openedListenerHandle?.();
        openedListenerHandle = undefined;
      };
    },
    getSnapshot: () => state.snapshot,
  });

  cache.set(state as RemoteState<unknown>, store as RemoteStateStore<unknown>);
  return store;
}
