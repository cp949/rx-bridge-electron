/**
 * `LocalGeneration`(RemoteState·Event)의 재진입 순서를 고정하는 테스트.
 * 구독자 콜백 안에서 다시 구독·해제·dispose할 때 값 전달 횟수, snapshot,
 * control 전송 순서가 어떻게 되는지 다룬다. generation 공유를 rxjs `share`에
 * 맡기면 이 순서는 `share` 구현 순서(구독자 먼저 연결, reset이 terminal 통지보다
 * 먼저, `Subject.next`의 순회 목록 복사)에 기댄다(ADR 0027). rxjs를 올릴 때
 * 이 파일이 그 가정을 검증한다.
 */
import { config, take } from "rxjs";
import { describe, expect, test } from "vitest";

import { createRendererApi, snapshotStore } from "../../src/renderer/index.js";
import { FakeTransport, streamMessage } from "./fake-transport.js";

interface ReentrancyBridge {
  readonly hw: {
    readonly state: { readonly s$: string };
    readonly event: { readonly e$: string };
  };
}

const STATE_KEY = "state:hw/s$";
const EVENT_KEY = "event:hw/e$";

/**
 * State·Event 하나씩 가진 API와 stream 메시지 송신 도우미를 만든다.
 * 송신 도우미는 `subscriptionId`별 sequence를 스스로 이어 붙이므로, 테스트는
 * key와 몇 번째 generation(`nth`)인지만 지정한다.
 */
async function setup() {
  const transport = new FakeTransport({
    manifest: { state: [STATE_KEY], event: [EVENT_KEY] },
  });
  const api = await createRendererApi<ReentrancyBridge>({ transport });
  const sequences = new Map<string, number>();
  const send = (key: string, nth: number, body: Record<string, unknown>) => {
    const id = transport.subscriptionIdFor(key, nth);
    const sequence = sequences.get(id) ?? 0;
    sequences.set(id, sequence + 1);
    transport.emitStream(streamMessage(id, { ...body, sequence } as never));
  };
  return {
    transport,
    api,
    subscribed: (key: string, nth = 0) =>
      send(key, nth, { type: "subscribed" }),
    value: (key: string, value: string, nth = 0) =>
      send(key, nth, { type: "batch", values: [value] }),
    complete: (key: string, nth = 0) => send(key, nth, { type: "complete" }),
    error: (key: string, nth = 0) =>
      send(key, nth, { type: "error", error: { code: "X", message: "x" } }),
  };
}

/**
 * transport가 받은 control 명령의 type만 순서대로 뽑는다.
 * subscribe·unsubscribe·acknowledge 전송 순서를 한 줄로 비교하려고 쓴다.
 */
function controlTypes(transport: FakeTransport): string[] {
  return transport.controls.map((command) => command.type);
}

describe("LocalGeneration 재진입 순서", () => {
  test("next 콜백 안에서 합류한 State 구독자는 진행 중인 값을 1회만 받는다", async () => {
    const { transport, api, subscribed, value } = await setup();
    const state = api.hw.state.s$;
    const log: unknown[] = [];
    let joined = false;
    state.subscribe((v) => {
      log.push(["a", v, state.snapshot]);
      if (!joined) {
        joined = true;
        state.subscribe((w) => log.push(["b", w, state.snapshot]));
      }
    });

    subscribed(STATE_KEY);
    value(STATE_KEY, "1");
    value(STATE_KEY, "2");

    const current = (v: string) => ({
      status: "current",
      active: true,
      value: v,
    });
    expect(log).toEqual([
      ["a", "1", current("1")],
      ["b", "1", current("1")],
      ["a", "2", current("2")],
      ["b", "2", current("2")],
    ]);
    expect(controlTypes(transport)).toEqual([
      "subscribe",
      "acknowledge",
      "acknowledge",
    ]);
  });

  test("complete 콜백 안의 재구독은 끝난 generation에 합류하지 않고 새 generation을 연다", async () => {
    const { transport, api, subscribed, value, complete } = await setup();
    const state = api.hw.state.s$;
    const log: unknown[] = [];
    state.subscribe({
      complete: () => {
        log.push(["a-complete", state.snapshot]);
        state.subscribe((v) => log.push(["b", v]));
        log.push(["after-resubscribe", state.snapshot]);
      },
    });

    subscribed(STATE_KEY);
    value(STATE_KEY, "1");
    complete(STATE_KEY);

    expect(log).toEqual([
      ["a-complete", { status: "stale", active: false, value: "1" }],
      ["after-resubscribe", { status: "connecting", active: true }],
    ]);
    expect(controlTypes(transport)).toEqual([
      "subscribe",
      "acknowledge",
      "subscribe",
    ]);
  });

  test("error 콜백 안의 재구독이 연 generation은 같은 error를 받는 다음 구독자에게도 보인다", async () => {
    const { transport, api, subscribed, value, error } = await setup();
    const state = api.hw.state.s$;
    const log: unknown[] = [];
    state.subscribe({
      error: (cause: unknown) => {
        log.push(["a-error", (cause as Error).message, state.snapshot]);
        state.subscribe((v) => log.push(["c", v]));
        log.push(["a-after", state.snapshot]);
      },
    });
    state.subscribe({ error: () => log.push(["b-error", state.snapshot]) });

    subscribed(STATE_KEY);
    value(STATE_KEY, "1");
    error(STATE_KEY);

    expect(log).toEqual([
      ["a-error", "x", { status: "stale", active: false, value: "1" }],
      ["a-after", { status: "connecting", active: true }],
      ["b-error", { status: "connecting", active: true }],
    ]);
    expect(controlTypes(transport)).toEqual([
      "subscribe",
      "acknowledge",
      "subscribe",
    ]);
  });

  test("take(1)로 늦게 합류한 구독자는 현재값 재생 직후 해제되고 generation은 유지된다", async () => {
    const { transport, api, subscribed, value } = await setup();
    const state = api.hw.state.s$;
    const log: unknown[] = [];
    state.subscribe((v) => log.push(["a", v]));
    subscribed(STATE_KEY);
    value(STATE_KEY, "1");

    state.pipe(take(1)).subscribe({
      next: (v) => log.push(["b", v]),
      complete: () => log.push(["b-complete", state.snapshot]),
    });
    value(STATE_KEY, "2");

    expect(log).toEqual([
      ["a", "1"],
      ["b", "1"],
      ["b-complete", { status: "current", active: true, value: "1" }],
      ["a", "2"],
    ]);
    expect(controlTypes(transport)).toEqual([
      "subscribe",
      "acknowledge",
      "acknowledge",
    ]);
    expect(state.snapshot).toEqual({
      status: "current",
      active: true,
      value: "2",
    });
  });

  test("next 콜백 안에서 마지막 구독자가 해제한 뒤 재구독하면 옛 값 재생 없이 새 generation을 연다", async () => {
    const { transport, api, subscribed, value } = await setup();
    const state = api.hw.state.s$;
    const log: unknown[] = [];
    let done = false;
    const subscription = state.subscribe((v) => {
      log.push(["a", v]);
      if (!done) {
        done = true;
        subscription.unsubscribe();
        log.push(["after-unsubscribe", state.snapshot]);
        state.subscribe((w) => log.push(["b", w]));
        log.push(["after-resubscribe", state.snapshot]);
      }
    });

    subscribed(STATE_KEY);
    value(STATE_KEY, "1");

    expect(log).toEqual([
      ["a", "1"],
      ["after-unsubscribe", { status: "stale", active: false, value: "1" }],
      ["after-resubscribe", { status: "connecting", active: true }],
    ]);
    expect(controlTypes(transport)).toEqual([
      "subscribe",
      "unsubscribe",
      "subscribe",
      "acknowledge",
    ]);
  });

  test("구독자 next가 throw해도 다른 구독자와 늦은 합류 재생은 영향받지 않고 오류는 미처리 오류로 보고된다", async () => {
    const reported: string[] = [];
    const previous = config.onUnhandledError;
    config.onUnhandledError = (cause) =>
      reported.push((cause as Error).message);
    try {
      const { api, subscribed, value } = await setup();
      const state = api.hw.state.s$;
      const log: unknown[] = [];
      state.subscribe(() => {
        throw new Error("boom");
      });
      state.subscribe((v) => log.push(["b", v]));
      subscribed(STATE_KEY);
      value(STATE_KEY, "1");
      state.subscribe((v) => {
        log.push(["c", v]);
        throw new Error("boom2");
      });

      expect(log).toEqual([
        ["b", "1"],
        ["c", "1"],
      ]);
      expect(state.snapshot).toEqual({
        status: "current",
        active: true,
        value: "1",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reported).toEqual(["boom", "boom2"]);
    } finally {
      config.onUnhandledError = previous;
    }
  });

  test("next 콜백 안에서 합류한 Event 구독자는 진행 중인 값을 받지 않고 다음 값부터 받는다", async () => {
    const { transport, api, subscribed, value } = await setup();
    const event = api.hw.event.e$;
    const log: unknown[] = [];
    let joined = false;
    event.subscribe((v) => {
      log.push(["a", v]);
      if (!joined) {
        joined = true;
        event.subscribe((w) => log.push(["b", w]));
      }
    });

    subscribed(EVENT_KEY);
    value(EVENT_KEY, "1");
    value(EVENT_KEY, "2");

    expect(log).toEqual([
      ["a", "1"],
      ["a", "2"],
      ["b", "2"],
    ]);
    expect(controlTypes(transport)).toEqual([
      "subscribe",
      "acknowledge",
      "acknowledge",
    ]);
  });

  test("next 콜백 안의 dispose는 아직 값을 받지 못한 구독자까지 complete로 끝낸다", async () => {
    const { transport, api, subscribed, value } = await setup();
    const state = api.hw.state.s$;
    const log: unknown[] = [];
    const stale = { status: "stale", active: false, value: "1" };
    state.subscribe({
      next: (v) => {
        log.push(["a", v]);
        api.dispose();
      },
      complete: () => log.push(["a-complete", state.snapshot]),
    });
    state.subscribe({
      next: (v) => log.push(["b", v]),
      complete: () => log.push(["b-complete", state.snapshot]),
    });

    subscribed(STATE_KEY);
    value(STATE_KEY, "1");

    expect(log).toEqual([
      ["a", "1"],
      ["a-complete", stale],
      ["b-complete", stale],
    ]);
    expect(controlTypes(transport)).toEqual(["subscribe", "unsubscribe"]);
    expect(state.snapshot).toEqual(stale);
  });

  test("snapshotStore와 직접 구독이 공유한 generation은 마지막 해제 때만 unsubscribe한다", async () => {
    const { transport, api, subscribed, value } = await setup();
    const state = api.hw.state.s$;
    const store = snapshotStore(state);
    const log: unknown[] = [];
    const unsubscribeStore = store.subscribe(() =>
      log.push(["notify", store.getSnapshot()]),
    );
    subscribed(STATE_KEY);
    value(STATE_KEY, "1");
    const subscription = state.subscribe((v) => log.push(["direct", v]));

    unsubscribeStore();
    const afterStore = controlTypes(transport);
    subscription.unsubscribe();

    expect(log).toEqual([
      ["notify", { status: "connecting", active: true }],
      ["notify", { status: "current", active: true, value: "1" }],
      ["direct", "1"],
    ]);
    expect(afterStore).toEqual(["subscribe", "acknowledge"]);
    expect(controlTypes(transport)).toEqual([
      "subscribe",
      "acknowledge",
      "unsubscribe",
    ]);
    expect(state.snapshot).toEqual({
      status: "stale",
      active: false,
      value: "1",
    });
  });

  test("마지막 해제 직후 같은 tick의 재구독은 옛 값을 재생하지 않는다", async () => {
    const { transport, api, subscribed, value } = await setup();
    const state = api.hw.state.s$;
    const log: unknown[] = [];
    const first = state.subscribe((v) => log.push(["a", v]));
    subscribed(STATE_KEY);
    value(STATE_KEY, "1");

    first.unsubscribe();
    state.subscribe((v) => log.push(["b", v]));

    expect(log).toEqual([["a", "1"]]);
    expect(controlTypes(transport)).toEqual([
      "subscribe",
      "acknowledge",
      "unsubscribe",
      "subscribe",
    ]);
    expect(state.snapshot).toEqual({ status: "connecting", active: true });
  });
});
