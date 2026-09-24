import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import type { IpcMain, WebContents } from "electron";

import type { BridgeImpl, Schema } from "../../src/contract/index.js";
import { BridgeProtocolError } from "../../src/protocol/index.js";
import {
  bindElectronBridge,
  createBridgeServer,
  ELECTRON_BRIDGE_CHANNELS,
  type BridgeDiagnostic,
} from "../../src/main/index.js";
import { recordAdapterRejection } from "../../src/main/diagnostics.js";
import * as mainIndex from "../../src/main/index.js";

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

  test("bindElectronBridge works against a StreamBridgeServer without the adapter Symbol method", async () => {
    const ipcMain = new FakeIpcMain();
    const fakeServer = {
      attach: () => () => {},
      dispatchRpc: async (
        _sender: unknown,
        envelope: { clientId: string; requestId: string },
      ) => ({
        protocolVersion: 1,
        clientId: envelope.clientId,
        requestId: envelope.requestId,
        type: "success",
        result: undefined,
      }),
      cancel: () => {},
      dispose: () => {},
      handshake: (_sender: unknown, clientId: string) => ({
        protocolVersion: 1,
        clientId,
        manifest: { domains: {} },
      }),
      controlStream: async () => {},
      // no [recordAdapterRejection] method
    };

    expect(() =>
      bindElectronBridge({
        ipcMain: ipcMain as unknown as IpcMain,
        server: fakeServer as never,
        namespace: "test",
        allowedOrigins: ["app://local"],
      }),
    ).not.toThrow();

    const contents = new UrlWebContents("app://evil");
    const handshakeHandler = ipcMain.handlers.get(
      ELECTRON_BRIDGE_CHANNELS("test").handshake,
    )!;
    const response = await handshakeHandler(
      { sender: contents, senderFrame: contents.mainFrame },
      { protocolVersion: 1, clientId: "client-1" },
    );

    expect(response).toMatchObject({ type: "error" });
  });

  test("the adapter Symbol is not part of the public main index export", () => {
    const ipcMain = new FakeIpcMain();
    const { server } = makeDiagnosticsBridge(ipcMain);

    expect(Object.getOwnPropertySymbols(server)).toContain(
      recordAdapterRejection,
    );
    expect(Object.values(mainIndex)).not.toContain(recordAdapterRejection);
  });
});
