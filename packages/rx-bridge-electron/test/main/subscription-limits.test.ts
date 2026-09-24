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
import type {
  StreamMessage,
  WireStreamCommand,
} from "../../src/protocol/index.js";
import { FakeTarget, sender } from "./fake-ipc.js";
import { testSubscriptionId } from "./subscription-ids.js";

type AppBridge = {
  hardware: {
    state: { current$: number; other$: number };
    event: { change$: number };
  };
};

function command(
  type: "subscribe",
  subscriptionId: string,
  clientId: string,
  key: string,
): Extract<WireStreamCommand, { type: "subscribe" }>;
function command(
  type: "unsubscribe",
  subscriptionId: string,
  clientId?: string,
): Extract<WireStreamCommand, { type: "unsubscribe" }>;
function command(
  type: "subscribe" | "unsubscribe",
  subscriptionId: string,
  clientId = "client-1",
  key?: string,
): WireStreamCommand {
  return type === "subscribe"
    ? {
        protocolVersion: 1,
        clientId,
        type,
        subscriptionId,
        key: key as string,
      }
    : { protocolVersion: 1, clientId, type, subscriptionId };
}
const ack = (
  subscriptionId: string,
  sequence: number,
  clientId = "client-1",
) => ({
  protocolVersion: 1 as const,
  clientId,
  type: "acknowledge" as const,
  subscriptionId,
  sequence,
});

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

const types = (messages: readonly StreamMessage[]) =>
  messages.map((message) => message.type);

describe("세션별 구독 한도", () => {
  test("maxSubscriptions 도달 시 다음 subscribe는 subscribed+error(RESOURCE_EXHAUSTED)다", async () => {
    const { server, events } = setup({
      resourceLimits: { maxSubscriptions: 2 },
    });
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "state:hardware/current$",
      ),
      () => {},
    );
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(2),
        "client-1",
        "state:hardware/other$",
      ),
      () => {},
    );
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(3),
        "client-1",
        "event:hardware/change$",
      ),
      (message) => messages.push(message),
    );
    expect(types(messages)).toEqual(["subscribed", "error"]);
    expect(messages[1]).toMatchObject({
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
    const p1 = server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "state:hardware/current$",
      ),
      () => {},
    );
    const p2 = server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(2),
        "client-1",
        "state:hardware/other$",
      ),
      () => {},
    );
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(3),
        "client-1",
        "event:hardware/change$",
      ),
      (message) => messages.push(message),
    );
    expect(types(messages)).toEqual(["subscribed", "error"]);
    expect(messages[1]).toMatchObject({
      error: { code: "RESOURCE_EXHAUSTED" },
    });
    resolvers[0]?.(true);
    resolvers[1]?.(true);
    await p1;
    await p2;
  });

  test("원격 unsubscribe(활성) 뒤 슬롯이 반환된다", async () => {
    const { server } = setup({ resourceLimits: { maxSubscriptions: 1 } });
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "state:hardware/current$",
      ),
      () => {},
    );
    await server.controlStream(
      sender(),
      command("unsubscribe", testSubscriptionId(1)),
      () => {},
    );
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(2),
        "client-1",
        "state:hardware/other$",
      ),
      (message) => messages.push(message),
    );
    expect(types(messages)).toEqual(["subscribed", "batch"]);
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
    const pending = server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "state:hardware/current$",
      ),
      () => {},
    );
    await server.controlStream(
      sender(),
      command("unsubscribe", testSubscriptionId(1)),
      () => {},
    );
    allow(true);
    await pending;
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(2),
        "client-1",
        "state:hardware/other$",
      ),
      (message) => messages.push(message),
    );
    expect(types(messages)).toEqual(["subscribed", "batch"]);
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
    const late: StreamMessage[] = [];
    const pending = server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "state:hardware/current$",
      ),
      (message) => late.push(message),
    );
    await vi.waitFor(() => expect(signal).toBeDefined());
    target.endDocument();
    expect(signal?.aborted).toBe(true);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
    allow(true);
    await pending;
    expect(late).toEqual([]);
    expect(currentSource.observed).toBe(false);
  });

  test("State 소스 complete 뒤 슬롯이 반환된다", async () => {
    const { server, currentSource } = setup({
      resourceLimits: { maxSubscriptions: 1 },
    });
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "state:hardware/current$",
      ),
      (message) => messages.push(message),
    );
    expect(types(messages)).toEqual(["subscribed", "batch"]);
    currentSource.complete();
    await server.controlStream(
      sender(),
      ack(testSubscriptionId(1), 1),
      () => {},
    );
    expect(messages.at(-1)).toMatchObject({ type: "complete" });
    const more: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(2),
        "client-1",
        "state:hardware/other$",
      ),
      (message) => more.push(message),
    );
    expect(types(more)).toEqual(["subscribed", "batch"]);
  });

  test("소스 error 뒤 슬롯이 반환된다", async () => {
    const { server, events } = setup({
      resourceLimits: { maxSubscriptions: 1 },
    });
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      (message) => messages.push(message),
    );
    events.error(new Error("boom"));
    expect(types(messages)).toEqual(["subscribed", "error"]);
    const more: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(2),
        "client-1",
        "state:hardware/current$",
      ),
      (message) => more.push(message),
    );
    expect(types(more)).toEqual(["subscribed", "batch"]);
  });

  test("Event overflow error 정책 종료 뒤 슬롯이 반환된다", async () => {
    const { server, events } = setup({
      resourceLimits: { maxSubscriptions: 1 },
    });
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      (message) => messages.push(message),
    );
    events.next(1);
    events.next(2);
    events.next(3);
    expect(types(messages)).toEqual(["subscribed", "batch"]);
    await server.controlStream(
      sender(),
      ack(testSubscriptionId(1), 1),
      () => {},
    );
    expect(types(messages)).toEqual(["subscribed", "batch", "batch"]);
    await server.controlStream(
      sender(),
      ack(testSubscriptionId(1), 2),
      () => {},
    );
    expect(messages.at(-1)).toMatchObject({
      type: "error",
      error: { code: "STREAM_OVERFLOW" },
    });
    const more: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(2),
        "client-1",
        "state:hardware/current$",
      ),
      (message) => more.push(message),
    );
    expect(types(more)).toEqual(["subscribed", "batch"]);
  });

  test("authorize가 false를 반환하면 FORBIDDEN 뒤 슬롯이 반환된다", async () => {
    let calls = 0;
    const { server } = setup({
      resourceLimits: { maxSubscriptions: 1 },
      authorize: () => calls++ !== 0,
    });
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "state:hardware/current$",
      ),
      (message) => messages.push(message),
    );
    expect(types(messages)).toEqual(["subscribed", "error"]);
    expect(messages[1]).toMatchObject({ error: { code: "FORBIDDEN" } });
    const more: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(2),
        "client-1",
        "state:hardware/other$",
      ),
      (message) => more.push(message),
    );
    expect(types(more)).toEqual(["subscribed", "batch"]);
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
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "state:hardware/current$",
      ),
      (message) => messages.push(message),
    );
    expect(types(messages)).toEqual(["subscribed", "error"]);
    expect(messages[1]).toMatchObject({ error: { code: "INTERNAL" } });
    const more: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(2),
        "client-1",
        "state:hardware/other$",
      ),
      (message) => more.push(message),
    );
    expect(types(more)).toEqual(["subscribed", "batch"]);
  });

  test("알 수 없는 key는 NOT_FOUND 뒤 슬롯이 반환된다", async () => {
    const { server } = setup({ resourceLimits: { maxSubscriptions: 1 } });
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "state:hardware/missing$",
      ),
      (message) => messages.push(message),
    );
    expect(types(messages)).toEqual(["subscribed", "error"]);
    expect(messages[1]).toMatchObject({ error: { code: "NOT_FOUND" } });
    const more: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(2),
        "client-1",
        "state:hardware/current$",
      ),
      (message) => more.push(message),
    );
    expect(types(more)).toEqual(["subscribed", "batch"]);
  });

  test("한도 초과 거부는 슬롯을 소비하지 않는다", async () => {
    const { server } = setup({ resourceLimits: { maxSubscriptions: 1 } });
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "state:hardware/current$",
      ),
      () => {},
    );
    const rejected: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(2),
        "client-1",
        "state:hardware/other$",
      ),
      (message) => rejected.push(message),
    );
    expect(types(rejected)).toEqual(["subscribed", "error"]);
    await server.controlStream(
      sender(),
      command("unsubscribe", testSubscriptionId(1)),
      () => {},
    );
    const more: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(3),
        "client-1",
        "event:hardware/change$",
      ),
      (message) => more.push(message),
    );
    expect(types(more)).toEqual(["subscribed"]);
  });

  test("세션 retire 뒤 새 세션은 구독 슬롯 0부터 시작한다", async () => {
    const { server, target } = setup({
      resourceLimits: { maxSubscriptions: 1 },
    });
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "state:hardware/current$",
      ),
      () => {},
    );
    target.endDocument();
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(2),
        "client-2",
        "state:hardware/other$",
      ),
      (message) => messages.push(message),
    );
    expect(types(messages)).toEqual(["subscribed", "batch"]);
  });

  test("세션 격리: A가 구독 한도를 소진해도 B는 정상 처리된다", async () => {
    const { server } = setup({ resourceLimits: { maxSubscriptions: 1 } });
    server.attach(new FakeTarget(2, "main"));
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "state:hardware/current$",
      ),
      () => {},
    );
    const rejected: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(2),
        "client-1",
        "state:hardware/other$",
      ),
      (message) => rejected.push(message),
    );
    expect(types(rejected)).toEqual(["subscribed", "error"]);
    const bMessages: StreamMessage[] = [];
    await server.controlStream(
      sender({ webContentsId: 2 }),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "state:hardware/other$",
      ),
      (message) => bMessages.push(message),
    );
    expect(types(bMessages)).toEqual(["subscribed", "batch"]);
  });

  test("공유 upstream이어도 consumer마다 슬롯 1개를 쓴다", async () => {
    const { server } = setup({ resourceLimits: { maxSubscriptions: 1 } });
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      () => {},
    );
    const rejected: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(2),
        "client-1",
        "event:hardware/change$",
      ),
      (message) => rejected.push(message),
    );
    expect(types(rejected)).toEqual(["subscribed", "error"]);
    expect(rejected[1]).toMatchObject({
      error: { code: "RESOURCE_EXHAUSTED" },
    });
  });
});

describe("직접 작성한 event source의 buffer 결함은 등록 시점에 거부된다", () => {
  test("capacity 0인 직접 작성 source는 createBridgeServer가 생성 시점에 TypeError를 던진다(DELTA-03 전환: 이전에는 subscribe 시점에 BoundedQueue 생성이 실패해 slot이 샜다)", () => {
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
