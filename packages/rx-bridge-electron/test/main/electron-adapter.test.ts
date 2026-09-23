import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import type { IpcMain, WebContents } from "electron";

import {
  composeContracts,
  defineDomain,
  rpc,
  type Schema,
} from "../../src/contract/index.js";
import { BridgeProtocolError } from "../../src/protocol/index.js";
import {
  bindElectronBridge,
  createBridgeServer,
  ELECTRON_BRIDGE_CHANNELS,
  implementDomain,
} from "../../src/main/index.js";

const value: Schema<undefined> = { parse: () => undefined };
const domain = defineDomain("hardware", {
  rpc: { wait: rpc({ input: value, output: value }) },
});

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
  const server = createBridgeServer(composeContracts(domain), [
    implementDomain(domain, { rpc: { wait: async () => undefined } }),
  ]);
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
