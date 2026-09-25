/**
 * 세션·RPC·구독 수명주기 진단 이벤트와 `getDiagnosticsSnapshot` 집계를
 * server seam에서 확인한다. 생성·종료 이벤트가 사건마다 정확한 횟수로 남는지,
 * 거부된 구독은 opened/closed를 남기지 않는지, 스냅샷 값이 대기·활성·retire·
 * dispose 단계마다 맞게 갱신되는지를 다룬다.
 */
import { BehaviorSubject, Subject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import type { BridgeImpl } from "../../src/contract/index.js";
import { createBridgeServer } from "../../src/main/index.js";
import { broadcastEvent, currentValueSource } from "../../src/main/sources.js";
import type {
  Authorize,
  BridgeContext,
  BridgeDiagnostic,
  DiagnosticsSnapshot,
  StreamBridgeServer,
} from "../../src/main/index.js";
import type { BridgeValue, WireRpcRequest } from "../../src/protocol/index.js";
import { FakeTarget, handshakeRequest, sender } from "./fake-ipc.js";
import { rendererDocument } from "./renderer-document.js";

type HardwareBridge = {
  hardware: {
    rpc: { wait(): undefined };
    state: { current$: number };
    event: { change$: number };
  };
};

/** `rpc:hardware/wait` 호출 envelope. test는 필요한 필드만 덮어쓴다. */
const request = (overrides: Partial<WireRpcRequest> = {}): WireRpcRequest => ({
  protocolVersion: 1,
  clientId: "document-1",
  requestId: "request-1",
  key: "rpc:hardware/wait",
  input: undefined,
  ...overrides,
});

/**
 * RPC 1개(끝나지 않는 handler)·State 1개·Event 1개를 가진 server를 만든다.
 * 진단은 `records`에 쌓이고, `handlers`로 대기 중인 RPC를 test가 끝낸다.
 * target attach는 test가 직접 한다.
 */
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
  const currentSource = new BehaviorSubject(1);
  const events = new Subject<number>();
  const records: BridgeDiagnostic[] = [];
  const handlers: Array<(value: undefined) => void> = [];
  const handler = vi.fn((_input: BridgeValue, _context: BridgeContext) => {
    return new Promise<undefined>((resolve) => handlers.push(resolve));
  });
  const impl: BridgeImpl<HardwareBridge> = {
    hardware: {
      rpc: { wait: handler },
      state: { current$: currentValueSource(currentSource) },
      event: {
        change$: broadcastEvent(events, {
          buffer: { capacity: 2, overflow: options.overflow ?? "error" },
        }),
      },
    },
  };
  const server: StreamBridgeServer = createBridgeServer(impl, {
    diagnostics: { record: (record) => records.push(record) },
    ...(options.authorize === undefined
      ? {}
      : { authorize: options.authorize }),
    ...(options.resourceLimits === undefined
      ? {}
      : { resourceLimits: options.resourceLimits }),
  });
  return { server, currentSource, events, records, handler, handlers };
}

/** `records`에서 `type` 진단 이벤트의 개수를 센다. */
const opened = (records: readonly BridgeDiagnostic[], type: string) =>
  records.filter((record) => record.type === type).length;

describe("세션 수명주기 진단", () => {
  test("attach 후 handshake는 session-opened 1건을 남긴다", () => {
    const { server, records } = harness();
    const target = new FakeTarget();
    server.attach(target);
    server.handshake(sender(), handshakeRequest("client-1"));
    expect(opened(records, "session-opened")).toBe(1);
    expect(opened(records, "session-closed")).toBe(0);
  });

  test("같은 webContents에서 새 clientId는 closed 1 + opened 1을 남긴다", () => {
    const { server, records } = harness();
    const target = new FakeTarget();
    server.attach(target);
    server.handshake(sender(), handshakeRequest("client-1"));
    server.handshake(sender(), handshakeRequest("client-2"));
    expect(opened(records, "session-opened")).toBe(2);
    expect(opened(records, "session-closed")).toBe(1);
  });

  test("lifecycle(navigate)은 session-closed 1을 남긴다", () => {
    const { server, records } = harness();
    const target = new FakeTarget();
    server.attach(target);
    server.handshake(sender(), handshakeRequest("client-1"));
    target.endDocument();
    expect(opened(records, "session-closed")).toBe(1);
  });

  test("detach는 session-closed 1을 남긴다", () => {
    const { server, records } = harness();
    const target = new FakeTarget();
    const detach = server.attach(target);
    server.handshake(sender(), handshakeRequest("client-1"));
    detach();
    expect(opened(records, "session-closed")).toBe(1);
  });

  test("dispose는 남은 세션 수만큼 closed를 남기고 반복 호출은 추가 이벤트가 없다", () => {
    const { server, records } = harness();
    server.attach(new FakeTarget(1));
    server.attach(new FakeTarget(2));
    server.handshake(
      sender({ webContentsId: 1 }),
      handshakeRequest("client-1"),
    );
    server.handshake(
      sender({ webContentsId: 2 }),
      handshakeRequest("client-1"),
    );
    server.dispose();
    expect(opened(records, "session-closed")).toBe(2);
    const afterFirstDispose = records.length;
    server.dispose();
    server.dispose();
    expect(records).toHaveLength(afterFirstDispose);
  });
});

describe("RPC 수명주기 진단", () => {
  test("진행 중인 RPC 2건이 있는 세션을 retire하면 두 요청 모두 취소되고 rpc-cancelled 2회, session-closed 1회를 남긴다", async () => {
    const { server, records, handlers } = harness();
    const target = new FakeTarget();
    server.attach(target);
    const first = server.dispatchRpc(
      sender(),
      request({ requestId: "request-1" }),
    );
    const second = server.dispatchRpc(
      sender(),
      request({ requestId: "request-2" }),
    );
    await vi.waitFor(() => expect(handlers).toHaveLength(2));
    target.endDocument();
    expect(opened(records, "rpc-cancelled")).toBe(2);
    expect(opened(records, "session-closed")).toBe(1);
    handlers[0]?.(undefined);
    handlers[1]?.(undefined);
    await expect(first).resolves.toMatchObject({
      type: "error",
      error: { code: "CANCELLED" },
    });
    await expect(second).resolves.toMatchObject({
      type: "error",
      error: { code: "CANCELLED" },
    });
  });
});

describe("구독 수명주기 진단", () => {
  test("subscribe는 subscription-opened 1을 남긴다", async () => {
    const { server, records } = harness();
    server.attach(new FakeTarget());
    await rendererDocument(server, { clientId: "document-1" }).subscribe(
      "state:hardware/current$",
    );
    expect(opened(records, "subscription-opened")).toBe(1);
    expect(opened(records, "subscription-closed")).toBe(0);
  });

  test("unsubscribe는 subscription-closed 1을 남긴다", async () => {
    const { server, records } = harness();
    server.attach(new FakeTarget());
    const sub = await rendererDocument(server, {
      clientId: "document-1",
    }).subscribe("state:hardware/current$");
    await sub.unsubscribe();
    expect(opened(records, "subscription-closed")).toBe(1);
  });

  test("source complete는 subscription-closed 1을 남긴다", async () => {
    const { server, currentSource, records } = harness();
    server.attach(new FakeTarget());
    const sub = await rendererDocument(server, {
      clientId: "document-1",
    }).subscribe("state:hardware/current$");
    await sub.ack(1);
    currentSource.complete();
    expect(opened(records, "subscription-closed")).toBe(1);
  });

  test("source error는 subscription-closed 1을 남긴다", async () => {
    const { server, events, records } = harness();
    server.attach(new FakeTarget());
    await rendererDocument(server, { clientId: "document-1" }).subscribe(
      "event:hardware/change$",
    );
    events.error(new Error("boom"));
    expect(opened(records, "subscription-closed")).toBe(1);
  });

  test("overflow(error 정책)는 subscription-closed 1을 남긴다", async () => {
    const { server, events, records } = harness({ overflow: "error" });
    server.attach(new FakeTarget());
    const sub = await rendererDocument(server, {
      clientId: "document-1",
    }).subscribe("event:hardware/change$");
    events.next(1);
    events.next(2);
    events.next(3);
    events.next(4);
    await sub.ack(1);
    await sub.ack(2);
    await sub.ack(3);
    expect(opened(records, "subscription-closed")).toBe(1);
  });

  test("세션 retire는 활성 구독의 subscription-closed를 남긴다", async () => {
    const { server, records } = harness();
    const target = new FakeTarget();
    server.attach(target);
    await rendererDocument(server, { clientId: "document-1" }).subscribe(
      "state:hardware/current$",
    );
    target.endDocument();
    expect(opened(records, "subscription-closed")).toBe(1);
  });

  test("unknown-operation(NOT_FOUND)은 opened/closed를 남기지 않는다", async () => {
    const { server, records } = harness();
    server.attach(new FakeTarget());
    await rendererDocument(server, { clientId: "document-1" }).subscribe(
      "state:hardware/unknown$",
    );
    expect(opened(records, "subscription-opened")).toBe(0);
    expect(opened(records, "subscription-closed")).toBe(0);
  });

  test("authorize false(FORBIDDEN)로 거부된 구독은 opened/closed를 남기지 않는다", async () => {
    const denyAll: Authorize = () => false;
    const { server, records } = harness({ authorize: denyAll });
    server.attach(new FakeTarget());
    await rendererDocument(server, { clientId: "document-1" }).subscribe(
      "state:hardware/current$",
    );
    expect(opened(records, "subscription-opened")).toBe(0);
    expect(opened(records, "subscription-closed")).toBe(0);
  });

  test("subscription-limit(RESOURCE_EXHAUSTED)로 거부된 구독은 opened/closed를 늘리지 않는다", async () => {
    const { server, records } = harness({
      resourceLimits: { maxSubscriptions: 1 },
    });
    server.attach(new FakeTarget());
    const doc = rendererDocument(server, { clientId: "document-1" });
    await doc.subscribe("state:hardware/current$");
    expect(opened(records, "subscription-opened")).toBe(1);
    await doc.subscribe("event:hardware/change$");
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

describe("getDiagnosticsSnapshot 집계", () => {
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
    server.handshake(sender(), handshakeRequest("client-1"));
    expect(server.getDiagnosticsSnapshot().sessions).toBe(1);

    const sub = await rendererDocument(server, {
      clientId: "document-1",
    }).subscribe("state:hardware/current$");
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(1);

    await sub.unsubscribe();
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
    const sub = rendererDocument(server, { clientId: "document-1" }).begin(
      "state:hardware/current$",
    );
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(1);
    releaseAuthorize(true);
    await sub.ready;
  });

  test("queuedEvents는 모든 consumer의 대기 이벤트 길이 합이다", async () => {
    const { server, events } = harness({ overflow: "drop-oldest" });
    server.attach(new FakeTarget());
    await rendererDocument(server, { clientId: "document-1" }).subscribe(
      "event:hardware/change$",
      {
        onFrame: (frame, subscription) => {
          if (frame.type === "batch") void subscription.ack(frame.sequence);
        },
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
    server.handshake(sender(), handshakeRequest("client-1"));
    void server.dispatchRpc(sender(), request());
    await vi.waitFor(() => expect(handlers).toHaveLength(1));
    await rendererDocument(server, { clientId: "document-1" }).subscribe(
      "state:hardware/current$",
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

  test("활성 consumer의 queuedEvents와 대기 구독을 포함한 subscriptions가 집계되고 dispose 뒤 모두 0으로 돌아온다", async () => {
    let allow!: (value: boolean) => void;
    let pendingSignal: AbortSignal | undefined;
    const authorize: Authorize = (context, operation) => {
      if (operation.key === "event:hardware/change$") return true;
      pendingSignal = context.signal;
      return new Promise<boolean>((resolve) => {
        allow = resolve;
      });
    };
    const { server, events } = harness({ authorize });
    server.attach(new FakeTarget());
    const doc = rendererDocument(server, { clientId: "document-1" });
    await doc.subscribe("event:hardware/change$");
    const pending = doc.begin("state:hardware/current$");
    await vi.waitFor(() => expect(allow).toBeDefined());
    events.next(1);
    events.next(2);
    events.next(3);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(2);
    expect(server.getDiagnosticsSnapshot().queuedEvents).toBe(2);
    server.dispose();
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
    expect(server.getDiagnosticsSnapshot().queuedEvents).toBe(0);
    expect(pendingSignal?.aborted).toBe(true);
    allow(true);
    await pending.ready;
  });
});
