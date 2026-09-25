import { describe, expect, test, vi } from "vitest";
import type { ContextBridge, IpcRenderer } from "electron";

import {
  DEFAULT_ELECTRON_BRIDGE_NAMESPACE,
  ELECTRON_BRIDGE_CHANNELS,
} from "../../src/protocol/electron-channels.js";
import { exposeBridgeInMainWorld } from "../../src/preload/expose-bridge.js";

/** Minimal fake standing in for Electron's `contextBridge`: records the exposed global name/api. */
class FakeContextBridge {
  public exposed: { globalName: string; api: unknown } | undefined;

  public exposeInMainWorld(globalName: string, api: unknown): void {
    this.exposed = { globalName, api };
  }
}

/** Minimal fake standing in for Electron's `ipcRenderer`: records invoke/send calls. */
class FakeIpcRenderer {
  public readonly invokeCalls: Array<{ channel: string; args: unknown[] }> = [];
  public readonly sendCalls: Array<{ channel: string; args: unknown[] }> = [];
  private invokeResult: unknown = {
    protocolVersion: 1,
    clientId: "client-fake",
    manifest: { rpc: [], state: [], event: [] },
  };

  public setInvokeResult(value: unknown): void {
    this.invokeResult = value;
  }

  public async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.invokeCalls.push({ channel, args });
    return this.invokeResult;
  }

  public send(channel: string, ...args: unknown[]): void {
    this.sendCalls.push({ channel, args });
  }

  public on(): void {}
  public removeListener(): void {}
}

/**
 * RD-014 연결 설정 축약(ADR 0013): `exposeBridgeInMainWorld`의 `contextBridge`·`ipcRenderer`·
 * `namespace`, `options` 자체를 생략했을 때의 기본값과 미주입 오류 경로.
 */
describe("exposeBridgeInMainWorld argument defaults (RD-014)", () => {
  test("omitting namespace uses the shared default and invokes rx-bridge-electron:v1:default:handshake", async () => {
    const contextBridge = new FakeContextBridge();
    const ipcRenderer = new FakeIpcRenderer();

    exposeBridgeInMainWorld({
      contextBridge: contextBridge as unknown as ContextBridge,
      ipcRenderer: ipcRenderer as unknown as IpcRenderer,
    });

    expect(DEFAULT_ELECTRON_BRIDGE_NAMESPACE).toBe("default");
    const transport = contextBridge.exposed?.api as {
      connect(): Promise<unknown>;
    };
    await transport.connect();

    expect(ipcRenderer.invokeCalls[0]?.channel).toBe(
      ELECTRON_BRIDGE_CHANNELS(DEFAULT_ELECTRON_BRIDGE_NAMESPACE).handshake,
    );
    expect(ipcRenderer.invokeCalls[0]?.channel).toBe(
      "rx-bridge-electron:v1:default:handshake",
    );
  });

  test("omitting options entirely exposes the default globalName 'rxBridge'", () => {
    const contextBridge = new FakeContextBridge();
    const ipcRenderer = new FakeIpcRenderer();
    vi.stubGlobal("crypto", { randomUUID: () => "fixed-id" });

    // 명시 주입이 electron 모듈 해석보다 우선하므로, contextBridge/ipcRenderer만 주입하고
    // 나머지(전부)는 생략한다 — namespace·globalName 모두 기본값 경로를 탄다.
    exposeBridgeInMainWorld({
      contextBridge: contextBridge as unknown as ContextBridge,
      ipcRenderer: ipcRenderer as unknown as IpcRenderer,
    });

    expect(contextBridge.exposed?.globalName).toBe("rxBridge");
    vi.unstubAllGlobals();
  });

  test("omitting both contextBridge and ipcRenderer throws a clear error (Node test runtime)", () => {
    expect(() => exposeBridgeInMainWorld()).toThrow(/contextBridge/);
  });

  test("omitting only ipcRenderer throws a clear error naming ipcRenderer", () => {
    const contextBridge = new FakeContextBridge();

    expect(() =>
      exposeBridgeInMainWorld({
        contextBridge: contextBridge as unknown as ContextBridge,
      }),
    ).toThrow(/ipcRenderer/);
  });

  test("explicit injection path (existing behavior) works unchanged", async () => {
    const contextBridge = new FakeContextBridge();
    const ipcRenderer = new FakeIpcRenderer();

    exposeBridgeInMainWorld({
      contextBridge: contextBridge as unknown as ContextBridge,
      ipcRenderer: ipcRenderer as unknown as IpcRenderer,
      namespace: "fixture",
      globalName: "customBridge",
      clientId: "client-fixed",
    });

    expect(contextBridge.exposed?.globalName).toBe("customBridge");
    const transport = contextBridge.exposed?.api as {
      connect(): Promise<unknown>;
      cancel(requestId: string): void;
    };
    await transport.connect();
    transport.cancel("request-1");

    const channels = ELECTRON_BRIDGE_CHANNELS("fixture");
    expect(ipcRenderer.invokeCalls[0]?.channel).toBe(channels.handshake);
    expect(ipcRenderer.invokeCalls[0]?.args[0]).toMatchObject({
      clientId: "client-fixed",
    });
    expect(ipcRenderer.sendCalls[0]?.channel).toBe(channels.cancel);
    expect(ipcRenderer.sendCalls[0]?.args[0]).toMatchObject({
      clientId: "client-fixed",
      requestId: "request-1",
    });
  });
});

/**
 * Main·preload가 동일한 공유 상수(`DEFAULT_ELECTRON_BRIDGE_NAMESPACE`)로 기본 채널명을
 * 계산하므로, 인자를 생략한 두 쪽의 채널명이 실제로 일치하는지 명시적으로 검증한다.
 */
describe("bindElectronBridge and exposeBridgeInMainWorld default channel parity (RD-014)", () => {
  test("both default to rx-bridge-electron:v1:default:* without passing namespace anywhere", () => {
    const mainChannels = ELECTRON_BRIDGE_CHANNELS();
    const preloadChannels = ELECTRON_BRIDGE_CHANNELS(
      DEFAULT_ELECTRON_BRIDGE_NAMESPACE,
    );

    expect(mainChannels).toEqual(preloadChannels);
    expect(mainChannels.rpc).toBe("rx-bridge-electron:v1:default:rpc");
  });
});
