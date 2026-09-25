import { describe, expect, test, vi } from "vitest";
import type { IpcMain, WebContents } from "electron";
import { BehaviorSubject } from "rxjs";

import type { BridgeImpl, Schema } from "../../src/contract/index.js";
import { BridgeProtocolError } from "../../src/protocol/index.js";
import type { BridgeValue } from "../../src/protocol/index.js";
import {
  FakeIpcMain,
  FakeTarget,
  FakeWebContents,
  sender,
} from "./fake-ipc.js";
import { testSubscriptionId } from "./subscription-ids.js";
import {
  bindElectronBridge,
  createBridgeServer,
  currentValueSource,
  DEFAULT_ELECTRON_BRIDGE_NAMESPACE,
  ELECTRON_BRIDGE_CHANNELS,
  type BridgeContext,
  type BridgeDiagnostic,
} from "../../src/main/index.js";

type WaitBridge = { hardware: { rpc: { wait(): undefined } } };
const waitImpl: BridgeImpl<WaitBridge> = {
  hardware: { rpc: { wait: async () => undefined } },
};

function makeBridge(ipcMain: FakeIpcMain) {
  const server = createBridgeServer(waitImpl);
  const bridge = bindElectronBridge({
    ipcMain: ipcMain as unknown as IpcMain,
    server,
    namespace: "test",
    allowedOrigins: ["app://local"],
  });
  return { server, bridge };
}

describe("bindElectronBridge dispose", () => {
  test("dispose 뒤에도 자기 handler·listener를 남기고 외부 listener를 건드리지 않는다", () => {
    const ipcMain = new FakeIpcMain();
    const channels = ELECTRON_BRIDGE_CHANNELS("test");
    const externalCancel = () => {};
    const externalControl = () => {};
    ipcMain.on(channels.cancel, externalCancel);
    ipcMain.on(channels.control, externalControl);

    const { bridge } = makeBridge(ipcMain);
    bridge.dispose();

    expect(ipcMain.listenerCount(channels.cancel)).toBe(2);
    expect(ipcMain.listeners(channels.cancel)[0]).toBe(externalCancel);
    expect(ipcMain.listenerCount(channels.control)).toBe(2);
    expect(ipcMain.listeners(channels.control)[0]).toBe(externalControl);
    expect(ipcMain.handlers.has(channels.handshake)).toBe(true);
    expect(ipcMain.handlers.has(channels.rpc)).toBe(true);
  });

  test("is idempotent and disposes the underlying server exactly once", () => {
    const ipcMain = new FakeIpcMain();
    const { server, bridge } = makeBridge(ipcMain);
    const disposeSpy = vi.spyOn(server, "dispose");

    expect(() => {
      bridge.dispose();
      bridge.dispose();
    }).not.toThrow();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("rejects attach after dispose", () => {
    const ipcMain = new FakeIpcMain();
    const { bridge } = makeBridge(ipcMain);
    bridge.dispose();

    const contents = new FakeWebContents();
    let error: unknown;
    try {
      bridge.attach(contents as unknown as WebContents, "main");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BridgeProtocolError);
    expect((error as BridgeProtocolError).code).toBe("FORBIDDEN");
    expect((error as BridgeProtocolError).message).toBe(
      "Electron bridge is disposed.",
    );
  });

  test("removes attached WebContents lifecycle listeners", () => {
    const ipcMain = new FakeIpcMain();
    const { bridge } = makeBridge(ipcMain);
    const contents = new FakeWebContents();
    bridge.attach(contents as unknown as WebContents, "main");

    expect(contents.listenerCount("did-navigate")).toBeGreaterThan(0);
    expect(contents.listenerCount("did-fail-load")).toBeGreaterThan(0);

    bridge.dispose();

    expect(contents.listenerCount("did-navigate")).toBe(0);
    expect(contents.listenerCount("did-fail-load")).toBe(0);
    expect(contents.listenerCount("render-process-gone")).toBe(0);
    expect(contents.listenerCount("destroyed")).toBe(0);
  });

  test("stale detach from a replaced attach keeps the newer attachment registered", () => {
    const ipcMain = new FakeIpcMain();
    const { server, bridge } = makeBridge(ipcMain);
    const serverDetaches: Array<ReturnType<typeof vi.fn>> = [];
    const attach = server.attach.bind(server);
    vi.spyOn(server, "attach").mockImplementation((target) => {
      const detach = vi.fn(attach(target));
      serverDetaches.push(detach);
      return detach;
    });
    const contents = new FakeWebContents() as unknown as WebContents;

    const closeFirst = bridge.attach(contents, "main");
    bridge.attach(contents, "main");
    closeFirst();

    const second = serverDetaches[1]!;
    const callsBeforeDispose = second.mock.calls.length;
    bridge.dispose();

    expect(callsBeforeDispose).toBe(0);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

/*
 * bind `dispose()` 뒤 요청 거부와 같은 namespace 재bind 인수(ADR 0026).
 * dispose된 bind는 IPC handler·listener를 남겨 폐기된 server가 기존 거부
 * 경로로 응답하고, 같은 `ipcMain`·namespace의 새 bind가 그 listener를 인수한다.
 */
describe("bind dispose 뒤 요청 거부와 재bind 인수", () => {
  type StatusBridge = {
    device: {
      rpc: { ping(input: string): string };
      state: { status: string };
    };
  };

  /** 새 server와 bind를 만든다. 두 번째 bind 비교용으로 server를 따로 돌려준다. */
  function bindStatus(ipcMain: FakeIpcMain, namespace = "test") {
    const impl: BridgeImpl<StatusBridge> = {
      device: {
        rpc: { ping: (input) => `pong:${input}` },
        state: { status: currentValueSource(new BehaviorSubject("ready")) },
      },
    };
    const server = createBridgeServer(impl);
    const bridge = bindElectronBridge({
      ipcMain: ipcMain as unknown as IpcMain,
      server,
      namespace,
      allowedOrigins: ["app://local"],
    });
    return { server, bridge };
  }

  /** stream 전송을 받는 main frame을 가진 문서. `isMainFrame`은 frame 동일성으로 판정한다. */
  function documentWithStream(id = 1) {
    const contents = new FakeWebContents(id);
    const send = vi.fn<(channel: string, message: unknown) => void>();
    Object.assign(contents.mainFrame, { send });
    const event = { sender: contents, senderFrame: contents.mainFrame };
    return { contents, send, event };
  }

  async function handshake(
    ipcMain: FakeIpcMain,
    event: unknown,
    clientId: string,
  ) {
    return ipcMain.handlers.get(ELECTRON_BRIDGE_CHANNELS("test").handshake)!(
      event,
      { protocolVersion: 1, clientId },
    );
  }

  function ping(ipcMain: FakeIpcMain, event: unknown, clientId: string) {
    return ipcMain.handlers.get(ELECTRON_BRIDGE_CHANNELS("test").rpc)!(event, {
      protocolVersion: 1,
      clientId,
      requestId: "request-1",
      key: "rpc:device/ping",
      input: "x",
    });
  }

  function subscribeStatus(
    ipcMain: FakeIpcMain,
    event: unknown,
    clientId: string,
    n: number,
  ) {
    ipcMain.emit(ELECTRON_BRIDGE_CHANNELS("test").control, event, {
      protocolVersion: 1,
      clientId,
      type: "subscribe",
      subscriptionId: testSubscriptionId(n),
      key: "state:device/status",
    });
  }

  function streamMessages(send: ReturnType<typeof vi.fn>) {
    return send.mock.calls.map(([, message]) => message);
  }

  test("dispose 뒤 새 구독은 subscribed 뒤 error FORBIDDEN으로 끝난다", async () => {
    const ipcMain = new FakeIpcMain();
    const { bridge } = bindStatus(ipcMain);
    const doc = documentWithStream();
    bridge.attach(doc.contents as unknown as WebContents, "main");
    await handshake(ipcMain, doc.event, "client-1");

    bridge.dispose();
    subscribeStatus(ipcMain, doc.event, "client-1", 1);

    await vi.waitFor(() =>
      expect(streamMessages(doc.send)).toEqual([
        expect.objectContaining({
          type: "subscribed",
          subscriptionId: testSubscriptionId(1),
        }),
        expect.objectContaining({
          type: "error",
          subscriptionId: testSubscriptionId(1),
          error: {
            code: "FORBIDDEN",
            message: "Bridge sender is not authorized.",
          },
        }),
      ]),
    );
  });

  test("dispose 뒤 RPC는 FORBIDDEN, handshake는 INVALID_ARGUMENT 응답을 받는다", async () => {
    const ipcMain = new FakeIpcMain();
    const { bridge } = bindStatus(ipcMain);
    const doc = documentWithStream();
    bridge.attach(doc.contents as unknown as WebContents, "main");
    await handshake(ipcMain, doc.event, "client-1");

    bridge.dispose();

    await expect(ping(ipcMain, doc.event, "client-1")).resolves.toMatchObject({
      type: "error",
      error: { code: "FORBIDDEN", message: "Bridge sender is not authorized." },
    });
    await expect(
      handshake(ipcMain, doc.event, "client-2"),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "INVALID_ARGUMENT", message: "Invalid bridge request." },
    });
  });

  test("같은 namespace로 다시 bind하면 폐기된 bind의 handler·listener를 인수한다", async () => {
    const ipcMain = new FakeIpcMain();
    const channels = ELECTRON_BRIDGE_CHANNELS("test");
    const externalControl = () => {};
    ipcMain.on(channels.control, externalControl);
    const first = bindStatus(ipcMain);
    const firstControl = vi.spyOn(first.server, "controlStream");
    first.bridge.dispose();

    const second = bindStatus(ipcMain);
    const doc = documentWithStream();
    second.bridge.attach(doc.contents as unknown as WebContents, "main");

    expect(ipcMain.listeners(channels.control)).toHaveLength(2);
    expect(ipcMain.listeners(channels.control)[0]).toBe(externalControl);
    expect(ipcMain.listenerCount(channels.cancel)).toBe(1);
    await expect(
      handshake(ipcMain, doc.event, "client-1"),
    ).resolves.toMatchObject({ manifest: expect.any(Object) });
    await expect(ping(ipcMain, doc.event, "client-1")).resolves.toMatchObject({
      type: "success",
      result: "pong:x",
    });
    subscribeStatus(ipcMain, doc.event, "client-1", 1);
    await vi.waitFor(() =>
      expect(streamMessages(doc.send)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "subscribed" }),
          expect.objectContaining({ type: "batch", values: ["ready"] }),
        ]),
      ),
    );
    expect(firstControl).not.toHaveBeenCalled();
    expect(streamMessages(doc.send)).not.toContainEqual(
      expect.objectContaining({ type: "error" }),
    );
  });

  test("활성 bind가 있는 채 같은 namespace로 bind하면 throw한다", () => {
    const ipcMain = new FakeIpcMain();
    bindStatus(ipcMain);

    expect(() => bindStatus(ipcMain)).toThrow(
      "Attempted to register a second handler for 'rx-bridge-electron:v1:test:handshake'",
    );
  });

  test("다른 namespace bind는 폐기된 bind의 handler·listener를 지우지 않는다", () => {
    const ipcMain = new FakeIpcMain();
    const channels = ELECTRON_BRIDGE_CHANNELS("test");
    const first = bindStatus(ipcMain);
    first.bridge.dispose();

    bindStatus(ipcMain, "other");

    expect(ipcMain.handlers.has(channels.handshake)).toBe(true);
    expect(ipcMain.handlers.has(channels.rpc)).toBe(true);
    expect(ipcMain.listenerCount(channels.cancel)).toBe(1);
    expect(ipcMain.listenerCount(channels.control)).toBe(1);
  });
});

describe("Electron adapter navigation commit retire", () => {
  function makeSessionBridge(ipcMain: FakeIpcMain) {
    const diagnostics = { record: vi.fn<(event: BridgeDiagnostic) => void>() };
    const server = createBridgeServer(waitImpl, { diagnostics });
    const bridge = bindElectronBridge({
      ipcMain: ipcMain as unknown as IpcMain,
      server,
      namespace: "test",
      allowedOrigins: ["app://local"],
    });
    return { server, bridge, diagnostics };
  }

  function sessionClosedCount(diagnostics: {
    record: ReturnType<typeof vi.fn>;
  }) {
    return diagnostics.record.mock.calls.filter(
      ([event]) => (event as BridgeDiagnostic).type === "session-closed",
    ).length;
  }

  async function establish(
    ipcMain: FakeIpcMain,
    contents: FakeWebContents,
    clientId: string,
  ) {
    const handshakeHandler = ipcMain.handlers.get(
      ELECTRON_BRIDGE_CHANNELS("test").handshake,
    )!;
    const response = await handshakeHandler(
      { sender: contents, senderFrame: contents.mainFrame },
      { protocolVersion: 1, clientId },
    );
    expect(response).toMatchObject({ manifest: expect.any(Object) });
  }

  test("did-start-navigation no longer retires the session (main frame, isInPlace true)", async () => {
    const ipcMain = new FakeIpcMain();
    const { bridge, diagnostics } = makeSessionBridge(ipcMain);
    const contents = new FakeWebContents();
    bridge.attach(contents as unknown as WebContents, "main");
    await establish(ipcMain, contents, "client-1");

    contents.emit(
      "did-start-navigation",
      {},
      "app://local/#/other",
      true,
      true,
    );

    expect(sessionClosedCount(diagnostics)).toBe(0);
  });

  test("did-start-navigation no longer retires the session (main frame, isInPlace false)", async () => {
    const ipcMain = new FakeIpcMain();
    const { bridge, diagnostics } = makeSessionBridge(ipcMain);
    const contents = new FakeWebContents();
    bridge.attach(contents as unknown as WebContents, "main");
    await establish(ipcMain, contents, "client-1");

    contents.emit("did-start-navigation", {}, "app://local/next", false, true);

    expect(sessionClosedCount(diagnostics)).toBe(0);
  });

  test("did-navigate retires the session", async () => {
    const ipcMain = new FakeIpcMain();
    const { bridge, diagnostics } = makeSessionBridge(ipcMain);
    const contents = new FakeWebContents();
    bridge.attach(contents as unknown as WebContents, "main");
    await establish(ipcMain, contents, "client-1");

    contents.emit("did-navigate", {}, "app://local/next", 200, "OK");

    expect(sessionClosedCount(diagnostics)).toBe(1);
  });

  test("did-fail-load on the main frame with the current routingId retires the session", async () => {
    const ipcMain = new FakeIpcMain();
    const { bridge, diagnostics } = makeSessionBridge(ipcMain);
    const contents = new FakeWebContents();
    bridge.attach(contents as unknown as WebContents, "main");
    await establish(ipcMain, contents, "client-1");

    contents.emit(
      "did-fail-load",
      {},
      -102,
      "ERR_CONNECTION_REFUSED",
      "app://local/next",
      true,
      1,
      contents.mainFrame.routingId,
    );

    expect(sessionClosedCount(diagnostics)).toBe(1);
  });

  test("did-fail-load with a stale/undefined frameRoutingId does not retire the session", async () => {
    const ipcMain = new FakeIpcMain();
    const { bridge, diagnostics } = makeSessionBridge(ipcMain);
    const contents = new FakeWebContents();
    bridge.attach(contents as unknown as WebContents, "main");
    await establish(ipcMain, contents, "client-1");

    // 문서가 안 바뀐 취소(ERR_ABORTED)를 흉내 낸다: frameRoutingId가 현재
    // main frame routingId와 다르거나 undefined다.
    contents.emit(
      "did-fail-load",
      {},
      -3,
      "ERR_ABORTED",
      "app://local/next",
      true,
      1,
      contents.mainFrame.routingId + 1,
    );
    contents.emit(
      "did-fail-load",
      {},
      -3,
      "ERR_ABORTED",
      "app://local/next",
      true,
      1,
      undefined,
    );

    expect(sessionClosedCount(diagnostics)).toBe(0);
  });

  test("did-fail-load on a subframe does not retire the session", async () => {
    const ipcMain = new FakeIpcMain();
    const { bridge, diagnostics } = makeSessionBridge(ipcMain);
    const contents = new FakeWebContents();
    bridge.attach(contents as unknown as WebContents, "main");
    await establish(ipcMain, contents, "client-1");

    contents.emit(
      "did-fail-load",
      {},
      -102,
      "ERR_CONNECTION_REFUSED",
      "app://local/frame",
      false,
      1,
      999,
    );

    expect(sessionClosedCount(diagnostics)).toBe(0);
  });

  test("did-navigate-in-page (same-document) has no listener and does not retire the session", async () => {
    const ipcMain = new FakeIpcMain();
    const { bridge, diagnostics } = makeSessionBridge(ipcMain);
    const contents = new FakeWebContents();
    bridge.attach(contents as unknown as WebContents, "main");
    await establish(ipcMain, contents, "client-1");

    expect(contents.listenerCount("did-navigate-in-page")).toBe(0);
    contents.emit(
      "did-navigate-in-page",
      {},
      "app://local/#/other",
      true,
      true,
    );

    expect(sessionClosedCount(diagnostics)).toBe(0);
  });
});

describe("Electron adapter payload limits", () => {
  test("forwards input past the adapter's structural check up to the contract's larger maxStringBytes", async () => {
    const stringSchema: Schema<string> = {
      parse(input) {
        if (typeof input !== "string") throw new TypeError("string required");
        return input;
      },
    };
    type EchoBridge = { hardware: { rpc: { echo(input: string): string } } };
    const handler = vi.fn(async (input: string) => input);
    const echoImpl: BridgeImpl<EchoBridge> = {
      hardware: { rpc: { echo: handler } },
    };
    const server = createBridgeServer(echoImpl, {
      payloadLimits: { maxDepth: 4, maxEntries: 10, maxStringBytes: 2_000_000 },
      schemas: {
        hardware: {
          rpc: { echo: { input: stringSchema, output: stringSchema } },
        },
      },
    });
    const ipcMain = new FakeIpcMain();
    const bridge = bindElectronBridge({
      ipcMain: ipcMain as unknown as IpcMain,
      server,
      namespace: "test",
      allowedOrigins: ["app://local"],
    });
    const contents = new FakeWebContents();
    bridge.attach(contents as unknown as WebContents, "main");

    const rpcHandler = ipcMain.handlers.get(
      ELECTRON_BRIDGE_CHANNELS("test").rpc,
    );
    if (rpcHandler === undefined) throw new Error("expected rpc handler");
    const bigString = "a".repeat(1_500_000);
    const response = await rpcHandler(
      { sender: contents, senderFrame: contents.mainFrame },
      {
        protocolVersion: 1,
        clientId: "client-1",
        requestId: "request-1",
        key: "rpc:hardware/echo",
        input: bigString,
      },
    );

    expect(response).toMatchObject({ type: "success", result: bigString });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

function makeDiagnosticsBridge(ipcMain: FakeIpcMain) {
  const diagnostics = { record: vi.fn<(event: BridgeDiagnostic) => void>() };
  const server = createBridgeServer(waitImpl, { diagnostics });
  const bridge = bindElectronBridge({
    ipcMain: ipcMain as unknown as IpcMain,
    server,
    namespace: "test",
    allowedOrigins: ["app://local"],
  });
  return { server, bridge, diagnostics };
}

function rejections(diagnostics: { record: ReturnType<typeof vi.fn> }) {
  return diagnostics.record.mock.calls
    .map(([event]) => event as BridgeDiagnostic)
    .filter(
      (event): event is Extract<BridgeDiagnostic, { type: "rejected" }> =>
        event.type === "rejected",
    );
}

describe("Electron adapter rejection diagnostics", () => {
  test("frame-not-main: senderFrame is not the attached WebContents' main frame", async () => {
    const ipcMain = new FakeIpcMain();
    const { bridge, diagnostics } = makeDiagnosticsBridge(ipcMain);
    const contents = new FakeWebContents();
    bridge.attach(contents as unknown as WebContents, "main");

    const handshakeHandler = ipcMain.handlers.get(
      ELECTRON_BRIDGE_CHANNELS("test").handshake,
    )!;
    const response = await handshakeHandler(
      { sender: contents, senderFrame: { routingId: 999, url: "app://local" } },
      { protocolVersion: 1, clientId: "client-1" },
    );

    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "frame-not-main" },
    ]);
    expect(response).toMatchObject({ type: "error" });
  });

  test("origin-not-allowed: main frame with a disallowed origin", async () => {
    const ipcMain = new FakeIpcMain();
    const { bridge, diagnostics } = makeDiagnosticsBridge(ipcMain);
    const contents = new FakeWebContents(1, 10, "app://evil");
    bridge.attach(contents as unknown as WebContents, "main");

    const handshakeHandler = ipcMain.handlers.get(
      ELECTRON_BRIDGE_CHANNELS("test").handshake,
    )!;
    const response = await handshakeHandler(
      { sender: contents, senderFrame: contents.mainFrame },
      { protocolVersion: 1, clientId: "client-1" },
    );

    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "origin-not-allowed" },
    ]);
    expect(response).toMatchObject({ type: "error" });
  });

  test("malformed-envelope: handshake parse failure", async () => {
    const ipcMain = new FakeIpcMain();
    const { diagnostics } = makeDiagnosticsBridge(ipcMain);
    const contents = new FakeWebContents();

    const handshakeHandler = ipcMain.handlers.get(
      ELECTRON_BRIDGE_CHANNELS("test").handshake,
    )!;
    const response = await handshakeHandler(
      { sender: contents, senderFrame: contents.mainFrame },
      {},
    );

    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "malformed-envelope" },
    ]);
    expect(response).toMatchObject({ type: "error" });
  });

  test("malformed-envelope: rpc parse failure", async () => {
    const ipcMain = new FakeIpcMain();
    const { diagnostics } = makeDiagnosticsBridge(ipcMain);
    const contents = new FakeWebContents();

    const rpcHandler = ipcMain.handlers.get(
      ELECTRON_BRIDGE_CHANNELS("test").rpc,
    )!;
    const response = await rpcHandler(
      { sender: contents, senderFrame: contents.mainFrame },
      {},
    );

    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "malformed-envelope" },
    ]);
    expect(response).toMatchObject({ type: "error" });
  });

  test("malformed-envelope: cancel parse failure", () => {
    const ipcMain = new FakeIpcMain();
    const { diagnostics } = makeDiagnosticsBridge(ipcMain);
    const contents = new FakeWebContents();

    ipcMain.emit(
      ELECTRON_BRIDGE_CHANNELS("test").cancel,
      { sender: contents, senderFrame: contents.mainFrame },
      {},
    );

    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "malformed-envelope" },
    ]);
  });

  test("malformed-envelope: control parse failure", () => {
    const ipcMain = new FakeIpcMain();
    const { diagnostics } = makeDiagnosticsBridge(ipcMain);
    const contents = new FakeWebContents();

    ipcMain.emit(
      ELECTRON_BRIDGE_CHANNELS("test").control,
      { sender: contents, senderFrame: contents.mainFrame },
      {},
    );

    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "malformed-envelope" },
    ]);
  });

  test("a server-side handshake rejection (unattached webContents) is recorded exactly once", async () => {
    const ipcMain = new FakeIpcMain();
    const { diagnostics } = makeDiagnosticsBridge(ipcMain);
    const contents = new FakeWebContents();
    // Intentionally not attached: session establish fails on the server side.

    const handshakeHandler = ipcMain.handlers.get(
      ELECTRON_BRIDGE_CHANNELS("test").handshake,
    )!;
    const response = await handshakeHandler(
      { sender: contents, senderFrame: contents.mainFrame },
      { protocolVersion: 1, clientId: "client-1" },
    );

    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "sender-unauthorized" },
    ]);
    expect(response).toMatchObject({ type: "error" });
  });

  test("an RPC authorize() exception is not recorded and returns INTERNAL instead of protocolError", async () => {
    const ipcMain = new FakeIpcMain();
    const diagnostics = { record: vi.fn<(event: BridgeDiagnostic) => void>() };
    const server = createBridgeServer(waitImpl, {
      diagnostics,
      authorize: () => {
        throw new Error("boom");
      },
    });
    const bridge = bindElectronBridge({
      ipcMain: ipcMain as unknown as IpcMain,
      server,
      namespace: "test",
      allowedOrigins: ["app://local"],
    });
    const contents = new FakeWebContents();
    bridge.attach(contents as unknown as WebContents, "main");

    const rpcHandler = ipcMain.handlers.get(
      ELECTRON_BRIDGE_CHANNELS("test").rpc,
    )!;
    const response = await rpcHandler(
      { sender: contents, senderFrame: contents.mainFrame },
      {
        protocolVersion: 1,
        clientId: "client-1",
        requestId: "request-1",
        key: "rpc:hardware/wait",
        input: undefined,
      },
    );

    expect(rejections(diagnostics)).toEqual([]);
    expect(response).toMatchObject({
      requestId: "request-1",
      type: "error",
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
  });

  // envelope parse(version 포함)는 server가 소유한다(ADR 0016). IPC 경로에서
  // version-mismatch·frame-not-main이 채널과 무관하게 기록되는지 확인한다.
  test("RPC version-mismatch: wire response is VERSION_MISMATCH and the reason is recorded", async () => {
    const ipcMain = new FakeIpcMain();
    const { bridge, diagnostics } = makeDiagnosticsBridge(ipcMain);
    const contents = new FakeWebContents();
    bridge.attach(contents as unknown as WebContents, "main");

    const rpcHandler = ipcMain.handlers.get(
      ELECTRON_BRIDGE_CHANNELS("test").rpc,
    )!;
    const response = await rpcHandler(
      { sender: contents, senderFrame: contents.mainFrame },
      {
        protocolVersion: 2,
        clientId: "client-1",
        requestId: "request-1",
        key: "rpc:hardware/wait",
        input: undefined,
      },
    );

    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "version-mismatch" },
    ]);
    expect(response).toMatchObject({
      type: "error",
      error: {
        code: "VERSION_MISMATCH",
        message: "Unsupported protocol version.",
      },
    });
  });

  test.each([
    ["handshake" as const],
    ["cancel" as const],
    ["control" as const],
  ])(
    "%s version-mismatch is recorded once (handshake wire response stays INVALID_ARGUMENT)",
    async (channel) => {
      const ipcMain = new FakeIpcMain();
      const { bridge, diagnostics } = makeDiagnosticsBridge(ipcMain);
      const contents = new FakeWebContents();
      bridge.attach(contents as unknown as WebContents, "main");
      const event = { sender: contents, senderFrame: contents.mainFrame };

      if (channel === "handshake") {
        const handshakeHandler = ipcMain.handlers.get(
          ELECTRON_BRIDGE_CHANNELS("test").handshake,
        )!;
        const response = await handshakeHandler(event, {
          protocolVersion: 2,
          clientId: "client-1",
        });
        expect(response).toMatchObject({
          type: "error",
          error: { code: "INVALID_ARGUMENT" },
        });
      } else if (channel === "cancel") {
        ipcMain.emit(ELECTRON_BRIDGE_CHANNELS("test").cancel, event, {
          protocolVersion: 2,
          clientId: "client-1",
          requestId: "request-1",
        });
      } else {
        ipcMain.emit(ELECTRON_BRIDGE_CHANNELS("test").control, event, {
          protocolVersion: 2,
          clientId: "client-1",
          type: "unsubscribe",
          subscriptionId: "sub-1",
        });
      }

      expect(rejections(diagnostics)).toEqual([
        { type: "rejected", reason: "version-mismatch" },
      ]);
    },
  );

  test("RPC frame-not-main is channel-independent (same reason as handshake)", async () => {
    const ipcMain = new FakeIpcMain();
    const { bridge, diagnostics } = makeDiagnosticsBridge(ipcMain);
    const contents = new FakeWebContents();
    bridge.attach(contents as unknown as WebContents, "main");

    const rpcHandler = ipcMain.handlers.get(
      ELECTRON_BRIDGE_CHANNELS("test").rpc,
    )!;
    const response = await rpcHandler(
      { sender: contents, senderFrame: { routingId: 999, url: "app://local" } },
      {
        protocolVersion: 1,
        clientId: "client-1",
        requestId: "request-1",
        key: "rpc:hardware/wait",
        input: undefined,
      },
    );

    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "frame-not-main" },
    ]);
    expect(response).toMatchObject({
      type: "error",
      error: { code: "FORBIDDEN", message: "Bridge sender is not authorized." },
    });
  });
});

describe("StreamBridgeServer.handshake direct calls", () => {
  test("success returns a HandshakeResponse (no 'type' field)", () => {
    const server = createBridgeServer(waitImpl);
    server.attach(new FakeTarget());
    const response = server.handshake(sender(), {
      protocolVersion: 1,
      clientId: "client-1",
    });
    expect(response).toMatchObject({
      protocolVersion: 1,
      clientId: "client-1",
      manifest: { rpc: ["rpc:hardware/wait"] },
    });
    expect(response).not.toHaveProperty("type");
  });

  test("rejection returns an RpcResponse error shaped INVALID_ARGUMENT", () => {
    const server = createBridgeServer(waitImpl);
    // 미attach — admission이 sender-unauthorized로 거부한다.
    const response = server.handshake(sender({ webContentsId: 99 }), {
      protocolVersion: 1,
      clientId: "client-1",
    });
    expect(response).toMatchObject({
      type: "error",
      error: { code: "INVALID_ARGUMENT", message: "Invalid bridge request." },
    });
  });

  test("structural error input is malformed-envelope, not thrown", () => {
    const diagnostics = { record: vi.fn<(event: BridgeDiagnostic) => void>() };
    const server = createBridgeServer(waitImpl, { diagnostics });
    server.attach(new FakeTarget());
    const response = server.handshake(sender(), {
      protocolVersion: 1,
      clientId: Symbol("bad"),
    });
    expect(response).toMatchObject({
      type: "error",
      error: { code: "INVALID_ARGUMENT", message: "Invalid bridge request." },
    });
    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "malformed-envelope" },
    ]);
  });
});

/**
 * 연결 설정 축약(ADR 0013): `bindElectronBridge`의 `ipcMain`·`namespace`,
 * `attach`의 `role`을 생략했을 때의 기본값과 미주입 오류 경로.
 */
describe("bindElectronBridge argument defaults", () => {
  test("omitting namespace uses the shared default and channels are rx-bridge-electron:v1:default:*", () => {
    const ipcMain = new FakeIpcMain();
    const server = createBridgeServer(waitImpl);

    const bridge = bindElectronBridge({
      ipcMain: ipcMain as unknown as IpcMain,
      server,
      allowedOrigins: ["app://local"],
    });

    expect(DEFAULT_ELECTRON_BRIDGE_NAMESPACE).toBe("default");
    expect(bridge.channels).toEqual(
      ELECTRON_BRIDGE_CHANNELS(DEFAULT_ELECTRON_BRIDGE_NAMESPACE),
    );
    expect(bridge.channels.rpc).toBe("rx-bridge-electron:v1:default:rpc");
    expect(bridge.channels.handshake).toBe(
      "rx-bridge-electron:v1:default:handshake",
    );
  });

  test("omitting role on attach defaults to 'default' and reaches BridgeContext.windowRole", async () => {
    const ipcMain = new FakeIpcMain();
    let capturedRole: string | undefined;
    type RoleBridge = { hardware: { rpc: { role(): undefined } } };
    const roleImpl: BridgeImpl<RoleBridge> = {
      hardware: {
        rpc: {
          role: (_input: BridgeValue, context: BridgeContext) => {
            capturedRole = context.windowRole;
            return undefined;
          },
        },
      },
    };
    const server = createBridgeServer(roleImpl);
    const bridge = bindElectronBridge({
      ipcMain: ipcMain as unknown as IpcMain,
      server,
      allowedOrigins: ["app://local"],
    });
    const contents = new FakeWebContents();

    // role 인자를 생략한다 — 기본값 "default"가 BridgeContext.windowRole까지 전달돼야 한다.
    bridge.attach(contents as unknown as WebContents);

    const rpcHandler = ipcMain.handlers.get(ELECTRON_BRIDGE_CHANNELS().rpc)!;
    const response = await rpcHandler(
      { sender: contents, senderFrame: contents.mainFrame },
      {
        protocolVersion: 1,
        clientId: "client-1",
        requestId: "request-1",
        key: "rpc:hardware/role",
        input: undefined,
      },
    );

    expect(response).toMatchObject({ type: "success" });
    expect(capturedRole).toBe("default");
  });

  test("omitting ipcMain throws a clear error when Electron's ipcMain export is unavailable (Node test runtime)", () => {
    const server = createBridgeServer(waitImpl);

    expect(() =>
      bindElectronBridge({
        server,
        allowedOrigins: ["app://local"],
      }),
    ).toThrow(/ipcMain/);
  });
});
