import { EventEmitter } from "node:events";
import { BehaviorSubject, Subject } from "rxjs";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { IpcMain, WebContents } from "electron";

import type { BridgeImpl, Schema } from "../../src/contract/index.js";
import {
  bindElectronBridge,
  createBridgeServer,
  ELECTRON_BRIDGE_CHANNELS,
  type BridgeDiagnostic,
  type DiagnosticsSnapshot,
  type SenderIdentity,
} from "../../src/main/index.js";
import { broadcastEvent, currentValueSource } from "../../src/main/sources.js";

/**
 * RD-007 통합 시나리오: DELTA-01~05의 계약(진단 이벤트 종류, 거부 사유, 수명주기,
 * 스냅샷, 기록 금지 항목, sink 예외 격리, 기본 무출력)을 두 세션(A·B)의 한 흐름에서
 * 함께 검증한다.
 */

const MARKER = "__RD007_MARKER__";

const stringSchema: Schema<string> = {
  parse(input) {
    if (typeof input !== "string") throw new TypeError("string required");
    return input;
  },
};
const numberSchema: Schema<number> = {
  parse(input) {
    if (typeof input !== "number") throw new TypeError("number required");
    return input;
  },
};

type IntegrationBridge = {
  hardware: {
    rpc: {
      echo(input: string): string;
      connect(input: string): string;
      slow(input: string): string;
    };
    state: { current$: number };
    event: { change$: number };
  };
};

const integrationSchemas = {
  hardware: {
    rpc: {
      echo: { input: stringSchema, output: stringSchema },
      connect: { input: stringSchema, output: stringSchema },
      slow: { input: stringSchema, output: stringSchema },
    },
    state: { current$: numberSchema },
    event: { change$: numberSchema },
  },
};

const integrationErrors = {
  hardware: { rpc: { connect: ["DEVICE_GONE"] as const } },
};

/** Minimal fake standing in for Electron's `ipcMain`, mirroring `electron-adapter.test.ts`. */
class FakeIpcMain extends EventEmitter {
  public readonly handlers = new Map<
    string,
    (event: unknown, value: unknown) => unknown
  >();

  public handle(
    channel: string,
    listener: (event: unknown, value: unknown) => unknown,
  ): void {
    this.handlers.set(channel, listener);
  }

  public removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
}

/** Minimal fake standing in for Electron's `WebContents`: id + mainFrame + lifecycle events. */
class FakeContents extends EventEmitter {
  public readonly id: number;
  public readonly mainFrame: {
    readonly routingId: number;
    readonly url: string;
  };

  public constructor(id: number, routingId: number, url: string) {
    super();
    this.id = id;
    this.mainFrame = { routingId, url };
  }
}

type SinkMode = "record" | "none" | "throw";

function makeDiagnostics(
  mode: SinkMode,
  records: BridgeDiagnostic[],
): { record(event: BridgeDiagnostic): void } | undefined {
  if (mode === "none") return undefined;
  if (mode === "throw")
    return {
      record() {
        throw new Error("sink boom");
      },
    };
  return {
    record(event: BridgeDiagnostic) {
      records.push(event);
    },
  };
}

function subId(session: "a" | "b", n: number): string {
  return `${MARKER}:${session}:${n.toString(36)}`;
}

interface ScenarioResult {
  readonly responses: readonly unknown[];
  readonly streamMessages: readonly unknown[];
  readonly records: readonly BridgeDiagnostic[];
  readonly snapshotBeforeDispose: DiagnosticsSnapshot;
  readonly snapshotAfterDispose: DiagnosticsSnapshot;
}

async function runScenario(mode: SinkMode): Promise<ScenarioResult> {
  const records: BridgeDiagnostic[] = [];
  const diagnostics = makeDiagnostics(mode, records);
  const currentSource = new BehaviorSubject(1);
  const events = new Subject<number>();
  const resolvers: Array<(value: string) => void> = [];

  const echoHandler = vi.fn(async (input: string) => input);
  const connectHandler = vi.fn(async (): Promise<string> => {
    throw Object.assign(new Error(`device-unavailable-${MARKER}`), {
      code: "DEVICE_GONE",
    });
  });
  const slowHandler = vi.fn(
    (_input: string) =>
      new Promise<string>((resolve) => {
        resolvers.push(resolve);
      }),
  );

  const impl: BridgeImpl<IntegrationBridge> = {
    hardware: {
      rpc: { echo: echoHandler, connect: connectHandler, slow: slowHandler },
      state: { current$: currentValueSource(currentSource) },
      event: {
        change$: broadcastEvent(events, {
          buffer: { capacity: 2, overflow: "error" },
        }),
      },
    },
  };
  const server = createBridgeServer(impl, {
    schemas: integrationSchemas,
    errors: integrationErrors,
    resourceLimits: { maxConcurrentRpc: 1, maxRpcDurationMs: 5000 },
    ...(diagnostics === undefined ? {} : { diagnostics }),
  });

  const ipcMain = new FakeIpcMain();
  const bridge = bindElectronBridge({
    ipcMain: ipcMain as unknown as IpcMain,
    server,
    namespace: "integration",
    allowedOrigins: ["app://local"],
  });
  const channels = ELECTRON_BRIDGE_CHANNELS("integration");
  const handshakeHandler = ipcMain.handlers.get(channels.handshake)!;
  const rpcHandler = ipcMain.handlers.get(channels.rpc)!;

  const contentsA = new FakeContents(1, 10, "app://local");
  const contentsB = new FakeContents(2, 20, "app://local");
  const evilContents = new FakeContents(99, 30, `app://${MARKER}-evil`);
  bridge.attach(contentsA as unknown as WebContents, "main");
  const detachB = bridge.attach(contentsB as unknown as WebContents, "main");

  const eventA = { sender: contentsA, senderFrame: contentsA.mainFrame };
  const eventB = { sender: contentsB, senderFrame: contentsB.mainFrame };
  const eventEvil = {
    sender: evilContents,
    senderFrame: evilContents.mainFrame,
  };
  const senderA: SenderIdentity = {
    webContentsId: 1,
    frameId: 10,
    isMainFrame: true,
    origin: "app://local",
  };
  const senderB: SenderIdentity = {
    webContentsId: 2,
    frameId: 20,
    isMainFrame: true,
    origin: "app://local",
  };

  const clientA = `${MARKER}-client-A`;
  const clientB = `${MARKER}-client-B`;
  const responses: unknown[] = [];
  const streamMessages: unknown[] = [];

  const rpcReq = (overrides: Record<string, unknown>) => ({
    protocolVersion: 1,
    ...overrides,
  });

  // 세션 A·B 수립.
  responses.push(
    await handshakeHandler(eventA, { protocolVersion: 1, clientId: clientA }),
  );
  responses.push(
    await handshakeHandler(eventB, { protocolVersion: 1, clientId: clientB }),
  );

  // A: RPC 성공.
  responses.push(
    await rpcHandler(
      eventA,
      rpcReq({
        clientId: clientA,
        requestId: "req-echo",
        key: "rpc:hardware/echo",
        input: `payload-${MARKER}`,
      }),
    ),
  );

  // A: 선언된 도메인 에러.
  responses.push(
    await rpcHandler(
      eventA,
      rpcReq({
        clientId: clientA,
        requestId: "req-connect",
        key: "rpc:hardware/connect",
        input: "device-1",
      }),
    ),
  );

  // A: 구독 생성 → 해제 (state).
  await server.controlStream(
    senderA,
    {
      protocolVersion: 1,
      clientId: clientA,
      type: "subscribe",
      subscriptionId: subId("a", 1),
      key: "state:hardware/current$",
    },
    (message) => streamMessages.push(message),
  );
  await server.controlStream(
    senderA,
    {
      protocolVersion: 1,
      clientId: clientA,
      type: "unsubscribe",
      subscriptionId: subId("a", 1),
    },
    (message) => streamMessages.push(message),
  );

  // A: 구독 생성 → overflow(error 정책)로 자동 해제 (event).
  await server.controlStream(
    senderA,
    {
      protocolVersion: 1,
      clientId: clientA,
      type: "subscribe",
      subscriptionId: subId("a", 2),
      key: "event:hardware/change$",
    },
    (message) => streamMessages.push(message),
  );
  events.next(1);
  events.next(2);
  events.next(3);
  events.next(4);
  const ackA2 = (sequence: number) =>
    server.controlStream(
      senderA,
      {
        protocolVersion: 1,
        clientId: clientA,
        type: "acknowledge",
        subscriptionId: subId("a", 2),
        sequence,
      },
      (message) => streamMessages.push(message),
    );
  await ackA2(1);
  await ackA2(2);
  await ackA2(3);

  // A: 한도 초과(rpc-limit) — maxConcurrentRpc: 1을 slow #1이 점유한 상태에서 slow #2 시도.
  const slow1 = rpcHandler(
    eventA,
    rpcReq({
      clientId: clientA,
      requestId: "req-slow-1",
      key: "rpc:hardware/slow",
      input: "a",
    }),
  );
  const slow2 = rpcHandler(
    eventA,
    rpcReq({
      clientId: clientA,
      requestId: "req-slow-2",
      key: "rpc:hardware/slow",
      input: "b",
    }),
  );
  responses.push(await slow2);
  resolvers[0]!(`slow-done-1-${MARKER}`);
  responses.push(await slow1);

  // A: deadline — maxRpcDurationMs 만료 후 handler가 나중에 끝난다.
  const slow3 = rpcHandler(
    eventA,
    rpcReq({
      clientId: clientA,
      requestId: "req-slow-3",
      key: "rpc:hardware/slow",
      input: "c",
    }),
  );
  await vi.advanceTimersByTimeAsync(5000);
  responses.push(await slow3);
  resolvers[1]!(`slow-done-3-${MARKER}`);
  await vi.advanceTimersByTimeAsync(0);

  // A: malformed envelope (control 채널 파싱 실패).
  ipcMain.emit(channels.control, eventA, {});

  // 잘못된 origin handshake (미부착 webContents).
  responses.push(
    await handshakeHandler(eventEvil, {
      protocolVersion: 1,
      clientId: `${MARKER}-evil-client`,
    }),
  );

  // B: 정상 RPC·구독 (구독은 활성 상태로 두어 detach 시 cascade close를 검증).
  responses.push(
    await rpcHandler(
      eventB,
      rpcReq({
        clientId: clientB,
        requestId: "req-echo-b",
        key: "rpc:hardware/echo",
        input: `payload-b-${MARKER}`,
      }),
    ),
  );
  await server.controlStream(
    senderB,
    {
      protocolVersion: 1,
      clientId: clientB,
      type: "subscribe",
      subscriptionId: subId("b", 1),
      key: "state:hardware/current$",
    },
    (message) => streamMessages.push(message),
  );

  // A navigate → session-closed. B detach → session-closed + 활성 구독 cascade close.
  contentsA.emit("did-start-navigation", {}, "app://local/next", false, true);
  detachB();

  const snapshotBeforeDispose = server.getDiagnosticsSnapshot();
  bridge.dispose();
  const snapshotAfterDispose = server.getDiagnosticsSnapshot();

  return {
    responses,
    streamMessages,
    records,
    snapshotBeforeDispose,
    snapshotAfterDispose,
  };
}

function hasErrorInstance(value: unknown, seen = new Set<unknown>()): boolean {
  if (value instanceof Error) return true;
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value))
    return value.some((item) => hasErrorInstance(item, seen));
  return Object.values(value).some((item) => hasErrorInstance(item, seen));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RD-007 진단 통합 시나리오", () => {
  test("이벤트 종류·개수, 기록 금지 항목, 스냅샷 복귀를 함께 검증한다", async () => {
    vi.useFakeTimers();
    const result = await runScenario("record");
    const { records } = result;

    const count = (type: BridgeDiagnostic["type"]) =>
      records.filter((r) => r.type === type).length;

    expect(count("session-opened")).toBe(2);
    expect(count("session-closed")).toBe(2);
    expect(count("subscription-opened")).toBe(3);
    expect(count("subscription-closed")).toBe(3);
    expect(count("rpc-timed-out")).toBe(1);

    const finished = records.filter(
      (r): r is Extract<BridgeDiagnostic, { type: "rpc-finished" }> =>
        r.type === "rpc-finished",
    );
    expect(finished).toHaveLength(5);
    expect(finished.filter((r) => r.outcome === "ok")).toHaveLength(3);
    expect(finished.filter((r) => r.outcome === "error")).toHaveLength(2);

    const rejected = records.filter(
      (r): r is Extract<BridgeDiagnostic, { type: "rejected" }> =>
        r.type === "rejected",
    );
    expect(rejected.filter((r) => r.reason === "rpc-limit")).toHaveLength(1);
    expect(
      rejected.filter((r) => r.reason === "malformed-envelope"),
    ).toHaveLength(1);
    // 미attach webContents(evilContents)의 disallowed origin handshake는
    // adapter 자체 origin 검사가 삭제돼(DELTA-03) 이제 attachment 부재로
    // sender-unauthorized가 된다(checklist 결정 13, F3).
    expect(
      rejected.filter((r) => r.reason === "sender-unauthorized"),
    ).toHaveLength(1);

    // 기록 금지 항목: payload·도메인 에러 message·origin·clientId·subscriptionId 표식이
    // 기록된 이벤트 어디에도 없다. Error 인스턴스도 없다.
    const serialized = JSON.stringify(records);
    expect(serialized.includes(MARKER)).toBe(false);
    expect(hasErrorInstance(records)).toBe(false);

    // 스냅샷: 해제가 끝난 시점에 네 값 모두 0, dispose 이후도 그대로.
    expect(result.snapshotBeforeDispose).toEqual({
      sessions: 0,
      rpcInFlight: 0,
      subscriptions: 0,
      queuedEvents: 0,
    });
    expect(result.snapshotAfterDispose).toEqual({
      sessions: 0,
      rpcInFlight: 0,
      subscriptions: 0,
      queuedEvents: 0,
    });
  });

  test("sink가 없거나 항상 throw해도 Renderer 응답·stream 메시지는 같다", async () => {
    vi.useFakeTimers();
    const recorded = await runScenario("record");

    vi.useFakeTimers();
    const consoleSpies = (
      ["log", "info", "warn", "error", "debug"] as const
    ).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const none = await runScenario("none");
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    for (const spy of consoleSpies) spy.mockRestore();

    vi.useFakeTimers();
    const thrown = await runScenario("throw");

    expect(none.responses).toEqual(recorded.responses);
    expect(none.streamMessages).toEqual(recorded.streamMessages);
    expect(thrown.responses).toEqual(recorded.responses);
    expect(thrown.streamMessages).toEqual(recorded.streamMessages);
  });
});
