/**
 * `snapshotStore`가 `RemoteState`를 외부 store 계약(`subscribe`/`getSnapshot`)으로
 * 옮기는 것을 검증하는 테스트. 캐시 동일성, snapshot 참조 안정성, 알림 타이밍,
 * 종료(complete/error) 뒤 처리, 구독 해제, listener 공유 구독(종료 뒤 재개·
 * 알림 중 해제·중첩 구독), dispose된 API·사용자 fake 입력을 함께 다룬다.
 * 추가로 generation 교체(G1·G2·G3) 뒤 listener 알림과 합류 재진입(N1~N8,
 * RD-044), 종료 알림 안 동기 재구독 합류와 동기 transport 합류 누수(N9~N11)를
 * 다룬다.
 */
import { BehaviorSubject, Observable, config, repeat } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import {
  createRendererApi,
  snapshotStore,
  type RemoteState,
  type RemoteStateSnapshot,
} from "../../src/renderer/index.js";
import { FakeTransport, streamMessage } from "./fake-transport.js";

interface StateBridge {
  readonly hardware: {
    readonly state: {
      readonly connection$: string | undefined;
      readonly battery$: number;
    };
  };
}

const CONNECTION_KEY = "state:hardware/connection$";
const BATTERY_KEY = "state:hardware/battery$";
const STATE_MANIFEST = { state: [CONNECTION_KEY, BATTERY_KEY] };

describe("snapshotStore", () => {
  test("같은 state에 두 번 호출하면 같은 store를 반환하고, 다른 state에는 다른 store를 반환하며 store는 frozen이다", async () => {
    const transport = new FakeTransport({ manifest: STATE_MANIFEST });
    const api = await createRendererApi<StateBridge>({ transport });
    const first = api.hardware.state.connection$;
    const second = api.hardware.state.battery$;

    const firstStore = snapshotStore(first);
    const sameStore = snapshotStore(first);
    const secondStore = snapshotStore(second);

    expect(sameStore).toBe(firstStore);
    expect(sameStore.subscribe).toBe(firstStore.subscribe);
    expect(sameStore.getSnapshot).toBe(firstStore.getSnapshot);
    expect(secondStore).not.toBe(firstStore);
    expect(Object.isFrozen(firstStore)).toBe(true);
  });

  test("getSnapshot()은 호출 시점의 state.snapshot과 같은 참조를 반환한다", async () => {
    const transport = new FakeTransport({ manifest: STATE_MANIFEST });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const store = snapshotStore(state);

    expect(store.getSnapshot()).toBe(state.snapshot);

    const subscription = state.subscribe(() => {});
    expect(store.getSnapshot()).toBe(state.snapshot);

    const subscriptionId = transport.subscriptionIdFor(CONNECTION_KEY);
    transport.emitStream(
      streamMessage(subscriptionId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(subscriptionId, {
        type: "batch",
        sequence: 1,
        values: ["a"],
      }),
    );
    expect(store.getSnapshot()).toBe(state.snapshot);

    subscription.unsubscribe();
  });

  test("generation을 열면 connecting 알림 1회를 받고, subscribed로는 불리지 않으며, 값 1개짜리 batch마다 onChange가 인자 없이 1회씩 불린다", async () => {
    const transport = new FakeTransport({ manifest: STATE_MANIFEST });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const store = snapshotStore(state);
    const onChange = vi.fn();

    store.subscribe(onChange);
    expect(onChange).toHaveBeenCalledTimes(1);

    const subscriptionId = transport.subscriptionIdFor(CONNECTION_KEY);
    transport.emitStream(
      streamMessage(subscriptionId, { type: "subscribed", sequence: 0 }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);

    transport.emitStream(
      streamMessage(subscriptionId, {
        type: "batch",
        sequence: 1,
        values: ["a"],
      }),
    );
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledWith();

    transport.emitStream(
      streamMessage(subscriptionId, {
        type: "batch",
        sequence: 2,
        values: ["b"],
      }),
    );
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenCalledWith();
  });

  test("원격 complete 뒤 onChange가 1회 더 불리고 snapshot은 stale이며 새 subscribe 명령을 보내지 않는다", async () => {
    const transport = new FakeTransport({ manifest: STATE_MANIFEST });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const store = snapshotStore(state);
    const onChange = vi.fn();
    store.subscribe(onChange);

    const subscriptionId = transport.subscriptionIdFor(CONNECTION_KEY);
    transport.emitStream(
      streamMessage(subscriptionId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(subscriptionId, {
        type: "batch",
        sequence: 1,
        values: ["a"],
      }),
    );
    expect(onChange).toHaveBeenCalledTimes(2);

    transport.emitStream(
      streamMessage(subscriptionId, { type: "complete", sequence: 2 }),
    );

    expect(onChange).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot()).toEqual({
      status: "stale",
      active: false,
      value: "a",
    });
    expect(transport.subscribeCommands()).toHaveLength(1);
  });

  test("원격 error 뒤 onChange가 1회 더 불리고 snapshot은 stale이며 미처리 오류로 보고되지 않는다", async () => {
    const originalOnUnhandledError = config.onUnhandledError;
    const unhandledSpy = vi.fn();
    config.onUnhandledError = unhandledSpy;
    try {
      const transport = new FakeTransport({ manifest: STATE_MANIFEST });
      const api = await createRendererApi<StateBridge>({ transport });
      const state = api.hardware.state.connection$;
      const store = snapshotStore(state);
      const onChange = vi.fn();
      store.subscribe(onChange);

      const subscriptionId = transport.subscriptionIdFor(CONNECTION_KEY);
      transport.emitStream(
        streamMessage(subscriptionId, { type: "subscribed", sequence: 0 }),
      );
      transport.emitStream(
        streamMessage(subscriptionId, {
          type: "batch",
          sequence: 1,
          values: ["a"],
        }),
      );
      expect(onChange).toHaveBeenCalledTimes(2);

      transport.emitStream(
        streamMessage(subscriptionId, {
          type: "error",
          sequence: 2,
          error: { code: "SOURCE_FAILED", message: "stream failed" },
        }),
      );

      expect(onChange).toHaveBeenCalledTimes(3);
      expect(store.getSnapshot()).toEqual({
        status: "stale",
        active: false,
        value: "a",
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandledSpy).not.toHaveBeenCalled();
    } finally {
      config.onUnhandledError = originalOnUnhandledError;
    }
  });

  test("반환된 해제 함수를 부르면 구독이 해제되고, 마지막 해제에서만 unsubscribe 명령이 나가며 해제 뒤 메시지로는 onChange가 불리지 않는다", async () => {
    const transport = new FakeTransport({ manifest: STATE_MANIFEST });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const store = snapshotStore(state);
    const firstOnChange = vi.fn();
    const secondOnChange = vi.fn();

    const unsubscribeFirst = store.subscribe(firstOnChange);
    const unsubscribeSecond = store.subscribe(secondOnChange);

    const subscriptionId = transport.subscriptionIdFor(CONNECTION_KEY);
    transport.emitStream(
      streamMessage(subscriptionId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(subscriptionId, {
        type: "batch",
        sequence: 1,
        values: ["a"],
      }),
    );

    unsubscribeFirst();
    expect(
      transport.controls.filter((command) => command.type === "unsubscribe"),
    ).toHaveLength(0);

    unsubscribeSecond();
    expect(transport.controls.at(-1)).toEqual({
      type: "unsubscribe",
      subscriptionId,
    });

    firstOnChange.mockClear();
    secondOnChange.mockClear();
    transport.emitStream(
      streamMessage(subscriptionId, {
        type: "batch",
        sequence: 2,
        values: ["late"],
      }),
    );
    expect(firstOnChange).not.toHaveBeenCalled();
    expect(secondOnChange).not.toHaveBeenCalled();
  });

  test("원격 종료 뒤 새 listener가 generation을 다시 열면 기존 listener도 새 generation의 변경 알림을 받는다", async () => {
    const transport = new FakeTransport({ manifest: STATE_MANIFEST });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const store = snapshotStore(state);
    const earlyOnChange = vi.fn();
    store.subscribe(earlyOnChange);

    const firstId = transport.subscriptionIdFor(CONNECTION_KEY);
    transport.emitStream(
      streamMessage(firstId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(firstId, { type: "batch", sequence: 1, values: ["a"] }),
    );
    transport.emitStream(
      streamMessage(firstId, { type: "complete", sequence: 2 }),
    );
    expect(earlyOnChange).toHaveBeenCalledTimes(3);

    const lateOnChange = vi.fn();
    const unsubscribeLate = store.subscribe(lateOnChange);
    expect(transport.subscribeCommands()).toHaveLength(2);
    expect(earlyOnChange).toHaveBeenCalledTimes(4);

    const secondId = transport.subscriptionIdFor(CONNECTION_KEY, 1);
    transport.emitStream(
      streamMessage(secondId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(secondId, { type: "batch", sequence: 1, values: ["b"] }),
    );

    expect(store.getSnapshot()).toEqual({
      status: "current",
      active: true,
      value: "b",
    });
    expect(earlyOnChange).toHaveBeenCalledTimes(5);
    expect(lateOnChange).toHaveBeenCalledTimes(2);

    // 늦은 listener가 나가도 기존 listener가 남아 있으므로 generation을 유지한다.
    unsubscribeLate();
    expect(
      transport.controls.filter((command) => command.type === "unsubscribe"),
    ).toHaveLength(0);
    expect(store.getSnapshot().status).toBe("current");
  });

  test("알림 중 앞선 listener가 뒤 listener를 해제하면 해제된 listener는 불리지 않는다", async () => {
    const transport = new FakeTransport({ manifest: STATE_MANIFEST });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const store = snapshotStore(state);
    let unsubscribeSecond: (() => void) | undefined;
    const firstOnChange = vi.fn(() => unsubscribeSecond?.());
    const secondOnChange = vi.fn();

    store.subscribe(firstOnChange);
    unsubscribeSecond = store.subscribe(secondOnChange);

    const subscriptionId = transport.subscriptionIdFor(CONNECTION_KEY);
    transport.emitStream(
      streamMessage(subscriptionId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(subscriptionId, {
        type: "batch",
        sequence: 1,
        values: ["a"],
      }),
    );

    expect(firstOnChange).toHaveBeenCalledTimes(2);
    expect(secondOnChange).not.toHaveBeenCalled();
  });

  test("같은 onChange를 두 번 구독해도 해제 함수는 각자 한 구독만 해제한다", async () => {
    const transport = new FakeTransport({ manifest: STATE_MANIFEST });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const store = snapshotStore(state);
    const onChange = vi.fn();

    const unsubscribeFirst = store.subscribe(onChange);
    const unsubscribeSecond = store.subscribe(onChange);
    unsubscribeFirst();
    unsubscribeFirst();

    const subscriptionId = transport.subscriptionIdFor(CONNECTION_KEY);
    transport.emitStream(
      streamMessage(subscriptionId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(subscriptionId, {
        type: "batch",
        sequence: 1,
        values: ["a"],
      }),
    );
    expect(onChange).toHaveBeenCalledTimes(2);

    unsubscribeSecond();
    expect(transport.controls.at(-1)).toEqual({
      type: "unsubscribe",
      subscriptionId,
    });
  });

  test("dispose된 API의 state를 구독하면 onChange가 동기로 1회 불리고 미처리 오류로 보고되지 않는다", async () => {
    const originalOnUnhandledError = config.onUnhandledError;
    const unhandledSpy = vi.fn();
    config.onUnhandledError = unhandledSpy;
    try {
      const transport = new FakeTransport({ manifest: STATE_MANIFEST });
      const api = await createRendererApi<StateBridge>({ transport });
      const state = api.hardware.state.connection$;
      const store = snapshotStore(state);
      api.dispose();

      const onChange = vi.fn();
      store.subscribe(onChange);
      expect(onChange).toHaveBeenCalledTimes(1);

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandledSpy).not.toHaveBeenCalled();
    } finally {
      config.onUnhandledError = originalOnUnhandledError;
    }
  });

  test("RemoteState 계약만 만족하는 사용자 fake도 store로 만들 수 있고 subscribe 시 onChange가 동기로 1회 불린다", () => {
    const snapshot: RemoteStateSnapshot<number> = {
      status: "current",
      active: true,
      value: 1,
    };
    const state: RemoteState<number> = Object.assign(
      new BehaviorSubject(1).asObservable(),
      { snapshot },
    );
    const store = snapshotStore(state);
    const onChange = vi.fn();

    store.subscribe(onChange);

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("동기 첫 알림 안에서 같은 store를 다시 구독해도 state는 한 번만 구독하고 전부 해제하면 남기지 않는다", () => {
    const snapshot: RemoteStateSnapshot<number> = {
      status: "current",
      active: true,
      value: 1,
    };
    const subject = new BehaviorSubject(1);
    const upstreamSubscribe = vi.fn();
    const state: RemoteState<number> = Object.assign(
      new Observable<number>((subscriber) => {
        upstreamSubscribe();
        return subject.subscribe(subscriber);
      }),
      { snapshot },
    );
    const store = snapshotStore(state);

    // 중첩 구독이 state를 다시 구독하면 동기 알림이 재귀한다. 회귀 시 test가
    // 멈추지 않고 실패하도록 깊이를 제한한다.
    let depth = 0;
    let nestedUnsubscribe: (() => void) | undefined;
    const outerUnsubscribe = store.subscribe(() => {
      depth += 1;
      if (depth > 3) {
        return;
      }
      nestedUnsubscribe ??= store.subscribe(() => {});
    });
    expect(nestedUnsubscribe).toBeDefined();
    expect(upstreamSubscribe).toHaveBeenCalledTimes(1);

    outerUnsubscribe();
    nestedUnsubscribe?.();
    expect(subject.observed).toBe(false);
  });
});

/**
 * `nth`번째 generation에 `subscribed`와 값 1개짜리 batch를 순서대로 보낸다.
 * N1~N8에서 반복되는 "구독 확인 뒤 값 하나 수신" 준비를 하나로 묶는다.
 */
function openWithValue(
  transport: FakeTransport,
  nth: number,
  value: string,
): void {
  const subscriptionId = transport.subscriptionIdFor(CONNECTION_KEY, nth);
  transport.emitStream(
    streamMessage(subscriptionId, { type: "subscribed", sequence: 0 }),
  );
  transport.emitStream(
    streamMessage(subscriptionId, {
      type: "batch",
      sequence: 1,
      values: [value],
    }),
  );
}

/**
 * `nth`번째 generation을 원격 `complete`로 끝낸다. `sequence`는 그 generation에
 * 이미 보낸 메시지 뒤를 잇도록 호출자가 정한다.
 */
function completeGeneration(
  transport: FakeTransport,
  nth: number,
  sequence: number,
): void {
  const subscriptionId = transport.subscriptionIdFor(CONNECTION_KEY, nth);
  transport.emitStream(
    streamMessage(subscriptionId, { type: "complete", sequence }),
  );
}

/**
 * N1~N4·N6의 공통 준비. 새 `FakeTransport`·API로 store를 만들고 `aOnChange`로
 * listener A를 구독한 뒤, gen1에 값 "a"를 받고 원격 `complete`로 끝낸다. 끝나면
 * snapshot은 `stale "a"`이고 store의 upstream 구독은 끝났지만 A는 listener로
 * 남는다.
 */
async function prepareStaleWithListenerA(aOnChange: () => void) {
  const transport = new FakeTransport({ manifest: STATE_MANIFEST });
  const api = await createRendererApi<StateBridge>({ transport });
  const state = api.hardware.state.connection$;
  const store = snapshotStore(state);
  const unsubscribeA = store.subscribe(aOnChange);

  openWithValue(transport, 0, "a");
  completeGeneration(transport, 0, 2);

  return { transport, state, store, unsubscribeA };
}

describe("generation 교체 추적", () => {
  test("N1: 종료 뒤 새 listener가 store를 재구독하면 기존 listener도 connecting 전환을 동기로 알림받는다", async () => {
    const behavior = { current: (): void => {} };
    const aOnChange = vi.fn(() => behavior.current());
    const { transport, store } = await prepareStaleWithListenerA(aOnChange);

    let snapshotWhenNotified: unknown;
    behavior.current = () => {
      snapshotWhenNotified = store.getSnapshot();
    };
    const callsBeforeB = aOnChange.mock.calls.length;

    store.subscribe(() => {});

    expect(aOnChange.mock.calls.length - callsBeforeB).toBe(1);
    expect(snapshotWhenNotified).toEqual({
      status: "connecting",
      active: true,
    });
    expect(transport.subscribeCommands()).toHaveLength(2);
  });

  test("N2: 직접 구독이 새로 연 generation의 connecting 전환과 값을 store listener도 함께 받는다", async () => {
    const behavior = { current: (): void => {} };
    const aOnChange = vi.fn(() => behavior.current());
    const { transport, state, store } =
      await prepareStaleWithListenerA(aOnChange);

    let snapshotWhenNotified: unknown;
    behavior.current = () => {
      snapshotWhenNotified = store.getSnapshot();
    };
    const callsBeforeD = aOnChange.mock.calls.length;

    state.subscribe({ next: () => {}, error: () => {} });

    expect(aOnChange.mock.calls.length - callsBeforeD).toBe(1);
    expect(snapshotWhenNotified).toEqual({
      status: "connecting",
      active: true,
    });
    expect(transport.subscribeCommands()).toHaveLength(2);

    openWithValue(transport, 1, "b");

    expect(aOnChange.mock.calls.length - callsBeforeD).toBe(2);
    expect(store.getSnapshot()).toEqual({
      status: "current",
      active: true,
      value: "b",
    });
  });

  test("N3: 직접 구독을 해제해도 store listener가 남아 있으면 generation을 유지하고 이후 값도 알림받는다", async () => {
    const aOnChange = vi.fn();
    const { transport, state, store, unsubscribeA } =
      await prepareStaleWithListenerA(aOnChange);

    const subscriptionD = state.subscribe({ next: () => {}, error: () => {} });
    openWithValue(transport, 1, "b");
    expect(store.getSnapshot()).toEqual({
      status: "current",
      active: true,
      value: "b",
    });

    subscriptionD.unsubscribe();
    expect(
      transport.controls.filter((command) => command.type === "unsubscribe"),
    ).toHaveLength(0);
    expect(store.getSnapshot()).toEqual({
      status: "current",
      active: true,
      value: "b",
    });

    const callsBeforeC = aOnChange.mock.calls.length;
    const gen2Id = transport.subscriptionIdFor(CONNECTION_KEY, 1);
    transport.emitStream(
      streamMessage(gen2Id, { type: "batch", sequence: 2, values: ["c"] }),
    );
    expect(aOnChange.mock.calls.length).toBeGreaterThan(callsBeforeC);

    unsubscribeA();
    expect(transport.controls.at(-1)).toEqual({
      type: "unsubscribe",
      subscriptionId: gen2Id,
    });
  });

  test("N4: 첫 값 전 error로 끝난 새 generation도 connecting·종료 알림을 store listener에게 전달한다", async () => {
    const originalOnUnhandledError = config.onUnhandledError;
    const unhandledSpy = vi.fn();
    config.onUnhandledError = unhandledSpy;
    try {
      const behavior = { current: (): void => {} };
      const aOnChange = vi.fn(() => behavior.current());
      const { transport, state, store } =
        await prepareStaleWithListenerA(aOnChange);

      const notifiedSnapshots: unknown[] = [];
      behavior.current = () => {
        notifiedSnapshots.push(store.getSnapshot());
      };

      state.subscribe({ next: () => {}, error: () => {} });

      const gen2Id = transport.subscriptionIdFor(CONNECTION_KEY, 1);
      transport.emitStream(
        streamMessage(gen2Id, { type: "subscribed", sequence: 0 }),
      );
      transport.emitStream(
        streamMessage(gen2Id, {
          type: "error",
          sequence: 1,
          error: { code: "FORBIDDEN", message: "denied" },
        }),
      );

      expect(notifiedSnapshots).toHaveLength(2);
      expect(notifiedSnapshots[0]).toEqual({
        status: "connecting",
        active: true,
      });
      expect(store.getSnapshot()).toEqual({
        status: "uninitialized",
        active: false,
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandledSpy).not.toHaveBeenCalled();
    } finally {
      config.onUnhandledError = originalOnUnhandledError;
    }
  });

  test("N5: connecting 알림 안에서 직접 subscribe 후 즉시 unsubscribe해도 재진입이 안전하게 실행되고 generation은 하나만 연다", async () => {
    const transport = new FakeTransport({ manifest: STATE_MANIFEST });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const store = snapshotStore(state);

    let reentered = false;
    const aOnChange = vi.fn(() => {
      if (store.getSnapshot().status === "connecting" && !reentered) {
        reentered = true;
        state.subscribe(() => {}).unsubscribe();
      }
    });

    const unsubscribeA = store.subscribe(aOnChange);

    expect(reentered).toBe(true);
    expect(transport.subscribeCommands()).toHaveLength(1);
    expect(
      transport.controls.filter((command) => command.type === "unsubscribe"),
    ).toHaveLength(0);

    const callsBeforeValue = aOnChange.mock.calls.length;
    const gen1Id = transport.subscriptionIdFor(CONNECTION_KEY, 0);
    transport.emitStream(
      streamMessage(gen1Id, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(gen1Id, { type: "batch", sequence: 1, values: ["a"] }),
    );

    expect(store.getSnapshot()).toEqual({
      status: "current",
      active: true,
      value: "a",
    });
    expect(aOnChange.mock.calls.length).toBeGreaterThan(callsBeforeValue);

    unsubscribeA();
    expect(
      transport.controls.filter((command) => command.type === "unsubscribe"),
    ).toHaveLength(1);
  });

  test("N6: 합류 직후 알림 안에서 마지막 store listener가 이탈해도 합류 구독을 정상 해제한다", async () => {
    let unsubscribeA: (() => void) | undefined;
    let aReleased = false;
    let releaseOnNextCall = false;
    const aOnChange = vi.fn(() => {
      if (releaseOnNextCall) {
        aReleased = true;
        unsubscribeA?.();
      }
    });

    const prepared = await prepareStaleWithListenerA(aOnChange);
    const { transport, state, store } = prepared;
    unsubscribeA = prepared.unsubscribeA;

    releaseOnNextCall = true;

    const receivedByD: unknown[] = [];
    const subscriptionD = state.subscribe({
      next: (value) => receivedByD.push(value),
      error: () => {},
    });

    expect(aReleased).toBe(true);
    expect(
      transport.controls.filter((command) => command.type === "unsubscribe"),
    ).toHaveLength(0);

    openWithValue(transport, 1, "b");

    expect(receivedByD).toEqual(["b"]);
    expect(store.getSnapshot()).toEqual({
      status: "current",
      active: true,
      value: "b",
    });

    const gen2Id = transport.subscriptionIdFor(CONNECTION_KEY, 1);
    subscriptionD.unsubscribe();

    expect(
      transport.controls.filter((command) => command.type === "unsubscribe"),
    ).toHaveLength(1);
    expect(transport.controls.at(-1)).toEqual({
      type: "unsubscribe",
      subscriptionId: gen2Id,
    });

    const gen2CommandTypes = transport.controls
      .filter(
        (command) =>
          (command.type === "subscribe" || command.type === "unsubscribe") &&
          command.subscriptionId === gen2Id,
      )
      .map((command) => command.type);
    expect(gen2CommandTypes).toEqual(["subscribe", "unsubscribe"]);
  });

  test("N7: 신호 listener가 예외를 던져도 store.subscribe는 throw하지 않고 미처리 오류로 격리 보고된다", async () => {
    const originalOnUnhandledError = config.onUnhandledError;
    const unhandledSpy = vi.fn();
    config.onUnhandledError = unhandledSpy;
    try {
      const transport = new FakeTransport({ manifest: STATE_MANIFEST });
      const api = await createRendererApi<StateBridge>({ transport });
      const state = api.hardware.state.connection$;
      const store = snapshotStore(state);

      let calls = 0;
      const aOnChange = vi.fn(() => {
        calls += 1;
        if (calls === 1) {
          throw new Error("boom");
        }
      });

      let threw = false;
      let unsubscribeA: (() => void) | undefined;
      try {
        unsubscribeA = store.subscribe(aOnChange);
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(calls).toBe(1);
      expect(transport.subscribeCommands()).toHaveLength(1);

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandledSpy).toHaveBeenCalledTimes(1);
      const reportedError: unknown = unhandledSpy.mock.calls[0]?.[0];
      expect(reportedError).toBeInstanceOf(Error);
      expect((reportedError as Error).message).toBe("boom");

      const gen1Id = transport.subscriptionIdFor(CONNECTION_KEY, 0);
      transport.emitStream(
        streamMessage(gen1Id, { type: "subscribed", sequence: 0 }),
      );
      transport.emitStream(
        streamMessage(gen1Id, { type: "batch", sequence: 1, values: ["a"] }),
      );
      expect(store.getSnapshot().status).toBe("current");

      unsubscribeA?.();
      expect(
        transport.controls.filter((command) => command.type === "unsubscribe"),
      ).toHaveLength(1);
    } finally {
      config.onUnhandledError = originalOnUnhandledError;
    }
  });

  test("N8: transport.control이 subscribe 명령에서 동기로 실패해도 재합류 루프 없이 한 번만 시도한다", async () => {
    const transport = new FakeTransport({ manifest: STATE_MANIFEST });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const store = snapshotStore(state);

    let subscribeAttempts = 0;
    transport.controlHook = (command) => {
      if (command.type === "subscribe") {
        subscribeAttempts += 1;
        // 회귀로 무한 재귀가 생겨도 test가 멈추지 않도록 5회 뒤에는 성공시킨다.
        if (subscribeAttempts <= 5) {
          throw new Error("wire failure");
        }
      }
    };

    const aOnChange = vi.fn();
    store.subscribe(aOnChange);

    expect(transport.subscribeCommands()).toHaveLength(1);
    expect(aOnChange.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(store.getSnapshot()).toEqual({
      status: "uninitialized",
      active: false,
    });
  });

  test("N9: store보다 먼저 붙은 직접 구독이 원격 complete 알림 안에서 동기로 재구독해도 store listener는 새 generation에 합류해 값 알림을 받는다", async () => {
    const transport = new FakeTransport({ manifest: STATE_MANIFEST });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const store = snapshotStore(state);

    // store보다 먼저 subject에 붙어야 complete를 store보다 먼저 받는다.
    const subscriptionD = state.pipe(repeat()).subscribe({
      error: () => {},
    });
    const aOnChange = vi.fn();
    const unsubscribeA = store.subscribe(aOnChange);

    openWithValue(transport, 0, "a");
    completeGeneration(transport, 0, 2);

    expect(transport.subscribeCommands()).toHaveLength(2);
    expect(store.getSnapshot()).toEqual({
      status: "connecting",
      active: true,
    });

    const callsBeforeValue = aOnChange.mock.calls.length;
    openWithValue(transport, 1, "b");

    expect(store.getSnapshot()).toEqual({
      status: "current",
      active: true,
      value: "b",
    });
    expect(aOnChange.mock.calls.length).toBeGreaterThan(callsBeforeValue);

    // D가 떠나도 store가 gen2를 붙잡고 있다가 A 해제 때 놓는다.
    subscriptionD.unsubscribe();
    expect(
      transport.controls.filter((command) => command.type === "unsubscribe"),
    ).toHaveLength(0);
    unsubscribeA();
    expect(transport.controls.at(-1)).toEqual({
      type: "unsubscribe",
      subscriptionId: transport.subscriptionIdFor(CONNECTION_KEY, 1),
    });
  });

  test("N10: transport가 값을 동기로 보내 합류 중 replay 알림 안에서 마지막 store listener가 이탈해도 합류 구독을 남기지 않는다", async () => {
    let releaseOnNextCall = false;
    let unsubscribeA: (() => void) | undefined;
    const aOnChange = vi.fn(() => {
      if (releaseOnNextCall) {
        unsubscribeA?.();
      }
    });
    const prepared = await prepareStaleWithListenerA(aOnChange);
    const { transport, state } = prepared;
    unsubscribeA = prepared.unsubscribeA;

    // subscribe 명령 안에서 subscribed와 값을 동기로 돌려준다. 그러면 신호가
    // 올 때 generation에 이미 값이 있어 합류가 replay 알림을 동기로 부른다.
    transport.controlHook = (command) => {
      if (command.type === "subscribe") {
        transport.emitStream(
          streamMessage(command.subscriptionId, {
            type: "subscribed",
            sequence: 0,
          }),
        );
        transport.emitStream(
          streamMessage(command.subscriptionId, {
            type: "batch",
            sequence: 1,
            values: ["b"],
          }),
        );
      }
    };
    releaseOnNextCall = true;

    state.subscribe({ next: () => {}, error: () => {} }).unsubscribe();

    expect(transport.controls.at(-1)).toEqual({
      type: "unsubscribe",
      subscriptionId: transport.subscriptionIdFor(CONNECTION_KEY, 1),
    });
    expect(state.snapshot).toEqual({
      status: "stale",
      active: false,
      value: "b",
    });
  });

  test("N11: 합류 중 replay 알림 안에서 마지막 listener가 이탈하고 새 listener가 들어와도 구독은 새 listener 쪽 하나만 남는다", async () => {
    let swapOnNextCall = false;
    let unsubscribeA: (() => void) | undefined;
    let unsubscribeB: (() => void) | undefined;
    const aOnChange = vi.fn(() => {
      if (swapOnNextCall) {
        swapOnNextCall = false;
        unsubscribeA?.();
        unsubscribeB = store.subscribe(() => {});
      }
    });
    const prepared = await prepareStaleWithListenerA(aOnChange);
    const { transport, state, store } = prepared;
    unsubscribeA = prepared.unsubscribeA;

    transport.controlHook = (command) => {
      if (command.type === "subscribe") {
        transport.emitStream(
          streamMessage(command.subscriptionId, {
            type: "subscribed",
            sequence: 0,
          }),
        );
        transport.emitStream(
          streamMessage(command.subscriptionId, {
            type: "batch",
            sequence: 1,
            values: ["b"],
          }),
        );
      }
    };
    swapOnNextCall = true;

    state.subscribe({ next: () => {}, error: () => {} }).unsubscribe();

    expect(unsubscribeB).toBeDefined();
    expect(
      transport.controls.filter((command) => command.type === "unsubscribe"),
    ).toHaveLength(0);

    unsubscribeB?.();
    expect(transport.controls.at(-1)).toEqual({
      type: "unsubscribe",
      subscriptionId: transport.subscriptionIdFor(CONNECTION_KEY, 1),
    });
  });
});
