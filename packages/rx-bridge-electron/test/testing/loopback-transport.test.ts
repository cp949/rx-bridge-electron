// DELTA-01(RD-020): `createLoopbackTransport`(test 전용 `./testing` subpath)를
// 검증한다. `BridgeTransport`의 두 번째 in-process adapter로, `structuredClone`
// 왕복·preload와 같은 parse 경계·microtask 순서·cancel 전달·dispose 후 동작·
// sender 분리·server throw 노출을 다룬다.
// 그릴링 결정(`_works/20260924-14-loopback-transport/checklist.md`) 3·4·5·6·8·
// 9·11·13·15와 계획 결정 P1·P2·P3·P5의 구현 확인이 목적이다.
import { BehaviorSubject, Subject, firstValueFrom } from "rxjs";
import { describe, expect, test } from "vitest";

import type { BridgeImpl } from "../../src/contract/index.js";
import {
  broadcastEvent,
  createBridgeServer,
  currentValueSource,
  type StreamBridgeServer,
} from "../../src/main/index.js";
import { createRendererApi } from "../../src/renderer/index.js";
import {
  BridgeProtocolError,
  type HandshakeResponse,
  type RpcResponse,
  type StreamMessage,
} from "../../src/protocol/index.js";
import { createLoopbackTransport } from "../../src/testing/index.js";

type EchoInput = { readonly text: string };
type EchoOutput = { readonly text: string };
type CountState = { readonly value: number };
type TickEvent = { readonly value: number };

type AppBridge = {
  device: {
    rpc: { echo(input: EchoInput): EchoOutput; wait(): string };
    state: { count: CountState };
    event: { tick: TickEvent };
  };
};

/**
 * 매 test가 쓰는 최소 impl 하나. RPC echo·State count·Event tick 셋과, 취소될
 * 때까지 끝나지 않는 RPC wait를 노출한다(`waitAborted`로 server 쪽 abort 확인).
 */
function buildImpl(): {
  readonly impl: BridgeImpl<AppBridge>;
  readonly countSource: BehaviorSubject<CountState>;
  readonly tickEvents: Subject<TickEvent>;
  readonly waitAborted: () => boolean;
} {
  const countSource = new BehaviorSubject<CountState>({ value: 0 });
  const tickEvents = new Subject<TickEvent>();
  let aborted = false;
  const impl: BridgeImpl<AppBridge> = {
    device: {
      rpc: {
        echo: (input) => ({ text: input.text }),
        wait: (_input, context) =>
          new Promise<string>((_resolve, reject) => {
            context.signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }),
      },
      state: { count: currentValueSource(countSource) },
      event: { tick: broadcastEvent(tickEvents) },
    },
  };
  return { impl, countSource, tickEvents, waitAborted: () => aborted };
}

/** 큐에 쌓인 microtask를 모두 비운다(macrotask 경계까지 진행). */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** `handshake`·`dispatchRpc`가 던지도록 감싼 최소 서버 stub — 폴백 부재 확인용. */
function throwingServer(): StreamBridgeServer {
  return {
    attach: () => () => {},
    handshake: () => {
      throw new Error("boom-handshake");
    },
    dispatchRpc: async () => {
      throw new Error("boom-rpc");
    },
    cancel: () => {},
    controlStream: async () => {},
    dispose: () => {},
    getDiagnosticsSnapshot: () => ({
      sessions: 0,
      rpcInFlight: 0,
      subscriptions: 0,
      queuedEvents: 0,
    }),
  };
}

class Point {
  public constructor(
    public readonly x: number,
    public readonly y: number,
  ) {}
}

/**
 * RPC 결과로 class 인스턴스를 직접 돌려주는 stub 서버 — 실제
 * `createBridgeServer`의 `parseOutput`은 non-plain prototype을 거부하므로,
 * loopback 자신의 `structuredClone` 단계만 분리해서 확인한다.
 */
function classInstanceServer(): StreamBridgeServer {
  return {
    attach: () => () => {},
    handshake: (): HandshakeResponse => ({
      protocolVersion: 1,
      clientId: "loopback-client",
      manifest: { rpc: [], state: [], event: [] },
    }),
    dispatchRpc: async (_sender, value): Promise<RpcResponse> => {
      const request = value as { readonly requestId: string };
      return {
        protocolVersion: 1,
        clientId: "loopback-client",
        type: "success",
        requestId: request.requestId,
        result: new Point(1, 2),
      } as unknown as RpcResponse;
    },
    cancel: () => {},
    controlStream: async () => {},
    dispose: () => {},
    getDiagnosticsSnapshot: () => ({
      sessions: 0,
      rpcInFlight: 0,
      subscriptions: 0,
      queuedEvents: 0,
    }),
  };
}

describe("createLoopbackTransport: createRendererApi 결합", () => {
  test("RPC 성공·State 구독·Event 수신이 타입 붙은 api로 동작한다", async () => {
    const { impl, tickEvents } = buildImpl();
    const server = createBridgeServer(impl);
    const transport = createLoopbackTransport(server);
    const api = await createRendererApi<AppBridge>({ transport });

    await expect(api.device.rpc.echo({ text: "hi" })).resolves.toEqual({
      text: "hi",
    });

    const stateValues: CountState[] = [];
    const stateSub = api.device.state.count.subscribe((value) =>
      stateValues.push(value),
    );
    await flushMicrotasks();
    expect(stateValues).toEqual([{ value: 0 }]);
    stateSub.unsubscribe();

    const eventValues: TickEvent[] = [];
    const eventSub = api.device.event.tick.subscribe((value) =>
      eventValues.push(value),
    );
    await flushMicrotasks();
    tickEvents.next({ value: 7 });
    await flushMicrotasks();
    expect(eventValues).toEqual([{ value: 7 }]);
    eventSub.unsubscribe();

    api.dispose();
    transport.dispose();
  });

  test("State snapshot을 firstValueFrom으로도 왕복한다", async () => {
    const { impl } = buildImpl();
    const server = createBridgeServer(impl);
    const transport = createLoopbackTransport(server);
    const api = await createRendererApi<AppBridge>({ transport });

    await expect(firstValueFrom(api.device.state.count)).resolves.toEqual({
      value: 0,
    });

    api.dispose();
    transport.dispose();
  });
});

describe("createLoopbackTransport: parse·clone 경계", () => {
  test("함수가 포함된 RPC input은 preload처럼 server 도달 전에 reject된다", async () => {
    const { impl } = buildImpl();
    const server = createBridgeServer(impl);
    const transport = createLoopbackTransport(server);

    await expect(
      transport.invoke({
        requestId: "req-1",
        key: "rpc:device/echo",
        input: { fn: () => {} } as unknown as EchoInput,
      }),
    ).rejects.toBeInstanceOf(BridgeProtocolError);
    expect(server.getDiagnosticsSnapshot().rpcInFlight).toBe(0);

    transport.dispose();
  });

  test("잘못된 stream command는 preload처럼 control() 호출 시점에 동기로 throw한다", async () => {
    const { impl } = buildImpl();
    const transport = createLoopbackTransport(createBridgeServer(impl));

    expect(() =>
      transport.control({
        type: "subscribe",
        subscriptionId: "",
        key: "state:device/count",
      }),
    ).toThrow(BridgeProtocolError);

    transport.dispose();
  });

  test("handshake 거부 응답은 HandshakeResponse로 넘기지 않고 reject한다", async () => {
    const { impl } = buildImpl();
    const server = createBridgeServer(impl);
    const first = createLoopbackTransport(server);
    await first.connect();
    first.dispose();

    // 같은 webContentsId·clientId는 retire됐다(TRP-006) — server가 거부 응답을 낸다.
    const second = createLoopbackTransport(server);
    await expect(second.connect()).rejects.toBeInstanceOf(BridgeProtocolError);
    await expect(
      createRendererApi<AppBridge>({ transport: second }),
    ).rejects.toMatchObject({
      code: "INTERNAL",
      message: "Bridge handshake failed.",
    });

    second.dispose();
  });

  test("handler가 반환한 class 인스턴스는 loopback의 clone을 거쳐 plain object로 도착한다", async () => {
    const transport = createLoopbackTransport(classInstanceServer());

    const response = await transport.invoke({
      requestId: "req-1",
      key: "rpc:device/echo",
      input: undefined,
    });

    expect(response).toMatchObject({ type: "success", result: { x: 1, y: 2 } });
    if (response.type === "success") {
      expect(Object.getPrototypeOf(response.result)).toBe(Object.prototype);
    }

    transport.dispose();
  });
});

describe("createLoopbackTransport: microtask 순서", () => {
  test("control(subscribe) 반환 전에는 listener가 호출되지 않고, microtask flush 후 subscribed가 도착한다", async () => {
    const { impl } = buildImpl();
    const server = createBridgeServer(impl);
    const transport = createLoopbackTransport(server);
    await transport.connect();

    const messages: StreamMessage[] = [];
    transport.onStreamMessage((message) => messages.push(message));

    transport.control({
      type: "subscribe",
      subscriptionId: "test:subscription:1",
      key: "state:device/count",
    });
    expect(messages).toEqual([]);

    await flushMicrotasks();
    expect(messages.map((message) => message.type)).toContain("subscribed");

    transport.dispose();
  });
});

describe("createLoopbackTransport: cancel", () => {
  test("AbortSignal 취소가 microtask 뒤 server의 in-flight RPC를 abort한다", async () => {
    const { impl, waitAborted } = buildImpl();
    const server = createBridgeServer(impl);
    const transport = createLoopbackTransport(server);
    const api = await createRendererApi<AppBridge>({ transport });

    const controller = new AbortController();
    const pending = api.device.rpc.wait(undefined, {
      signal: controller.signal,
    });
    await flushMicrotasks();
    expect(server.getDiagnosticsSnapshot().rpcInFlight).toBe(1);

    controller.abort();
    expect(waitAborted()).toBe(false);
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await flushMicrotasks();
    expect(waitAborted()).toBe(true);
    expect(server.getDiagnosticsSnapshot().rpcInFlight).toBe(0);

    api.dispose();
    transport.dispose();
  });
});

describe("createLoopbackTransport: dispose", () => {
  test("dispose 후 invoke·connect는 reject되고, 반복 호출해도 안전하다", async () => {
    const { impl } = buildImpl();
    const server = createBridgeServer(impl);
    const transport = createLoopbackTransport(server);
    await transport.connect();
    transport.dispose();
    expect(() => transport.dispose()).not.toThrow();

    await expect(transport.connect()).rejects.toThrow();
    await expect(
      transport.invoke({
        requestId: "req-1",
        key: "rpc:device/echo",
        input: { text: "x" },
      }),
    ).rejects.toThrow();
  });

  test("dispose 후 control은 server에 닿지 않고, 이미 예약된 stream 메시지도 전달하지 않는다", async () => {
    const { impl } = buildImpl();
    const server = createBridgeServer(impl);
    const transport = createLoopbackTransport(server);
    await transport.connect();
    const messages: StreamMessage[] = [];
    transport.onStreamMessage((message) => messages.push(message));

    transport.control({
      type: "subscribe",
      subscriptionId: "test:subscription:1",
      key: "state:device/count",
    });
    transport.dispose();
    await flushMicrotasks();
    expect(messages).toEqual([]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);

    expect(() => {
      transport.control({
        type: "subscribe",
        subscriptionId: "test:subscription:2",
        key: "state:device/count",
      });
      transport.cancel("req-1");
    }).not.toThrow();
    await flushMicrotasks();
    expect(messages).toEqual([]);
  });

  test("dispose 후에도 server는 살아 있어, 같은 server에 새 loopback을 만들면 RPC가 성공한다", async () => {
    const { impl } = buildImpl();
    const server = createBridgeServer(impl);
    const first = createLoopbackTransport(server);
    await first.connect();
    first.dispose();

    // 같은 webContentsId로 재접속하되 다른 clientId를 쓴다 — 첫 client는 이미
    // retire됐고(`DocumentSessions#establish`), 같은 clientId 재사용은 설계상
    // `sender-unauthorized`로 거부된다.
    const second = createLoopbackTransport(server, {
      clientId: "loopback-client-2",
    });
    await second.connect();
    await expect(
      second.invoke({
        requestId: "req-1",
        key: "rpc:device/echo",
        input: { text: "y" },
      }),
    ).resolves.toMatchObject({ type: "success", result: { text: "y" } });

    second.dispose();
  });
});

describe("createLoopbackTransport: sender 분리", () => {
  test("서로 다른 sender.webContentsId를 가진 transport 2개는 각자 세션을 갖는다", async () => {
    const { impl } = buildImpl();
    const server = createBridgeServer(impl);
    const first = createLoopbackTransport(server, {
      sender: { webContentsId: 1 },
      clientId: "loopback-client-1",
    });
    const second = createLoopbackTransport(server, {
      sender: { webContentsId: 2 },
      clientId: "loopback-client-2",
    });

    await first.connect();
    await second.connect();
    expect(server.getDiagnosticsSnapshot().sessions).toBe(2);

    first.dispose();
    expect(server.getDiagnosticsSnapshot().sessions).toBe(1);

    second.dispose();
    expect(server.getDiagnosticsSnapshot().sessions).toBe(0);
  });
});

describe("createLoopbackTransport: server throw 노출", () => {
  test("server가 throw하면 loopback이 폴백 없이 그대로 전파한다", async () => {
    const transport = createLoopbackTransport(throwingServer());

    await expect(transport.connect()).rejects.toThrow("boom-handshake");
    await expect(
      transport.invoke({
        requestId: "req-1",
        key: "rpc:device/echo",
        input: undefined,
      }),
    ).rejects.toThrow("boom-rpc");

    transport.dispose();
  });
});

describe("createLoopbackTransport: role 옵션", () => {
  test("options.role이 authorize context의 windowRole로 전달된다", async () => {
    const { impl } = buildImpl();
    const windowRoles: string[] = [];
    const server = createBridgeServer(impl, {
      authorize: (context) => {
        windowRoles.push(context.windowRole);
        return true;
      },
    });
    const transport = createLoopbackTransport(server, { role: "monitor" });
    await transport.connect();

    await transport.invoke({
      requestId: "req-1",
      key: "rpc:device/echo",
      input: { text: "x" },
    });

    expect(windowRoles).toEqual(["monitor"]);
    transport.dispose();
  });
});
