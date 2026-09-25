/**
 * 세션별 구독 한도(`maxSubscriptions`)와 slot 반환 시점을 server seam에서 확인한다.
 * authorize 대기 구독의 slot 점유, unsubscribe·소스 종료·거부·retire·detach 뒤
 * slot 반환, 세션 격리, 공유 upstream의 consumer별 slot을 다루고, 결함 있는
 * 직접 작성 event source가 생성 시점에 거부되는지도 확인한다.
 */
import { BehaviorSubject, Subject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import type { BridgeImpl } from "../../src/contract/index.js";
import { createBridgeServer } from "../../src/main/index.js";
import { broadcastEvent, currentValueSource } from "../../src/main/sources.js";
import type {
  Authorize,
  ResourceLimits,
  StreamBridgeServer,
} from "../../src/main/index.js";
import { FakeTarget } from "./fake-ipc.js";
import { rendererDocument } from "./renderer-document.js";

type AppBridge = {
  hardware: {
    state: { current$: number; other$: number };
    event: { change$: number };
  };
};

/**
 * State 2개(`current$`·`other$`)와 capacity 1 Event를 가진 server와 attach된
 * target을 만든다. 한도·authorize는 test마다 넘기고, 소스와 `target`으로
 * 소스 종료·문서 종료를 test가 제어한다.
 */
function setup(
  options: {
    resourceLimits?: Partial<ResourceLimits>;
    authorize?: Authorize;
  } = {},
) {
  const currentSource = new BehaviorSubject(1);
  const otherSource = new BehaviorSubject(2);
  const events = new Subject<number>();
  const impl: BridgeImpl<AppBridge> = {
    hardware: {
      state: {
        current$: currentValueSource(currentSource),
        other$: currentValueSource(otherSource),
      },
      event: {
        change$: broadcastEvent(events, {
          buffer: { capacity: 1, overflow: "error" },
        }),
      },
    },
  };
  const server: StreamBridgeServer = createBridgeServer(impl, {
    ...(options.authorize === undefined
      ? {}
      : { authorize: options.authorize }),
    ...(options.resourceLimits === undefined
      ? {}
      : { resourceLimits: options.resourceLimits }),
  });
  const target = new FakeTarget();
  server.attach(target);
  return { server, currentSource, otherSource, events, target };
}

describe("세션별 구독 한도", () => {
  test("maxSubscriptions 도달 시 다음 subscribe는 subscribed+error(RESOURCE_EXHAUSTED)다", async () => {
    const { server, events } = setup({
      resourceLimits: { maxSubscriptions: 2 },
    });
    const doc = rendererDocument(server);
    await doc.subscribe("state:hardware/current$");
    await doc.subscribe("state:hardware/other$");
    const sub = await doc.subscribe("event:hardware/change$");
    expect(sub.types()).toEqual(["subscribed", "error"]);
    expect(sub.frames[1]).toMatchObject({
      error: {
        code: "RESOURCE_EXHAUSTED",
        message: "Too many bridge subscriptions.",
      },
    });
    expect(events.observed).toBe(false);
  });

  test("authorize가 pending인 구독도 슬롯을 점유한다", async () => {
    const resolvers: Array<(value: boolean) => void> = [];
    const authorize = vi.fn(
      () => new Promise<boolean>((resolve) => resolvers.push(resolve)),
    );
    const { server } = setup({
      resourceLimits: { maxSubscriptions: 2 },
      authorize,
    });
    const doc = rendererDocument(server);
    const p1 = doc.begin("state:hardware/current$");
    const p2 = doc.begin("state:hardware/other$");
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
    const sub = await doc.subscribe("event:hardware/change$");
    expect(sub.types()).toEqual(["subscribed", "error"]);
    expect(sub.frames[1]).toMatchObject({
      error: { code: "RESOURCE_EXHAUSTED" },
    });
    resolvers[0]?.(true);
    resolvers[1]?.(true);
    await p1.ready;
    await p2.ready;
  });

  test("원격 unsubscribe(활성) 뒤 슬롯이 반환된다", async () => {
    const { server } = setup({ resourceLimits: { maxSubscriptions: 1 } });
    const doc = rendererDocument(server);
    const first = await doc.subscribe("state:hardware/current$");
    await first.unsubscribe();
    const sub = await doc.subscribe("state:hardware/other$");
    expect(sub.types()).toEqual(["subscribed", "batch"]);
  });

  test("대기 중 unsubscribe 뒤 슬롯이 반환된다", async () => {
    let allow!: (value: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const { server } = setup({
      resourceLimits: { maxSubscriptions: 1 },
      authorize: () => authorization,
    });
    const doc = rendererDocument(server);
    const pending = doc.begin("state:hardware/current$");
    await pending.unsubscribe();
    allow(true);
    await pending.ready;
    const sub = await doc.subscribe("state:hardware/other$");
    expect(sub.types()).toEqual(["subscribed", "batch"]);
  });

  test("대기 중 세션 retire는 authorize signal을 abort하고 늦은 허용을 무시한다", async () => {
    let allow!: (value: boolean) => void;
    let signal: AbortSignal | undefined;
    const authorize: Authorize = (context) => {
      signal = context.signal;
      return new Promise<boolean>((resolve) => {
        allow = resolve;
      });
    };
    const { server, target, currentSource } = setup({
      resourceLimits: { maxSubscriptions: 1 },
      authorize,
    });
    const late = rendererDocument(server).begin("state:hardware/current$");
    await vi.waitFor(() => expect(signal).toBeDefined());
    target.endDocument();
    expect(signal?.aborted).toBe(true);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
    allow(true);
    await late.ready;
    expect(late.frames).toEqual([]);
    expect(currentSource.observed).toBe(false);
  });

  test("State 소스 complete 뒤 슬롯이 반환된다", async () => {
    const { server, currentSource } = setup({
      resourceLimits: { maxSubscriptions: 1 },
    });
    const doc = rendererDocument(server);
    const sub = await doc.subscribe("state:hardware/current$");
    expect(sub.types()).toEqual(["subscribed", "batch"]);
    currentSource.complete();
    await sub.ack(1);
    expect(sub.frames.at(-1)).toMatchObject({ type: "complete" });
    const more = await doc.subscribe("state:hardware/other$");
    expect(more.types()).toEqual(["subscribed", "batch"]);
  });

  test("소스 error 뒤 슬롯이 반환된다", async () => {
    const { server, events } = setup({
      resourceLimits: { maxSubscriptions: 1 },
    });
    const doc = rendererDocument(server);
    const sub = await doc.subscribe("event:hardware/change$");
    events.error(new Error("boom"));
    expect(sub.types()).toEqual(["subscribed", "error"]);
    const more = await doc.subscribe("state:hardware/current$");
    expect(more.types()).toEqual(["subscribed", "batch"]);
  });

  test("Event overflow error 정책 종료 뒤 슬롯이 반환된다", async () => {
    const { server, events } = setup({
      resourceLimits: { maxSubscriptions: 1 },
    });
    const doc = rendererDocument(server);
    const sub = await doc.subscribe("event:hardware/change$");
    events.next(1);
    events.next(2);
    events.next(3);
    expect(sub.types()).toEqual(["subscribed", "batch"]);
    await sub.ack(1);
    expect(sub.types()).toEqual(["subscribed", "batch", "batch"]);
    await sub.ack(2);
    expect(sub.frames.at(-1)).toMatchObject({
      type: "error",
      error: { code: "STREAM_OVERFLOW" },
    });
    const more = await doc.subscribe("state:hardware/current$");
    expect(more.types()).toEqual(["subscribed", "batch"]);
  });

  test("authorize가 false를 반환하면 FORBIDDEN 뒤 슬롯이 반환된다", async () => {
    let calls = 0;
    const { server } = setup({
      resourceLimits: { maxSubscriptions: 1 },
      authorize: () => calls++ !== 0,
    });
    const doc = rendererDocument(server);
    const sub = await doc.subscribe("state:hardware/current$");
    expect(sub.types()).toEqual(["subscribed", "error"]);
    expect(sub.frames[1]).toMatchObject({ error: { code: "FORBIDDEN" } });
    const more = await doc.subscribe("state:hardware/other$");
    expect(more.types()).toEqual(["subscribed", "batch"]);
  });

  test("authorize가 예외를 던지면 INTERNAL 뒤 슬롯이 반환된다", async () => {
    let calls = 0;
    const { server } = setup({
      resourceLimits: { maxSubscriptions: 1 },
      authorize: () => {
        if (calls++ === 0) throw new Error("boom");
        return true;
      },
    });
    const doc = rendererDocument(server);
    const sub = await doc.subscribe("state:hardware/current$");
    expect(sub.types()).toEqual(["subscribed", "error"]);
    expect(sub.frames[1]).toMatchObject({ error: { code: "INTERNAL" } });
    const more = await doc.subscribe("state:hardware/other$");
    expect(more.types()).toEqual(["subscribed", "batch"]);
  });

  test("알 수 없는 key는 NOT_FOUND로 끝나고 슬롯을 쓰지 않는다", async () => {
    const { server } = setup({ resourceLimits: { maxSubscriptions: 1 } });
    const doc = rendererDocument(server);
    const sub = await doc.subscribe("state:hardware/missing$");
    expect(sub.types()).toEqual(["subscribed", "error"]);
    expect(sub.frames[1]).toMatchObject({ error: { code: "NOT_FOUND" } });
    const more = await doc.subscribe("state:hardware/current$");
    expect(more.types()).toEqual(["subscribed", "batch"]);
  });

  test("한도 초과 거부는 슬롯을 소비하지 않는다", async () => {
    const { server } = setup({ resourceLimits: { maxSubscriptions: 1 } });
    const doc = rendererDocument(server);
    const first = await doc.subscribe("state:hardware/current$");
    const rejected = await doc.subscribe("state:hardware/other$");
    expect(rejected.types()).toEqual(["subscribed", "error"]);
    await first.unsubscribe();
    const more = await doc.subscribe("event:hardware/change$");
    expect(more.types()).toEqual(["subscribed"]);
  });

  test("세션 retire 뒤 새 세션은 구독 슬롯 0부터 시작한다", async () => {
    const { server, target } = setup({
      resourceLimits: { maxSubscriptions: 1 },
    });
    await rendererDocument(server).subscribe("state:hardware/current$");
    target.endDocument();
    const sub = await rendererDocument(server, {
      clientId: "client-2",
    }).subscribe("state:hardware/other$");
    expect(sub.types()).toEqual(["subscribed", "batch"]);
  });

  test("세션 격리: A가 구독 한도를 소진해도 B는 정상 처리된다", async () => {
    const { server } = setup({ resourceLimits: { maxSubscriptions: 1 } });
    server.attach(new FakeTarget(2, "main"));
    const a = rendererDocument(server);
    await a.subscribe("state:hardware/current$");
    const rejected = await a.subscribe("state:hardware/other$");
    expect(rejected.types()).toEqual(["subscribed", "error"]);
    const b = await rendererDocument(server, { webContentsId: 2 }).subscribe(
      "state:hardware/other$",
      { id: 1 },
    );
    expect(b.types()).toEqual(["subscribed", "batch"]);
  });

  test("공유 upstream이어도 consumer마다 슬롯 1개를 쓴다", async () => {
    const { server } = setup({ resourceLimits: { maxSubscriptions: 1 } });
    const doc = rendererDocument(server);
    await doc.subscribe("event:hardware/change$");
    const rejected = await doc.subscribe("event:hardware/change$");
    expect(rejected.types()).toEqual(["subscribed", "error"]);
    expect(rejected.frames[1]).toMatchObject({
      error: { code: "RESOURCE_EXHAUSTED" },
    });
  });

  test("pending → consumer 전환 중에도 slot이 유지된다", async () => {
    let allowOther!: (value: boolean) => void;
    const authorize: Authorize = (_context, operation) => {
      if (operation.key === "state:hardware/current$") return true;
      return new Promise<boolean>((resolve) => {
        allowOther = resolve;
      });
    };
    const { server } = setup({
      resourceLimits: { maxSubscriptions: 2 },
      authorize,
    });
    const doc = rendererDocument(server);
    await doc.subscribe("state:hardware/current$");
    const pending = doc.begin("state:hardware/other$");
    await vi.waitFor(() => expect(allowOther).toBeDefined());
    const rejected = await doc.subscribe("event:hardware/change$");
    expect(rejected.types()).toEqual(["subscribed", "error"]);
    expect(rejected.frames[1]).toMatchObject({
      error: {
        code: "RESOURCE_EXHAUSTED",
        message: "Too many bridge subscriptions.",
      },
    });
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(2);
    allowOther(true);
    await pending.ready;
    const rejectedAgain = await doc.subscribe("event:hardware/change$");
    expect(rejectedAgain.types()).toEqual(["subscribed", "error"]);
    expect(rejectedAgain.frames[1]).toMatchObject({
      error: { code: "RESOURCE_EXHAUSTED" },
    });
  });

  test("대기 중 세션 detach는 즉시 slot을 반환하고 CANCELLED를 통지한다", async () => {
    let allow!: (value: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const currentSource = new BehaviorSubject(1);
    const impl: BridgeImpl<AppBridge> = {
      hardware: {
        state: {
          current$: currentValueSource(currentSource),
          other$: currentValueSource(new BehaviorSubject(2)),
        },
        event: {
          change$: broadcastEvent(new Subject<number>(), {
            buffer: { capacity: 1, overflow: "error" },
          }),
        },
      },
    };
    const server: StreamBridgeServer = createBridgeServer(impl, {
      authorize: () => authorization,
    });
    const detach = server.attach(new FakeTarget());
    const pending = rendererDocument(server).begin("state:hardware/current$");
    detach();
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
    expect(pending.types()).toEqual(["subscribed", "error"]);
    expect(pending.frames[1]).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
    allow(true);
    await pending.ready;
    expect(pending.types()).toEqual(["subscribed", "error"]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
    expect(currentSource.observed).toBe(false);
  });
});

describe("직접 작성한 event source의 buffer 결함은 등록 시점에 거부된다", () => {
  test("capacity 0인 직접 작성 source는 createBridgeServer가 생성 시점에 TypeError를 던진다(이전에는 subscribe 시점에 BoundedQueue 생성이 실패해 slot이 샜다)", () => {
    const brokenEvents = new Subject<number>();
    const impl: BridgeImpl<AppBridge> = {
      hardware: {
        state: {
          current$: currentValueSource(new BehaviorSubject(1)),
          other$: currentValueSource(new BehaviorSubject(2)),
        },
        event: {
          change$: {
            mode: "broadcast",
            source: brokenEvents,
            buffer: { capacity: 0, overflow: "error" },
          },
        },
      },
    };
    expect(() =>
      createBridgeServer(impl, { resourceLimits: { maxSubscriptions: 1 } }),
    ).toThrow(
      /Event source 'hardware\/change\$' buffer capacity must be a positive safe integer\./,
    );
  });
});
