/**
 * Main stream 구독의 server seam 동작을 확인한다.
 * State·broadcast Event·scoped Event의 upstream 공유와 전달, ACK 게이트
 * 흐름 제어와 overflow, 구독 수명주기와 순서, 세션 retire 때의 terminal
 * 통지를 `renderer-document` 드라이버로 구독하며 검증한다.
 */
import { BehaviorSubject, Observable, Subject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import { createBridgeServer } from "../../src/main/index.js";
import {
  broadcastEvent,
  currentValueSource,
  scopedEvent,
} from "../../src/main/sources.js";
import type { StreamMessage } from "../../src/protocol/index.js";
import { parseBridgeValue } from "../../src/protocol/index.js";
import { FakeTarget, sender } from "./fake-ipc.js";
import {
  rendererDocument,
  type TestSubscription,
} from "./renderer-document.js";
import { testSubscriptionId } from "./subscription-ids.js";

const STATE = "state:hardware/current$";
const EVENT = "event:hardware/change$";

/**
 * State 1개·broadcast Event 1개(buffer 용량·overflow 정책 선택)와 진단 spy를
 * 가진 server를 만들고 webContents 1·2 target을 attach한다. 대부분의 test가
 * 이 fixture 위에서 구독한다.
 */
function harness(
  options: {
    capacity?: number;
    overflow?: "error" | "drop-oldest" | "drop-newest";
  } = {},
) {
  const source = new BehaviorSubject(1);
  const events = new Subject<number>();
  const diagnostics = { record: vi.fn() };
  const server = createBridgeServer(
    {
      hardware: {
        state: { current$: currentValueSource(source) },
        event: {
          change$: broadcastEvent(events, {
            buffer: {
              capacity: options.capacity ?? 2,
              overflow: options.overflow ?? "error",
            },
          }),
        },
      },
    },
    { diagnostics },
  );
  server.attach(new FakeTarget(1));
  server.attach(new FakeTarget(2));
  return { server, source, events, diagnostics };
}

describe("Main stream 소스와 공유", () => {
  test("옛 consumer의 terminal ACK는 더 새로 공유된 upstream을 해제시키지 못한다", async () => {
    let subscriptions = 0;
    let live = 0;
    const source = new Observable<number>((subscriber) => {
      subscriptions += 1;
      live += 1;
      if (subscriptions === 1) {
        subscriber.next(1);
        subscriber.complete();
      }
      return () => {
        live -= 1;
      };
    });
    const server = createBridgeServer({
      hardware: { event: { change$: broadcastEvent(source) } },
    });
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    const record = {
      onFrame: (message: StreamMessage) => {
        messages.push(message);
      },
    };
    const doc = rendererDocument(server);
    const first = await doc.subscribe(EVENT, record);
    await doc.subscribe(EVENT, record);
    expect(subscriptions).toBe(2);
    expect(live).toBe(1);
    await first.ack(1);
    await doc.subscribe(EVENT, record);
    expect(subscriptions).toBe(2);
    expect(live).toBe(1);
    expect(
      messages.filter((message) => message.type === "subscribed"),
    ).toHaveLength(3);
  });
  test("plain Subject를 State 소스로 쓰면 거부한다", () => {
    expect(() => currentValueSource(new Subject<number>() as never)).toThrow(
      TypeError,
    );
  });

  test("현재 State를 먼저 전달하고 창 사이에 upstream 하나를 공유한다", async () => {
    const source = new BehaviorSubject(7);
    const subscribe = vi.spyOn(source, "subscribe");
    const server = createBridgeServer({
      hardware: { state: { current$: currentValueSource(source) } },
    });
    server.attach(new FakeTarget(1));
    server.attach(new FakeTarget(2));
    const doc = rendererDocument(server);
    const other = rendererDocument(server, {
      webContentsId: 2,
      clientId: "client-2",
    });
    const first = await doc.subscribe(STATE);
    const second = await other.subscribe(STATE);
    expect(first.types()).toEqual(["subscribed", "batch"]);
    expect(second.types()).toEqual(["subscribed", "batch"]);
    expect(first.frames[1]).toMatchObject({ values: [7] });
    expect(second.frames[1]).toMatchObject({ values: [7] });
    expect(subscribe).toHaveBeenCalledTimes(1);
    await first.unsubscribe();
    await second.unsubscribe();
    expect(source.observed).toBe(false);
    source.next(9);
    const later = await doc.subscribe(STATE);
    expect(later.frames[1]).toMatchObject({ values: [9] });
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  test("scoped factory는 attach된 문서의 subscribe 뒤에만 신뢰된 role과 sender를 받는다", async () => {
    const contexts: unknown[] = [];
    const server = createBridgeServer({
      hardware: {
        event: {
          change$: scopedEvent((context) => {
            contexts.push(context);
            return new Subject<number>();
          }),
        },
      },
    });
    server.attach(new FakeTarget(1, "dashboard"));
    await rendererDocument(server, {
      origin: "https://evil.example",
    }).subscribe(EVENT);
    expect(contexts).toHaveLength(0);
    await rendererDocument(server).subscribe(EVENT);
    expect(contexts).toEqual([
      expect.objectContaining({
        windowRole: "dashboard",
        clientId: "client-1",
        sender: sender(),
      }),
    ]);
  });

  test("늦게 합류한 State consumer의 getValue()가 throw하면 공유 upstream을 건드리지 않고 마스킹된 오류로 끝난다", async () => {
    const raw = new BehaviorSubject(1);
    let throwing = false;
    const flagged = Object.assign(
      new Observable<number>((subscriber) => raw.subscribe(subscriber)),
      {
        getValue: () => {
          if (throwing) throw new Error("boom");
          return raw.getValue();
        },
      },
    );
    const server = createBridgeServer({
      hardware: { state: { current$: currentValueSource(flagged) } },
    });
    server.attach(new FakeTarget(1));
    server.attach(new FakeTarget(2));
    const first = await rendererDocument(server).subscribe(STATE);
    throwing = true;
    const second = await rendererDocument(server, {
      webContentsId: 2,
      clientId: "client-2",
    }).subscribe(STATE);
    expect(first.types()).toEqual(["subscribed", "batch"]);
    expect(first.frames[1]).toMatchObject({ values: [1] });
    expect(second.types()).toEqual(["subscribed", "error"]);
    expect(second.frames.at(-1)).toMatchObject({
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    expect(raw.observed).toBe(true);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(1);
  });

  test.each([
    [
      "throws",
      (): never => {
        throw new Error("boom");
      },
    ],
    ["returns a non-Observable", () => 42 as unknown as Observable<number>],
  ] as const)(
    "factory가 %s일 때 scoped Event는 마스킹된 INTERNAL 오류로 끝나고 slot을 반환한다",
    async (_label, factory) => {
      const server = createBridgeServer({
        hardware: { event: { change$: scopedEvent(factory) } },
      });
      server.attach(new FakeTarget());
      const sub = await rendererDocument(server).subscribe(EVENT);
      expect(sub.types()).toEqual(["subscribed", "error"]);
      expect(sub.frames.at(-1)).toMatchObject({
        error: { code: "INTERNAL", message: "Internal bridge error." },
      });
      expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
    },
  );

  test("공유 subscribe 중 첫 State batch 전송이 실패하면 upstream을 관찰하지 않은 채 consumer를 닫는다", async () => {
    const source = new BehaviorSubject(1);
    const server = createBridgeServer({
      hardware: { state: { current$: currentValueSource(source) } },
    });
    server.attach(new FakeTarget());
    const sub = await rendererDocument(server).subscribe(STATE, {
      onFrame: (message) => {
        if (message.type === "batch") throw new Error("closed frame");
      },
    });
    expect(sub.types()).toEqual(["subscribed", "batch"]);
    expect(source.observed).toBe(false);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("broadcast upstream 오류는 fan-out된 모든 consumer에서 원래 메시지를 마스킹한다", async () => {
    const source = new Subject<number>();
    const server = createBridgeServer({
      hardware: { event: { change$: broadcastEvent(source) } },
    });
    server.attach(new FakeTarget(1));
    server.attach(new FakeTarget(2));
    const first = await rendererDocument(server).subscribe(EVENT);
    const second = await rendererDocument(server, {
      webContentsId: 2,
      clientId: "client-2",
    }).subscribe(EVENT);
    source.error(new Error("secret"));
    for (const messages of [first.frames, second.frames]) {
      expect(messages.map((message) => message.type)).toEqual([
        "subscribed",
        "error",
      ]);
      expect(messages.at(-1)).toMatchObject({
        error: { code: "INTERNAL", message: "Internal bridge error." },
      });
    }
    expect(JSON.stringify([...first.frames, ...second.frames])).not.toContain(
      "secret",
    );
    expect(source.observed).toBe(false);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });
});

describe("Main stream scoped Event 전달", () => {
  test("scoped Event는 broadcast와 같은 ACK 게이트 흐름 제어로 값을 batch로 보낸다", async () => {
    const upstream = new Subject<number>();
    const server = createBridgeServer({
      hardware: { event: { change$: scopedEvent(() => upstream) } },
    });
    server.attach(new FakeTarget());
    const sub = await rendererDocument(server).subscribe(EVENT);
    upstream.next(1);
    upstream.next(2);
    expect(sub.types()).toEqual(["subscribed", "batch"]);
    expect(sub.frames.at(-1)).toMatchObject({ values: [1] });
    await sub.ack(1);
    expect(sub.types()).toEqual(["subscribed", "batch", "batch"]);
    expect(sub.frames.at(-1)).toMatchObject({ values: [2] });
  });

  test("scoped Event 오류는 마스킹된 INTERNAL 오류로 끝나고 slot을 반환한다", async () => {
    const upstream = new Subject<number>();
    const diagnostics = { record: vi.fn() };
    const server = createBridgeServer(
      { hardware: { event: { change$: scopedEvent(() => upstream) } } },
      { diagnostics },
    );
    server.attach(new FakeTarget());
    const sub = await rendererDocument(server).subscribe(EVENT);
    upstream.error(new Error("boom"));
    expect(sub.types()).toEqual(["subscribed", "error"]);
    expect(sub.frames.at(-1)).toMatchObject({
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    expect(diagnostics.record.mock.calls.map(([event]) => event.type)).toEqual(
      expect.arrayContaining(["subscription-opened", "subscription-closed"]),
    );
  });

  test("scoped Event complete는 stream을 끝내고 slot을 반환한다", async () => {
    const upstream = new Subject<number>();
    const diagnostics = { record: vi.fn() };
    const server = createBridgeServer(
      { hardware: { event: { change$: scopedEvent(() => upstream) } } },
      { diagnostics },
    );
    server.attach(new FakeTarget());
    const sub = await rendererDocument(server).subscribe(EVENT);
    upstream.complete();
    expect(sub.types()).toEqual(["subscribed", "complete"]);
    expect(diagnostics.record.mock.calls.map(([event]) => event.type)).toEqual(
      expect.arrayContaining(["subscription-opened", "subscription-closed"]),
    );
  });

  test("scoped Event는 broadcast와 달리 구독마다 별도 upstream을 만든다", async () => {
    let factoryCalls = 0;
    const firstSubject = new Subject<number>();
    const secondSubject = new Subject<number>();
    const server = createBridgeServer({
      hardware: {
        event: {
          change$: scopedEvent(() => {
            factoryCalls += 1;
            return factoryCalls === 1 ? firstSubject : secondSubject;
          }),
        },
      },
    });
    server.attach(new FakeTarget(1));
    server.attach(new FakeTarget(2));
    const first = await rendererDocument(server).subscribe(EVENT);
    const second = await rendererDocument(server, {
      webContentsId: 2,
      clientId: "client-2",
    }).subscribe(EVENT);
    expect(factoryCalls).toBe(2);
    firstSubject.next(1);
    secondSubject.next(2);
    expect(first.frames.at(-1)).toMatchObject({ values: [1] });
    expect(second.frames.at(-1)).toMatchObject({ values: [2] });
  });
});

describe("Main stream 흐름 제어", () => {
  test("대기 중인 State는 수락된 schema 값의 불변 snapshot이다", async () => {
    const source = new BehaviorSubject({ nested: { count: 1 } });
    const server = createBridgeServer({
      hardware: { state: { current$: currentValueSource(source) } },
    });
    server.attach(new FakeTarget());
    const sub = await rendererDocument(server).subscribe(STATE);
    const pending: { nested: { count: number } } = { nested: { count: 2 } };
    source.next(pending);
    Object.assign(pending.nested, { count: "invalid" });
    await sub.ack(1);
    expect(sub.frames.at(-1)).toMatchObject({
      type: "batch",
      values: [{ nested: { count: 2 } }],
    });
  });

  test("대기 중인 Event는 ACK 전에 BridgeValue가 아닌 값으로 변형될 수 없다", async () => {
    const source = new Subject<{ nested: { count: number } }>();
    const server = createBridgeServer({
      hardware: { event: { change$: broadcastEvent(source) } },
    });
    server.attach(new FakeTarget());
    const sub = await rendererDocument(server).subscribe(EVENT);
    source.next({ nested: { count: 1 } });
    const pending: { nested: { count: number } } = { nested: { count: 2 } };
    source.next(pending);
    Object.assign(pending.nested, { raw: new Uint8Array([3]) });
    await sub.ack(1);
    const latest = sub.frames.at(-1);
    expect(latest).toMatchObject({
      type: "batch",
      values: [{ nested: { count: 2 } }],
    });
    if (latest?.type !== "batch") throw new Error("expected batch");
    expect(
      parseBridgeValue(latest.values[0], {
        maxDepth: 4,
        maxEntries: 10,
        maxStringBytes: 100,
      }),
    ).toEqual({ nested: { count: 2 } });
  });
  test("ACK 전까지 State batch 하나만 보내고 대기 State를 최신 값으로 교체한다", async () => {
    const { server, source } = harness();
    const sub = await rendererDocument(server).subscribe(STATE);
    source.next(2);
    source.next(3);
    expect(
      sub.frames.filter((message) => message.type === "batch"),
    ).toHaveLength(1);
    await sub.ack(1);
    expect(sub.frames.at(-1)).toMatchObject({
      type: "batch",
      sequence: 2,
      values: [3],
    });
  });

  test.each([
    ["drop-oldest", [3, 4], false],
    ["drop-newest", [2, 3], false],
    ["error", [2, 3], true],
  ] as const)(
    "Event %s는 수락한 값을 유지하고 드롭 수를 센다",
    async (overflow, expected, ends) => {
      const { server, events, diagnostics } = harness({
        capacity: 2,
        overflow,
      });
      const sub = await rendererDocument(server).subscribe(EVENT);
      events.next(1);
      events.next(2);
      events.next(3);
      events.next(4);
      expect(
        sub.frames.filter((message) => message.type === "batch"),
      ).toHaveLength(1);
      expect(sub.frames[1]).toMatchObject({ values: [1] });
      expect(diagnostics.record).toHaveBeenCalledWith(
        expect.objectContaining({ type: "stream-dropped", count: 1 }),
      );
      await sub.ack(1);
      await sub.ack(2);
      expect(
        sub.frames
          .filter((message) => message.type === "batch")
          .slice(1)
          .map((message) =>
            message.type === "batch" ? message.values[0] : undefined,
          ),
      ).toEqual(expected);
      await sub.ack(3);
      expect(sub.frames.some((message) => message.type === "error")).toBe(ends);
      expect(
        diagnostics.record.mock.calls
          .filter(([entry]) => entry.type === "stream-queue")
          .every(([entry]) => entry.depth <= 2),
      ).toBe(true);
    },
  );
});

describe("Main stream 수명주기와 순서", () => {
  test("자기 문서를 끝낸 scoped factory는 소스를 시작할 수 없다", async () => {
    let starts = 0;
    const target = new FakeTarget();
    const server = createBridgeServer({
      hardware: {
        event: {
          change$: scopedEvent(() => {
            target.endDocument();
            return new Observable<number>(() => {
              starts += 1;
            });
          }),
        },
      },
    });
    server.attach(target);
    const sub = await rendererDocument(server).subscribe(EVENT);
    expect(sub.types()).toEqual(["subscribed"]);
    expect(starts).toBe(0);
  });
  test("subscribed 전달 안의 navigation은 늦은 error와 upstream 구독을 막는다", async () => {
    const source = new Subject<number>();
    const server = createBridgeServer(
      { hardware: { event: { change$: broadcastEvent(source) } } },
      { authorize: () => false },
    );
    const target = new FakeTarget();
    server.attach(target);
    const sub = await rendererDocument(server).subscribe(EVENT, {
      onFrame: () => {
        target.endDocument();
      },
    });
    expect(sub.types()).toEqual(["subscribed"]);
    expect(source.observed).toBe(false);
  });

  test("retire된 clientId는 detach 뒤 다시 보낼 수 없고 새 client는 그 stream ID를 재사용할 수 있다", async () => {
    const { server, source } = harness();
    const doc = rendererDocument(server);
    await doc.subscribe(STATE);
    server.attach(new FakeTarget());
    const replay = await doc.subscribe(STATE, { id: 1 });
    expect(replay.types()).toEqual(["subscribed", "error"]);
    expect(replay.frames.at(-1)).toMatchObject({
      type: "error",
      error: {
        code: "FORBIDDEN",
        message: "Bridge sender is not authorized.",
      },
    });
    const replacement = await rendererDocument(server, {
      clientId: "client-2",
    }).subscribe(STATE, { id: 1 });
    expect(replacement.types()).toEqual(["subscribed", "batch"]);
    source.next(2);
    await replacement.ack(1);
    expect(replacement.frames.at(-1)).toMatchObject({
      type: "batch",
      values: [2],
    });
  });
  test("authorization 대기 중 unsubscribe는 늦은 소스 구독을 막는다", async () => {
    let allow!: (value: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const source = new Subject<number>();
    const server = createBridgeServer(
      { hardware: { event: { change$: broadcastEvent(source) } } },
      { authorize: () => authorization },
    );
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    const record = {
      onFrame: (message: StreamMessage) => {
        messages.push(message);
      },
    };
    const doc = rendererDocument(server);
    const sub = doc.begin(EVENT, record);
    await sub.unsubscribe();
    allow(true);
    await sub.ready;
    expect(source.observed).toBe(false);
    expect(messages).toEqual([]);
    await doc.subscribe(EVENT, { id: 1, ...record });
    expect(source.observed).toBe(false);
    expect(messages).toEqual([]);
  });
  test("거부된 구독은 소스를 시작하지 않고 terminal 응답을 받는다", async () => {
    const source = new Subject<number>();
    const server = createBridgeServer(
      { hardware: { event: { change$: broadcastEvent(source) } } },
      { authorize: () => false },
    );
    server.attach(new FakeTarget());
    const sub = await rendererDocument(server).subscribe(EVENT);
    expect(sub.types()).toEqual(["subscribed", "error"]);
    expect(sub.frames[1]).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(source.observed).toBe(false);
  });

  test("실패하는 sender는 upstream 구독 전에 consumer를 닫는다", async () => {
    const source = new Subject<number>();
    const server = createBridgeServer({
      hardware: { event: { change$: broadcastEvent(source) } },
    });
    server.attach(new FakeTarget());
    const sub = rendererDocument(server).begin(EVENT, {
      onFrame: () => {
        throw new Error("closed frame");
      },
    });
    await expect(sub.ready).resolves.toBeUndefined();
    expect(source.observed).toBe(false);
  });

  test("구분자가 든 clientId는 세션 사이에 충돌하지 않는다", async () => {
    const { server } = harness();
    const messages: StreamMessage[] = [];
    const record = {
      onFrame: (message: StreamMessage) => {
        messages.push(message);
      },
    };
    await rendererDocument(server, { clientId: "a" }).subscribe(STATE, record);
    await rendererDocument(server, { clientId: "a:b:c" }).subscribe(STATE, {
      id: 1,
      ...record,
    });
    expect(
      messages
        .filter((message) => message.type === "subscribed")
        .map((message) => message.clientId),
    ).toEqual(["a", "a:b:c"]);
  });

  test("동기 overflow는 용량 경계에서 producer 구독을 해제한다", async () => {
    let produced = 0;
    const source = new Observable<number>((subscriber) => {
      for (let value = 1; value <= 100 && !subscriber.closed; value += 1) {
        produced += 1;
        subscriber.next(value);
      }
    });
    const server = createBridgeServer({
      hardware: {
        event: {
          change$: broadcastEvent(source, {
            buffer: { capacity: 1, overflow: "error" },
          }),
        },
      },
    });
    server.attach(new FakeTarget());
    await rendererDocument(server).subscribe(EVENT);
    expect(produced).toBe(3);
  });

  test("동기 Event 방출은 subscribed 뒤에 오고 terminal은 ACK 뒤에 온다", async () => {
    const source = new Observable<number>((subscriber) => {
      subscriber.next(5);
      subscriber.complete();
    });
    const server = createBridgeServer({
      hardware: { event: { change$: broadcastEvent(source) } },
    });
    server.attach(new FakeTarget());
    const sub = await rendererDocument(server).subscribe(EVENT);
    expect(sub.types()).toEqual(["subscribed", "batch"]);
    await sub.ack(1);
    expect(sub.frames.at(-1)).toMatchObject({ type: "complete" });
  });

  test("terminal error는 수락한 값을 모두 보낸 뒤 오고 이후 구독은 새로 시작한다", async () => {
    const { server, events } = harness();
    const doc = rendererDocument(server);
    const sub = await doc.subscribe(EVENT);
    events.next(1);
    events.next(2);
    events.error(new Error("private secret"));
    await sub.ack(1);
    await sub.ack(2);
    expect(sub.types()).toEqual(["subscribed", "batch", "batch", "error"]);
    expect(sub.frames.at(-1)).toMatchObject({
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    const fresh = await doc.subscribe(STATE);
    expect(fresh.types()).toEqual(["subscribed", "batch"]);
  });

  test("옛 세션의 ACK와 unsubscribe는 교체한 세션에 영향을 주지 못한다", async () => {
    const { server, source } = harness();
    const sub = await rendererDocument(server).subscribe(STATE);
    const replacement = await rendererDocument(server, {
      clientId: "client-2",
    }).subscribe(STATE, { id: 1 });
    await sub.unsubscribe();
    await sub.ack(1);
    source.next(10);
    await replacement.ack(1);
    expect(replacement.frames.at(-1)).toMatchObject({
      clientId: "client-2",
      type: "batch",
      values: [10],
    });
    expect(sub.frames).toHaveLength(2);
  });

  test("maxTotalBytes를 넘는 State 값은 전송되지 않고 검증 실패가 된다", async () => {
    const source = new BehaviorSubject("x".repeat(2000));
    const diagnostics = { record: vi.fn() };
    const server = createBridgeServer(
      { hardware: { state: { current$: currentValueSource(source) } } },
      {
        payloadLimits: {
          maxDepth: 4,
          maxEntries: 10,
          maxStringBytes: 4096,
          maxTotalBytes: 1024,
        },
        diagnostics,
      },
    );
    server.attach(new FakeTarget());
    const sub = await rendererDocument(server).subscribe(STATE);
    expect(sub.types()).toEqual(["subscribed", "error"]);
    expect(sub.frames[1]).toMatchObject({
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    expect(diagnostics.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: "validation-failed" }),
    );
  });

  test("authorization 대기 중 unsubscribe는 뒤이은 거부를 침묵시킨다", async () => {
    let allow!: (value: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const source = new Subject<number>();
    const diagnostics = { record: vi.fn() };
    const server = createBridgeServer(
      { hardware: { event: { change$: broadcastEvent(source) } } },
      { authorize: () => authorization, diagnostics },
    );
    server.attach(new FakeTarget());
    const sub = rendererDocument(server).begin(EVENT);
    await sub.unsubscribe();
    allow(false);
    await sub.ready;
    expect(sub.frames).toEqual([]);
    const rejections = diagnostics.record.mock.calls
      .map(([event]) => event as { type: string })
      .filter((event) => event.type === "rejected");
    expect(rejections).toEqual([]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("authorization 대기 중 detach는 뒤이은 authorize 예외를 침묵시킨다", async () => {
    let fail!: (cause: unknown) => void;
    const authorization = new Promise<boolean>((_resolve, reject) => {
      fail = reject;
    });
    const diagnostics = { record: vi.fn() };
    const server = createBridgeServer(
      {
        hardware: { event: { change$: broadcastEvent(new Subject<number>()) } },
      },
      { authorize: () => authorization, diagnostics },
    );
    const detach = server.attach(new FakeTarget());
    const sub = rendererDocument(server).begin(EVENT);
    detach();
    fail(new Error("authorize boom"));
    await sub.ready;
    expect(sub.types()).toEqual(["subscribed", "error"]);
    expect(sub.frames[1]).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
    const rejections = diagnostics.record.mock.calls
      .map(([event]) => event as { type: string })
      .filter((event) => event.type === "rejected");
    expect(rejections).toEqual([]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("authorize 옵션 없이 구독하면 subscribed를 동기로 전달한다", async () => {
    const { server } = harness();
    const sub = rendererDocument(server).begin(STATE);
    expect(sub.frames[0]).toMatchObject({ type: "subscribed", sequence: 0 });
    await sub.ready;
  });

  test.each(["drop-oldest", "drop-newest", "error"] as const)(
    "stream-dropped 중 진단 sink에서 detach하면 stream이 CANCELLED로 끝나고 subscription-closed 뒤 stream-queue를 기록하지 않는다(%s)",
    async (policy) => {
      const { server, events, diagnostics } = harness({
        capacity: 2,
        overflow: policy,
      });
      const detach = server.attach(new FakeTarget());
      const sub = await rendererDocument(server).subscribe(EVENT);
      diagnostics.record.mockImplementation((event: { type: string }) => {
        if (event.type === "stream-dropped") detach();
      });
      events.next(1);
      events.next(2);
      events.next(3);
      events.next(4);
      events.next(5);
      expect(
        sub.frames.map((message) => ({
          type: message.type,
          sequence: message.sequence,
        })),
      ).toEqual([
        { type: "subscribed", sequence: 0 },
        { type: "batch", sequence: 1 },
        { type: "error", sequence: 2 },
      ]);
      expect(sub.frames[1]).toMatchObject({ values: [1] });
      expect(sub.frames.at(-1)).toMatchObject({
        error: { code: "CANCELLED", message: "Bridge session ended." },
      });
      expect(
        diagnostics.record.mock.calls
          .slice(-3)
          .map(
            ([event]) =>
              event as { type: string; count?: number; depth?: number },
          ),
      ).toEqual([
        expect.objectContaining({ type: "stream-dropped", count: 1 }),
        expect.objectContaining({ type: "session-closed" }),
        expect.objectContaining({ type: "subscription-closed" }),
      ]);
      expect(server.getDiagnosticsSnapshot()).toMatchObject({
        subscriptions: 0,
        queuedEvents: 0,
      });
    },
  );

  test("stream-dropped 중 진단 sink에서 unsubscribe하면 subscription-closed 뒤 stream-queue를 기록하지 않는다", async () => {
    const { server, events, diagnostics } = harness({
      capacity: 2,
      overflow: "drop-oldest",
    });
    const sub = await rendererDocument(server).subscribe(EVENT);
    diagnostics.record.mockImplementation((event: { type: string }) => {
      if (event.type === "stream-dropped") {
        void sub.unsubscribe();
      }
    });
    events.next(1);
    events.next(2);
    events.next(3);
    events.next(4);
    events.next(5);
    expect(
      sub.frames.map((message) => ({
        type: message.type,
        sequence: message.sequence,
      })),
    ).toEqual([
      { type: "subscribed", sequence: 0 },
      { type: "batch", sequence: 1 },
    ]);
    expect(sub.frames[1]).toMatchObject({ values: [1] });
    expect(
      diagnostics.record.mock.calls
        .slice(-2)
        .map(([event]) => event as { type: string; count?: number }),
    ).toEqual([
      expect.objectContaining({ type: "stream-dropped", count: 1 }),
      expect.objectContaining({ type: "subscription-closed" }),
    ]);
    expect(server.getDiagnosticsSnapshot()).toMatchObject({
      subscriptions: 0,
      queuedEvents: 0,
    });
  });

  test("push 뒤 stream-queue 진단 중 진단 sink에서 detach하면 대기 batch를 버린다", async () => {
    const { server, events, diagnostics } = harness({
      capacity: 2,
      overflow: "drop-oldest",
    });
    const detach = server.attach(new FakeTarget());
    const sub = await rendererDocument(server).subscribe(EVENT);
    diagnostics.record.mockImplementation(
      (event: { type: string; depth?: number }) => {
        if (event.type === "stream-queue" && event.depth === 1) detach();
      },
    );
    events.next(1);
    events.next(2);
    expect(
      sub.frames.map((message) => ({
        type: message.type,
        sequence: message.sequence,
      })),
    ).toEqual([
      { type: "subscribed", sequence: 0 },
      { type: "error", sequence: 1 },
    ]);
    expect(sub.frames.at(-1)).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
    expect(
      diagnostics.record.mock.calls
        .slice(-3)
        .map(([event]) => event as { type: string; depth?: number }),
    ).toEqual([
      expect.objectContaining({ type: "stream-queue", depth: 1 }),
      expect.objectContaining({ type: "session-closed" }),
      expect.objectContaining({ type: "subscription-closed" }),
    ]);
  });

  test("send 안에서 재진입한 동기 acknowledge는 미뤄 둔 큐를 순서대로 비운다", async () => {
    const { server, events, diagnostics } = harness({
      capacity: 2,
      overflow: "drop-oldest",
    });
    let gate = false;
    const sub = await rendererDocument(server).subscribe(EVENT, {
      onFrame: (message, subscription) => {
        if (gate && message.type === "batch") {
          void subscription.ack(message.sequence);
        }
      },
    });
    events.next(1);
    events.next(2);
    events.next(3);
    events.complete();
    gate = true;
    await sub.ack(1);
    expect(
      sub.frames.map((message) => ({
        type: message.type,
        sequence: message.sequence,
      })),
    ).toEqual([
      { type: "subscribed", sequence: 0 },
      { type: "batch", sequence: 1 },
      { type: "batch", sequence: 2 },
      { type: "batch", sequence: 3 },
      { type: "complete", sequence: 4 },
    ]);
    expect(sub.frames[1]).toMatchObject({ values: [1] });
    expect(sub.frames[2]).toMatchObject({ values: [2] });
    expect(sub.frames[3]).toMatchObject({ values: [3] });
    expect(
      diagnostics.record.mock.calls
        .slice(-3)
        .map(([event]) => event as { type: string; depth?: number }),
    ).toEqual([
      expect.objectContaining({ type: "stream-queue", depth: 1 }),
      expect.objectContaining({ type: "stream-queue", depth: 0 }),
      expect.objectContaining({ type: "subscription-closed" }),
    ]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("send 안에서 재진입한 동기 unsubscribe는 전달을 즉시 멈춘다", async () => {
    const { server, events, diagnostics } = harness({
      capacity: 2,
      overflow: "drop-oldest",
    });
    const sub = await rendererDocument(server).subscribe(EVENT, {
      onFrame: (message, subscription) => {
        if (message.type === "batch") {
          void subscription.unsubscribe();
        }
      },
    });
    events.next(1);
    events.next(2);
    expect(
      sub.frames.map((message) => ({
        type: message.type,
        sequence: message.sequence,
      })),
    ).toEqual([
      { type: "subscribed", sequence: 0 },
      { type: "batch", sequence: 1 },
    ]);
    expect(sub.frames[1]).toMatchObject({ values: [1] });
    expect(
      diagnostics.record.mock.calls
        .slice(-3)
        .map(([event]) => event as { type: string; depth?: number }),
    ).toEqual([
      expect.objectContaining({ type: "stream-queue", depth: 1 }),
      expect.objectContaining({ type: "stream-queue", depth: 0 }),
      expect.objectContaining({ type: "subscription-closed" }),
    ]);
    expect(server.getDiagnosticsSnapshot()).toMatchObject({
      subscriptions: 0,
      queuedEvents: 0,
    });
    events.next(3);
    expect(sub.frames).toHaveLength(2);
  });

  test("shift 뒤 stream-queue 진단 중 진단 sink에서 detach하면 flush할 값을 버린다", async () => {
    const { server, events, diagnostics } = harness({
      capacity: 2,
      overflow: "drop-oldest",
    });
    const detach = server.attach(new FakeTarget());
    const sub = await rendererDocument(server).subscribe(EVENT);
    diagnostics.record.mockImplementation(
      (event: { type: string; depth?: number }) => {
        if (event.type === "stream-queue" && event.depth === 0) detach();
      },
    );
    events.next(1);
    events.next(2);
    expect(
      sub.frames.map((message) => ({
        type: message.type,
        sequence: message.sequence,
      })),
    ).toEqual([
      { type: "subscribed", sequence: 0 },
      { type: "error", sequence: 1 },
    ]);
    expect(sub.frames.at(-1)).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
    expect(
      diagnostics.record.mock.calls
        .slice(-3)
        .map(([event]) => event as { type: string; depth?: number }),
    ).toEqual([
      expect.objectContaining({ type: "stream-queue", depth: 0 }),
      expect.objectContaining({ type: "session-closed" }),
      expect.objectContaining({ type: "subscription-closed" }),
    ]);
    expect(server.getDiagnosticsSnapshot()).toMatchObject({
      subscriptions: 0,
      queuedEvents: 0,
    });
  });

  test("같은 fan-out에서 terminal이 기록된 뒤 consumer에 도달한 공유 값은 전달되지 않는다", async () => {
    const { server, events } = harness({
      capacity: 2,
      overflow: "drop-oldest",
    });
    const doc = rendererDocument(server);
    const first = await doc.subscribe(EVENT, {
      onFrame: (message) => {
        if (message.type === "batch" && message.sequence === 2)
          events.complete();
      },
    });
    const second = await doc.subscribe(EVENT);
    events.next(1);
    await first.ack(1);
    events.next(2);
    expect(server.getDiagnosticsSnapshot().queuedEvents).toBe(0);
    await second.ack(1);
    expect(
      second.frames.map((message) => ({
        type: message.type,
        sequence: message.sequence,
      })),
    ).toEqual([
      { type: "subscribed", sequence: 0 },
      { type: "batch", sequence: 1 },
      { type: "complete", sequence: 2 },
    ]);
  });

  test("같은 fan-out에서 먼저 닫힌 consumer에 도달한 공유 값은 validation-failed를 기록하지 않는다", async () => {
    const { server, events, diagnostics } = harness();
    const doc = rendererDocument(server);
    let second: TestSubscription | undefined;
    await doc.subscribe(EVENT, {
      onFrame: (message) => {
        if (message.type === "error") void second?.unsubscribe();
      },
    });
    second = await doc.subscribe(EVENT);
    diagnostics.record.mockClear();
    events.next((() => 1) as unknown as number);
    expect(
      diagnostics.record.mock.calls.map(
        ([event]) => (event as { type: string }).type,
      ),
    ).toEqual([
      "validation-failed",
      "subscription-closed",
      "subscription-closed",
    ]);
  });
});

describe("Main stream retire 시 terminal 통지", () => {
  test("detach는 활성 State 구독자를 CANCELLED로 retire하고 ACK되지 않은 대기 값을 버린다", async () => {
    const { server, source } = harness();
    const detach = server.attach(new FakeTarget());
    const sub = await rendererDocument(server).subscribe(STATE);
    source.next(2);
    expect(sub.types()).toEqual(["subscribed", "batch"]);
    detach();
    expect(sub.types()).toEqual(["subscribed", "batch", "error"]);
    expect(sub.frames.at(-1)).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
    source.next(3);
    expect(sub.frames).toHaveLength(3);
  });

  test("detach는 아직 ACK를 기다리는 기록된 terminal을 CANCELLED로 바꾼다", async () => {
    const { server, source } = harness();
    const detach = server.attach(new FakeTarget());
    const sub = await rendererDocument(server).subscribe(STATE);
    source.complete();
    expect(sub.types()).toEqual(["subscribed", "batch"]);
    detach();
    expect(sub.types()).toEqual(["subscribed", "batch", "error"]);
    expect(sub.frames.at(-1)).toMatchObject({
      sequence: 2,
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
  });

  test("server.dispose()는 활성 broadcast Event 구독자를 CANCELLED로 retire한다", async () => {
    const { server } = harness();
    const sub = await rendererDocument(server).subscribe(EVENT);
    expect(sub.types()).toEqual(["subscribed"]);
    server.dispose();
    expect(sub.types()).toEqual(["subscribed", "error"]);
    expect(sub.frames.at(-1)).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
  });

  test("detach는 활성 scoped Event 구독자를 CANCELLED로 retire한다", async () => {
    const upstream = new Subject<number>();
    const server = createBridgeServer({
      hardware: {
        event: { change$: scopedEvent(() => upstream) },
      },
    });
    const detach = server.attach(new FakeTarget());
    const sub = await rendererDocument(server).subscribe(EVENT);
    detach();
    expect(sub.types()).toEqual(["subscribed", "error"]);
    expect(sub.frames.at(-1)).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
    expect(upstream.observed).toBe(false);
  });

  test.each([
    ["main-frame-navigation"],
    ["render-process-gone"],
    ["destroyed"],
  ] as const)(
    "%s는 stream 종료 없이 활성 구독자를 retire한다",
    async (reason) => {
      const target = new FakeTarget();
      const { server } = harness();
      server.attach(target);
      const sub = await rendererDocument(server).subscribe(STATE);
      const before = sub.frames.length;
      target.fireLifecycle(reason);
      expect(sub.frames.slice(before)).toEqual([]);
      expect(
        sub.frames.slice(0, before).map((message) => message.type),
      ).toEqual(["subscribed", "batch"]);
      expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
    },
  );

  test("교체하는 clientId는 stream 종료 없이 이전 활성 구독자를 retire한다", async () => {
    const { server } = harness();
    const sub = await rendererDocument(server).subscribe(STATE);
    const before = sub.frames.length;
    const replacement = await rendererDocument(server, {
      clientId: "client-2",
    }).subscribe(STATE, { id: 1 });
    expect(sub.frames.slice(before)).toEqual([]);
    expect(replacement.types()).toEqual(["subscribed", "batch"]);
  });

  test("활성 구독자에게 통지하다 send가 실패해도 구독자를 닫는다", async () => {
    const source = new BehaviorSubject(1);
    const server = createBridgeServer({
      hardware: { state: { current$: currentValueSource(source) } },
    });
    const detach = server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    let calls = 0;
    await rendererDocument(server).subscribe(STATE, {
      onFrame: (message) => {
        calls += 1;
        if (calls === 3) throw new Error("closed frame");
        messages.push(message);
      },
    });
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
    ]);
    expect(() => detach()).not.toThrow();
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("authorization 대기 중 detach는 subscribed 뒤 CANCELLED를 보낸다", async () => {
    let allow!: (value: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const server = createBridgeServer(
      {
        hardware: { event: { change$: broadcastEvent(new Subject<number>()) } },
      },
      { authorize: () => authorization },
    );
    const detach = server.attach(new FakeTarget());
    const sub = rendererDocument(server).begin(EVENT);
    detach();
    allow(true);
    await sub.ready;
    expect(sub.types()).toEqual(["subscribed", "error"]);
    expect(sub.frames[1]).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
  });

  test("authorization 대기 중 server.dispose()는 subscribed 뒤 CANCELLED를 보낸다", async () => {
    let allow!: (value: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const server = createBridgeServer(
      {
        hardware: { event: { change$: broadcastEvent(new Subject<number>()) } },
      },
      { authorize: () => authorization },
    );
    server.attach(new FakeTarget());
    const sub = rendererDocument(server).begin(EVENT);
    server.dispose();
    allow(true);
    await sub.ready;
    expect(sub.types()).toEqual(["subscribed", "error"]);
    expect(sub.frames[1]).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
  });

  test("대기 구독자에게 통지하다 send가 실패해도 slot을 반환한다", async () => {
    let allow!: (value: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const server = createBridgeServer(
      {
        hardware: { event: { change$: broadcastEvent(new Subject<number>()) } },
      },
      { authorize: () => authorization },
    );
    const detach = server.attach(new FakeTarget());
    const sub = rendererDocument(server).begin(EVENT, {
      onFrame: () => {
        throw new Error("closed frame");
      },
    });
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(1);
    expect(() => detach()).not.toThrow();
    allow(true);
    await sub.ready;
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("authorization 대기 중 navigation은 아무것도 보내지 않는다", async () => {
    let allow!: (value: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const target = new FakeTarget();
    const server = createBridgeServer(
      {
        hardware: { event: { change$: broadcastEvent(new Subject<number>()) } },
      },
      { authorize: () => authorization },
    );
    server.attach(target);
    const sub = rendererDocument(server).begin(EVENT);
    target.endDocument();
    allow(true);
    await sub.ready;
    expect(sub.frames).toEqual([]);
  });

  test("거부의 subscribed를 보내는 중 detach하면 거부를 CANCELLED로 바꾼다", async () => {
    const { server } = harness();
    const target = new FakeTarget();
    const detach = server.attach(target);
    const sub = await rendererDocument(server).subscribe(
      "state:hardware/missing$",
      {
        onFrame: (message) => {
          if (message.type === "subscribed") detach();
        },
      },
    );
    expect(sub.types()).toEqual(["subscribed", "error"]);
    expect(sub.frames[0]).toMatchObject({ sequence: 0 });
    expect(sub.frames[1]).toMatchObject({
      sequence: 1,
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("거부의 subscribed를 보내는 중 통지하지 않는 retire가 일어나면 더 보내지 않는다", async () => {
    const { server } = harness();
    const target = new FakeTarget();
    server.attach(target);
    const sub = await rendererDocument(server).subscribe(
      "state:hardware/missing$",
      {
        onFrame: (message) => {
          if (message.type === "subscribed") target.fireLifecycle("destroyed");
        },
      },
    );
    expect(sub.types()).toEqual(["subscribed"]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("거부를 보내기 전 진단 sink에서 detach하면 CANCELLED로 응답한다", async () => {
    const { server, diagnostics } = harness();
    const detach = server.attach(new FakeTarget());
    diagnostics.record.mockImplementation((event: { type: string }) => {
      if (event.type === "rejected") detach();
    });
    const sub = await rendererDocument(server).subscribe(
      "state:hardware/missing$",
    );
    expect(sub.types()).toEqual(["subscribed", "error"]);
    expect(sub.frames[1]).toMatchObject({
      sequence: 1,
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("authorize-denied 거부 중 진단 sink에서 detach하면 CANCELLED로 응답한다", async () => {
    const source = new BehaviorSubject(1);
    const diagnostics = { record: vi.fn() };
    const server = createBridgeServer(
      { hardware: { state: { current$: currentValueSource(source) } } },
      { authorize: () => false, diagnostics },
    );
    const detach = server.attach(new FakeTarget());
    diagnostics.record.mockImplementation(
      (event: { type: string; reason?: string }) => {
        if (event.type === "rejected" && event.reason === "authorize-denied")
          detach();
      },
    );
    const sub = await rendererDocument(server).subscribe(STATE);
    expect(sub.types()).toEqual(["subscribed", "error"]);
    expect(sub.frames[1]).toMatchObject({
      sequence: 1,
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
    const rejections = diagnostics.record.mock.calls
      .map(([event]) => event as { type: string })
      .filter((event) => event.type === "rejected");
    expect(rejections).toEqual([
      {
        type: "rejected",
        reason: "authorize-denied",
        key: "state:hardware/current$",
      },
    ]);
  });

  test("authorize-denied 진단은 구독 slot을 반환하기 전에 기록된다", async () => {
    const diagnostics = { record: vi.fn() };
    const server = createBridgeServer(
      {
        hardware: {
          state: { current$: currentValueSource(new BehaviorSubject(1)) },
        },
      },
      { authorize: () => false, diagnostics },
    );
    server.attach(new FakeTarget());
    const inSink: number[] = [];
    diagnostics.record.mockImplementation(
      (event: { type: string; reason?: string }) => {
        if (event.type === "rejected" && event.reason === "authorize-denied")
          inSink.push(server.getDiagnosticsSnapshot().subscriptions);
      },
    );
    await rendererDocument(server).subscribe(STATE);
    expect(inSink).toEqual([1]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test.each(["detach", "server.dispose()"] as const)(
    "session-opened 진단 안의 %s는 존재하는 key의 대기 구독에 CANCELLED를 통지한다",
    async (mode) => {
      const { server, source, diagnostics } = harness();
      const detach = server.attach(new FakeTarget());
      diagnostics.record.mockImplementation((event: { type: string }) => {
        if (event.type === "session-opened") {
          if (mode === "detach") detach();
          else server.dispose();
        }
      });
      const sub = await rendererDocument(server).subscribe(STATE);
      expect(sub.types()).toEqual(["subscribed", "error"]);
      expect(sub.frames[0]).toMatchObject({ sequence: 0 });
      expect(sub.frames[1]).toMatchObject({
        sequence: 1,
        error: { code: "CANCELLED", message: "Bridge session ended." },
      });
      expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
      expect(source.observed).toBe(false);
      expect(
        diagnostics.record.mock.calls.map(
          ([event]) => (event as { type: string }).type,
        ),
      ).toEqual(["session-opened", "session-closed"]);
    },
  );

  test.each(["detach", "server.dispose()"] as const)(
    "subscription-opened 진단 안의 %s는 아직 열리지 않은 consumer에 CANCELLED를 통지한다",
    async (mode) => {
      const { server, source, diagnostics } = harness();
      const detach = server.attach(new FakeTarget());
      diagnostics.record.mockImplementation((event: { type: string }) => {
        if (event.type === "subscription-opened") {
          if (mode === "detach") detach();
          else server.dispose();
        }
      });
      const sub = await rendererDocument(server).subscribe(STATE);
      expect(sub.types()).toEqual(["subscribed", "error"]);
      expect(sub.frames[0]).toMatchObject({ sequence: 0 });
      expect(sub.frames[1]).toMatchObject({
        sequence: 1,
        error: { code: "CANCELLED", message: "Bridge session ended." },
      });
      expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
      expect(source.observed).toBe(false);
      expect(
        diagnostics.record.mock.calls.map(
          ([event]) => (event as { type: string }).type,
        ),
      ).toEqual([
        "session-opened",
        "subscription-opened",
        "session-closed",
        "subscription-closed",
      ]);
    },
  );

  test("session-opened 진단 안의 main-frame-navigation은 존재하는 key의 대기 구독에 아무것도 보내지 않는다", async () => {
    const target = new FakeTarget();
    const { server, diagnostics } = harness();
    server.attach(target);
    diagnostics.record.mockImplementation((event: { type: string }) => {
      if (event.type === "session-opened")
        target.fireLifecycle("main-frame-navigation");
    });
    const sub = await rendererDocument(server).subscribe(STATE);
    expect(sub.frames).toEqual([]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("subscription-opened 진단 안의 main-frame-navigation은 아직 열리지 않은 consumer에 아무것도 보내지 않는다", async () => {
    const target = new FakeTarget();
    const { server, diagnostics } = harness();
    server.attach(target);
    diagnostics.record.mockImplementation((event: { type: string }) => {
      if (event.type === "subscription-opened")
        target.fireLifecycle("main-frame-navigation");
    });
    const sub = await rendererDocument(server).subscribe(STATE);
    expect(sub.frames).toEqual([]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("subscription-opened 진단 안의 unsubscribe는 뒤이은 detach 때 통지하는 retire listener를 남기지 않는다", async () => {
    const { server, diagnostics } = harness();
    const detach = server.attach(new FakeTarget());
    // subscribe 호출 도중이라 handle이 아직 없다 — unsubscribe를 raw로 보낸다.
    diagnostics.record.mockImplementation((event: { type: string }) => {
      if (event.type === "subscription-opened")
        void server.controlStream(
          sender(),
          {
            protocolVersion: 1,
            clientId: "client-1",
            type: "unsubscribe",
            subscriptionId: testSubscriptionId(1),
          },
          () => {},
        );
    });
    const sub = await rendererDocument(server).subscribe(STATE);
    detach();
    expect(sub.frames).toEqual([]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });
});
