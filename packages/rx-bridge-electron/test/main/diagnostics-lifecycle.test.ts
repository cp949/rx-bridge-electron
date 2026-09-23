import { BehaviorSubject, Subject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import {
  composeContracts,
  defineDomain,
  event,
  rpc,
  state,
  type Schema,
} from "../../src/contract/index.js";
import { createBridgeServer, implementDomain } from "../../src/main/index.js";
import { broadcastEvent, currentValueSource } from "../../src/main/sources.js";
import type {
  Authorize,
  BridgeContext,
  BridgeDiagnostic,
  DiagnosticsSnapshot,
  StreamBridgeServer,
} from "../../src/main/index.js";
import type {
  BridgeValue,
  StreamMessage,
  WireRpcRequest,
  WireStreamCommand,
} from "../../src/protocol/index.js";
import { FakeTarget, sender } from "./fake-ipc.js";
import { testSubscriptionId } from "./subscription-ids.js";

const value: Schema<undefined> = { parse: () => undefined };
const number: Schema<number> = {
  parse(input) {
    if (typeof input !== "number") throw new TypeError("number required");
    return input;
  },
};

const request = (overrides: Partial<WireRpcRequest> = {}): WireRpcRequest => ({
  protocolVersion: 1,
  clientId: "document-1",
  requestId: "request-1",
  key: "rpc:hardware/wait",
  input: undefined,
  ...overrides,
});

function subscribeCommand(
  subscriptionId: string,
  key: string,
  clientId = "document-1",
): Extract<WireStreamCommand, { type: "subscribe" }> {
  return {
    protocolVersion: 1,
    clientId,
    type: "subscribe",
    subscriptionId,
    key,
  };
}

function unsubscribeCommand(
  subscriptionId: string,
  clientId = "document-1",
): Extract<WireStreamCommand, { type: "unsubscribe" }> {
  return { protocolVersion: 1, clientId, type: "unsubscribe", subscriptionId };
}

function harness(
  options: {
    authorize?: Authorize;
    resourceLimits?: {
      maxConcurrentRpc?: number;
      maxSubscriptions?: number;
    };
    overflow?: "error" | "drop-oldest" | "drop-newest";
  } = {},
) {
  const domain = defineDomain("hardware", {
    rpc: { wait: rpc({ input: value, output: value }) },
    state: { current$: state(number) },
    event: {
      change$: event(number, {
        buffer: { capacity: 2, overflow: options.overflow ?? "error" },
      }),
    },
  });
  const currentSource = new BehaviorSubject(1);
  const events = new Subject<number>();
  const records: BridgeDiagnostic[] = [];
  const handlers: Array<(value: undefined) => void> = [];
  const handler = vi.fn((_input: BridgeValue, _context: BridgeContext) => {
    return new Promise<undefined>((resolve) => handlers.push(resolve));
  });
  const server: StreamBridgeServer = createBridgeServer(
    composeContracts(domain),
    [
      implementDomain(domain, {
        rpc: { wait: handler },
        state: { current$: currentValueSource(currentSource) },
        event: { change$: broadcastEvent(events) },
      }),
    ],
    {
      diagnostics: { record: (record) => records.push(record) },
      ...(options.authorize === undefined
        ? {}
        : { authorize: options.authorize }),
      ...(options.resourceLimits === undefined
        ? {}
        : { resourceLimits: options.resourceLimits }),
    },
  );
  return { server, currentSource, events, records, handler, handlers };
}

const opened = (records: readonly BridgeDiagnostic[], type: string) =>
  records.filter((record) => record.type === type).length;

describe("세션 수명주기 진단", () => {
  test("attach 후 handshake는 session-opened 1건을 남긴다", () => {
    const { server, records } = harness();
    const target = new FakeTarget();
    server.attach(target);
    server.handshake(sender(), "client-1");
    expect(opened(records, "session-opened")).toBe(1);
    expect(opened(records, "session-closed")).toBe(0);
  });

  test("같은 webContents에서 새 clientId는 closed 1 + opened 1을 남긴다", () => {
    const { server, records } = harness();
    const target = new FakeTarget();
    server.attach(target);
    server.handshake(sender(), "client-1");
    server.handshake(sender(), "client-2");
    expect(opened(records, "session-opened")).toBe(2);
    expect(opened(records, "session-closed")).toBe(1);
  });

  test("lifecycle(navigate)은 session-closed 1을 남긴다", () => {
    const { server, records } = harness();
    const target = new FakeTarget();
    server.attach(target);
    server.handshake(sender(), "client-1");
    target.endDocument();
    expect(opened(records, "session-closed")).toBe(1);
  });

  test("detach는 session-closed 1을 남긴다", () => {
    const { server, records } = harness();
    const target = new FakeTarget();
    const detach = server.attach(target);
    server.handshake(sender(), "client-1");
    detach();
    expect(opened(records, "session-closed")).toBe(1);
  });

  test("dispose는 남은 세션 수만큼 closed를 남기고 반복 호출은 추가 이벤트가 없다", () => {
    const { server, records } = harness();
    server.attach(new FakeTarget(1));
    server.attach(new FakeTarget(2));
    server.handshake(sender({ webContentsId: 1 }), "client-1");
    server.handshake(sender({ webContentsId: 2 }), "client-1");
    server.dispose();
    expect(opened(records, "session-closed")).toBe(2);
    const afterFirstDispose = records.length;
    server.dispose();
    server.dispose();
    expect(records).toHaveLength(afterFirstDispose);
  });
});

describe("구독 수명주기 진단", () => {
  test("subscribe는 subscription-opened 1을 남긴다", async () => {
    const { server, records } = harness();
    server.attach(new FakeTarget());
    await server.controlStream(
      sender(),
      subscribeCommand(testSubscriptionId(1), "state:hardware/current$"),
      () => {},
    );
    expect(opened(records, "subscription-opened")).toBe(1);
    expect(opened(records, "subscription-closed")).toBe(0);
  });

  test("unsubscribe는 subscription-closed 1을 남긴다", async () => {
    const { server, records } = harness();
    server.attach(new FakeTarget());
    await server.controlStream(
      sender(),
      subscribeCommand(testSubscriptionId(1), "state:hardware/current$"),
      () => {},
    );
    await server.controlStream(
      sender(),
      unsubscribeCommand(testSubscriptionId(1)),
      () => {},
    );
    expect(opened(records, "subscription-closed")).toBe(1);
  });

  test("source complete는 subscription-closed 1을 남긴다", async () => {
    const { server, currentSource, records } = harness();
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      subscribeCommand(testSubscriptionId(1), "state:hardware/current$"),
      (message) => messages.push(message),
    );
    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "document-1",
        type: "acknowledge",
        subscriptionId: testSubscriptionId(1),
        sequence: 1,
      },
      (message) => messages.push(message),
    );
    currentSource.complete();
    expect(opened(records, "subscription-closed")).toBe(1);
  });

  test("source error는 subscription-closed 1을 남긴다", async () => {
    const { server, events, records } = harness();
    server.attach(new FakeTarget());
    await server.controlStream(
      sender(),
      subscribeCommand(testSubscriptionId(1), "event:hardware/change$"),
      () => {},
    );
    events.error(new Error("boom"));
    expect(opened(records, "subscription-closed")).toBe(1);
  });

  test("overflow(error 정책)는 subscription-closed 1을 남긴다", async () => {
    const { server, events, records } = harness({ overflow: "error" });
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      subscribeCommand(testSubscriptionId(1), "event:hardware/change$"),
      (message) => messages.push(message),
    );
    events.next(1);
    events.next(2);
    events.next(3);
    events.next(4);
    const ack = (sequence: number) =>
      server.controlStream(
        sender(),
        {
          protocolVersion: 1,
          clientId: "document-1",
          type: "acknowledge",
          subscriptionId: testSubscriptionId(1),
          sequence,
        },
        (message) => messages.push(message),
      );
    await ack(1);
    await ack(2);
    await ack(3);
    expect(opened(records, "subscription-closed")).toBe(1);
  });

  test("세션 retire는 활성 구독의 subscription-closed를 남긴다", async () => {
    const { server, records } = harness();
    const target = new FakeTarget();
    server.attach(target);
    await server.controlStream(
      sender(),
      subscribeCommand(testSubscriptionId(1), "state:hardware/current$"),
      () => {},
    );
    target.endDocument();
    expect(opened(records, "subscription-closed")).toBe(1);
  });

  test("unknown-operation(NOT_FOUND)은 opened/closed를 남기지 않는다", async () => {
    const { server, records } = harness();
    server.attach(new FakeTarget());
    await server.controlStream(
      sender(),
      subscribeCommand(testSubscriptionId(1), "state:hardware/unknown$"),
      () => {},
    );
    expect(opened(records, "subscription-opened")).toBe(0);
    expect(opened(records, "subscription-closed")).toBe(0);
  });

  test("authorize false(FORBIDDEN)로 거부된 구독은 opened/closed를 남기지 않는다", async () => {
    const denyAll: Authorize = () => false;
    const { server, records } = harness({ authorize: denyAll });
    server.attach(new FakeTarget());
    await server.controlStream(
      sender(),
      subscribeCommand(testSubscriptionId(1), "state:hardware/current$"),
      () => {},
    );
    expect(opened(records, "subscription-opened")).toBe(0);
    expect(opened(records, "subscription-closed")).toBe(0);
  });

  test("subscription-limit(RESOURCE_EXHAUSTED)로 거부된 구독은 opened/closed를 늘리지 않는다", async () => {
    const { server, records } = harness({
      resourceLimits: { maxSubscriptions: 1 },
    });
    server.attach(new FakeTarget());
    await server.controlStream(
      sender(),
      subscribeCommand(testSubscriptionId(1), "state:hardware/current$"),
      () => {},
    );
    expect(opened(records, "subscription-opened")).toBe(1);
    await server.controlStream(
      sender(),
      subscribeCommand(testSubscriptionId(2), "event:hardware/change$"),
      () => {},
    );
    expect(opened(records, "subscription-opened")).toBe(1);
    expect(opened(records, "subscription-closed")).toBe(0);
  });

  test("형식 오류(invalid-input)는 opened/closed를 남기지 않는다", async () => {
    const { server, records } = harness();
    server.attach(new FakeTarget());
    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "document-1",
        type: "subscribe",
        subscriptionId: "not-an-opaque-id",
        key: "state:hardware/current$",
      },
      () => {},
    );
    expect(opened(records, "subscription-opened")).toBe(0);
    expect(opened(records, "subscription-closed")).toBe(0);
  });
});

describe("getDiagnosticsSnapshot", () => {
  test("세션·RPC·구독이 없으면 네 값 모두 0이다", () => {
    const { server } = harness();
    const snapshot: DiagnosticsSnapshot = server.getDiagnosticsSnapshot();
    expect(snapshot).toEqual({
      sessions: 0,
      rpcInFlight: 0,
      subscriptions: 0,
      queuedEvents: 0,
    });
  });

  test("세션과 구독 단계마다 스냅샷 값이 갱신된다", async () => {
    const { server } = harness();
    const target = new FakeTarget();
    server.attach(target);
    server.handshake(sender(), "client-1");
    expect(server.getDiagnosticsSnapshot().sessions).toBe(1);

    await server.controlStream(
      sender(),
      subscribeCommand(testSubscriptionId(1), "state:hardware/current$"),
      () => {},
    );
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(1);

    await server.controlStream(
      sender(),
      unsubscribeCommand(testSubscriptionId(1)),
      () => {},
    );
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);

    target.endDocument();
    expect(server.getDiagnosticsSnapshot().sessions).toBe(0);
  });

  test("authorize 대기 중인 구독은 subscriptions에 포함된다", async () => {
    let releaseAuthorize!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      releaseAuthorize = resolve;
    });
    const { server } = harness({ authorize: () => pending });
    server.attach(new FakeTarget());
    const subscribed = server.controlStream(
      sender(),
      subscribeCommand(testSubscriptionId(1), "state:hardware/current$"),
      () => {},
    );
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(1);
    releaseAuthorize(true);
    await subscribed;
  });

  test("queuedEvents는 모든 consumer의 대기 이벤트 길이 합이다", async () => {
    const { server, events } = harness({ overflow: "drop-oldest" });
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      subscribeCommand(testSubscriptionId(1), "event:hardware/change$"),
      (message) => {
        messages.push(message);
        if (message.type === "batch")
          void server.controlStream(
            sender(),
            {
              protocolVersion: 1,
              clientId: "document-1",
              type: "acknowledge",
              subscriptionId: testSubscriptionId(1),
              sequence: message.sequence,
            },
            () => {},
          );
      },
    );
    events.next(1);
    expect(server.getDiagnosticsSnapshot().queuedEvents).toBe(0);
  });

  test("retire 후 signal을 무시하는 handler가 끝나기 전까지 rpcInFlight가 유지되고 끝나면 감소한다", async () => {
    const { server, handlers } = harness();
    const target = new FakeTarget();
    server.attach(target);
    void server.dispatchRpc(sender(), request());
    await vi.waitFor(() => expect(handlers).toHaveLength(1));
    expect(server.getDiagnosticsSnapshot().rpcInFlight).toBe(1);
    target.endDocument();
    expect(server.getDiagnosticsSnapshot().rpcInFlight).toBe(1);
    handlers[0]?.(undefined);
    await vi.waitFor(() =>
      expect(server.getDiagnosticsSnapshot().rpcInFlight).toBe(0),
    );
  });

  test("모두 해제하면 네 값이 0으로 돌아온다", async () => {
    const { server, handlers } = harness();
    const target = new FakeTarget();
    server.attach(target);
    server.handshake(sender(), "client-1");
    void server.dispatchRpc(sender(), request());
    await vi.waitFor(() => expect(handlers).toHaveLength(1));
    await server.controlStream(
      sender(),
      subscribeCommand(testSubscriptionId(1), "state:hardware/current$"),
      () => {},
    );
    handlers[0]?.(undefined);
    await vi.waitFor(() =>
      expect(server.getDiagnosticsSnapshot().rpcInFlight).toBe(0),
    );
    server.dispose();
    expect(server.getDiagnosticsSnapshot()).toEqual({
      sessions: 0,
      rpcInFlight: 0,
      subscriptions: 0,
      queuedEvents: 0,
    });
  });
});
