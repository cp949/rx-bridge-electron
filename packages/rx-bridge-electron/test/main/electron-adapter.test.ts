import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import type { IpcMain, WebContents } from "electron";

import type { BridgeImpl, Schema } from "../../src/contract/index.js";
import { BridgeProtocolError } from "../../src/protocol/index.js";
import type { BridgeValue } from "../../src/protocol/index.js";
import { FakeTarget, sender } from "./fake-ipc.js";
import {
  bindElectronBridge,
  createBridgeServer,
  DEFAULT_ELECTRON_BRIDGE_NAMESPACE,
  ELECTRON_BRIDGE_CHANNELS,
  type BridgeContext,
  type BridgeDiagnostic,
} from "../../src/main/index.js";

type WaitBridge = { hardware: { rpc: { wait(): undefined } } };
const waitImpl: BridgeImpl<WaitBridge> = {
  hardware: { rpc: { wait: async () => undefined } },
};

/** Minimal fake standing in for Electron's `ipcMain`: adds `handle`/`removeHandler` over a plain EventEmitter. */
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

/** Minimal fake standing in for Electron's `WebContents`: id + mainFrame + EventEmitter lifecycle events. */
class FakeWebContents extends EventEmitter {
  public readonly id: number;
  public readonly mainFrame: { readonly routingId: number };

  public constructor(id = 1, routingId = 10) {
    super();
    this.id = id;
    this.mainFrame = { routingId };
  }
}

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
  test("removes only its own cancel/control listeners and invoke handlers", () => {
    const ipcMain = new FakeIpcMain();
    const channels = ELECTRON_BRIDGE_CHANNELS("test");
    const externalCancel = () => {};
    const externalControl = () => {};
    ipcMain.on(channels.cancel, externalCancel);
    ipcMain.on(channels.control, externalControl);

    const { bridge } = makeBridge(ipcMain);
    bridge.dispose();

    expect(ipcMain.listenerCount(channels.cancel)).toBe(1);
    expect(ipcMain.listeners(channels.cancel)).toEqual([externalCancel]);
    expect(ipcMain.listenerCount(channels.control)).toBe(1);
    expect(ipcMain.listeners(channels.control)).toEqual([externalControl]);
    expect(ipcMain.handlers.has(channels.handshake)).toBe(false);
    expect(ipcMain.handlers.has(channels.rpc)).toBe(false);
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

    expect(contents.listenerCount("did-start-navigation")).toBeGreaterThan(0);

    bridge.dispose();

    expect(contents.listenerCount("did-start-navigation")).toBe(0);
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

/** Minimal fake WebContents whose main frame carries a real `url`, for origin checks. */
class UrlWebContents extends EventEmitter {
  public readonly id = 1;
  public readonly mainFrame: {
    readonly routingId: number;
    readonly url: string;
  };

  public constructor(url: string) {
    super();
    this.mainFrame = { routingId: 10, url };
  }
}

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
    const contents = new UrlWebContents("app://local");
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
    const contents = new UrlWebContents("app://local");
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
    const contents = new UrlWebContents("app://evil");
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
    const contents = new UrlWebContents("app://local");

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
    const contents = new UrlWebContents("app://local");

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
    const contents = new UrlWebContents("app://local");

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
    const contents = new UrlWebContents("app://local");

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
    const contents = new UrlWebContents("app://local");
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
    const contents = new UrlWebContents("app://local");
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

  // DELTA-03: envelope parse(version 포함)를 server가 소유한다. IPC 경로에서
  // version-mismatch·frame-not-main이 채널과 무관하게 기록되는지 확인한다.
  test("RPC version-mismatch: wire response is VERSION_MISMATCH and the reason is recorded", async () => {
    const ipcMain = new FakeIpcMain();
    const { bridge, diagnostics } = makeDiagnosticsBridge(ipcMain);
    const contents = new UrlWebContents("app://local");
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
      const contents = new UrlWebContents("app://local");
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
    const contents = new UrlWebContents("app://local");
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

describe("StreamBridgeServer.handshake direct calls (DELTA-03)", () => {
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
    const server = createBridgeServer(waitImpl);
    server.attach(new FakeTarget());
    const response = server.handshake(sender(), {
      protocolVersion: 1,
      clientId: Symbol("bad"),
    });
    expect(response).toMatchObject({
      type: "error",
      error: { code: "INVALID_ARGUMENT", message: "Invalid bridge request." },
    });
  });
});

/**
 * RD-014 배선 축약(ADR 0013): `bindElectronBridge`의 `ipcMain`·`namespace`,
 * `attach`의 `role`을 생략했을 때의 기본값과 미주입 오류 경로.
 */
describe("bindElectronBridge argument defaults (RD-014)", () => {
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
    const contents = new UrlWebContents("app://local");

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
