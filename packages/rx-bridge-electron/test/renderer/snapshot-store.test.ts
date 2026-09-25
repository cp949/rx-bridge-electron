/**
 * `snapshotStore`가 `RemoteState`를 외부 store 계약(`subscribe`/`getSnapshot`)으로
 * 옮기는 것을 검증하는 테스트. 캐시 동일성, snapshot 참조 안정성, 알림 타이밍,
 * 종료(complete/error) 뒤 처리, 구독 해제, listener 공유 구독(종료 뒤 재개·
 * 알림 중 해제·중첩 구독), dispose된 API·사용자 fake 입력을 함께 다룬다.
 */
import { BehaviorSubject, Observable, config } from "rxjs";
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

  test("subscribed 전에는 onChange가 불리지 않고, 값 1개짜리 batch마다 onChange가 인자 없이 1회씩 불린다", async () => {
    const transport = new FakeTransport({ manifest: STATE_MANIFEST });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const store = snapshotStore(state);
    const onChange = vi.fn();

    store.subscribe(onChange);
    expect(onChange).not.toHaveBeenCalled();

    const subscriptionId = transport.subscriptionIdFor(CONNECTION_KEY);
    transport.emitStream(
      streamMessage(subscriptionId, { type: "subscribed", sequence: 0 }),
    );
    expect(onChange).not.toHaveBeenCalled();

    transport.emitStream(
      streamMessage(subscriptionId, {
        type: "batch",
        sequence: 1,
        values: ["a"],
      }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith();

    transport.emitStream(
      streamMessage(subscriptionId, {
        type: "batch",
        sequence: 2,
        values: ["b"],
      }),
    );
    expect(onChange).toHaveBeenCalledTimes(2);
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
    expect(onChange).toHaveBeenCalledTimes(1);

    transport.emitStream(
      streamMessage(subscriptionId, { type: "complete", sequence: 2 }),
    );

    expect(onChange).toHaveBeenCalledTimes(2);
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
      expect(onChange).toHaveBeenCalledTimes(1);

      transport.emitStream(
        streamMessage(subscriptionId, {
          type: "error",
          sequence: 2,
          error: { code: "SOURCE_FAILED", message: "stream failed" },
        }),
      );

      expect(onChange).toHaveBeenCalledTimes(2);
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
    expect(earlyOnChange).toHaveBeenCalledTimes(2);

    const lateOnChange = vi.fn();
    const unsubscribeLate = store.subscribe(lateOnChange);
    expect(transport.subscribeCommands()).toHaveLength(2);
    expect(earlyOnChange).toHaveBeenCalledTimes(2);

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
    expect(earlyOnChange).toHaveBeenCalledTimes(3);
    expect(lateOnChange).toHaveBeenCalledTimes(1);

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

    expect(firstOnChange).toHaveBeenCalledTimes(1);
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
    expect(onChange).toHaveBeenCalledTimes(1);

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
