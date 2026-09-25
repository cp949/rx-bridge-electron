import { _electron as electron } from "@playwright/test";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { ELECTRON_BRIDGE_CHANNELS } from "../../src/main/electron-adapter.js";
import { bundleFixture } from "./bundle-fixture.js";

const fixtureRoot = fileURLToPath(
  new URL(
    "../../node_modules/.cache/rx-bridge-electron-fixture/",
    import.meta.url,
  ),
);
const fixtureMain = `${fixtureRoot}main.js`;
const fixturePreload = `${fixtureRoot}preload.cjs`;
const fixtureRenderer = fileURLToPath(
  new URL("./fixture/renderer.html", import.meta.url),
);
const electronExecutable = createRequire(import.meta.url)("electron") as string;

type BridgeGlobal = {
  readonly rxBridge: {
    connect(): Promise<{ readonly clientId: string }>;
    invoke(request: {
      readonly requestId: string;
      readonly key: string;
      readonly input: unknown;
    }): Promise<unknown>;
    control(command: unknown): void;
    onStreamMessage(listener: (message: unknown) => void): () => void;
  };
};

describe("Electron bridge process seam", () => {
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

  beforeAll(async () => {
    await bundleFixture("test/electron/fixture", "rx-bridge-electron-fixture");
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  test("preserves the Main manifest through preload into createRendererApi", async () => {
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [fixtureMain],
      env: {
        ...process.env,
        RX_BRIDGE_PRELOAD: fixturePreload,
        RX_BRIDGE_RENDERER: fixtureRenderer,
      },
    });
    const page = await app.firstWindow();

    await expect
      .poll(() =>
        page.evaluate(
          () => (globalThis as unknown as Window).fixtureRendererResult,
        ),
      )
      .toEqual({ ready: true });
  });

  test("exposes only frozen narrow transport and completes RPC, State, and Event", async () => {
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [fixtureMain],
      env: {
        ...process.env,
        RX_BRIDGE_PRELOAD: fixturePreload,
        RX_BRIDGE_RENDERER: fixtureRenderer,
      },
    });
    const page = await app.firstWindow();

    const result = await page.evaluate(async () => {
      const bridge = (globalThis as unknown as BridgeGlobal).rxBridge;
      const handshake = await bridge.connect();
      const messages: unknown[] = [];
      const remove = bridge.onStreamMessage((message) =>
        messages.push(message),
      );
      const rpc = await bridge.invoke({
        requestId: "rpc-1",
        key: "rpc:device/ping",
        input: "hello",
      });
      bridge.control({
        type: "subscribe",
        subscriptionId: "test:subscription:1",
        key: "state:device/status",
      });
      bridge.control({
        type: "subscribe",
        subscriptionId: "test:subscription:2",
        key: "event:device/notice",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      bridge.control({
        type: "acknowledge",
        subscriptionId: "test:subscription:1",
        sequence: 1,
      });
      bridge.control({
        type: "unsubscribe",
        subscriptionId: "test:subscription:2",
      });
      remove();
      return {
        handshake,
        rpc,
        messages,
        methods: Object.keys(bridge).sort(),
        frozen: Object.isFrozen(bridge),
        rawIpc: "ipcRenderer" in globalThis || "require" in globalThis,
      };
    });

    expect(ELECTRON_BRIDGE_CHANNELS()).toEqual({
      handshake: "rx-bridge-electron:v1:default:handshake",
      rpc: "rx-bridge-electron:v1:default:rpc",
      cancel: "rx-bridge-electron:v1:default:cancel",
      control: "rx-bridge-electron:v1:default:control",
      stream: "rx-bridge-electron:v1:default:stream",
    });
    expect(result.handshake.clientId).toMatch(/^client-/);
    expect(result.rpc).toMatchObject({ type: "success", result: "pong:hello" });
    expect(result.methods).toEqual([
      "cancel",
      "connect",
      "control",
      "invoke",
      "onStreamMessage",
    ]);
    expect(result.frozen).toBe(true);
    expect(result.rawIpc).toBe(false);
    expect(result.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "subscribed",
          subscriptionId: "test:subscription:1",
        }),
        expect.objectContaining({
          type: "subscribed",
          subscriptionId: "test:subscription:2",
        }),
      ]),
    );
  });

  test("rejects child frames, unattached windows, and disallowed origins after a reload", async () => {
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [fixtureMain],
      env: {
        ...process.env,
        RX_BRIDGE_PRELOAD: fixturePreload,
        RX_BRIDGE_RENDERER: fixtureRenderer,
      },
    });
    const page = await app.firstWindow();

    const firstClientId = await page.evaluate(async () =>
      (globalThis as unknown as BridgeGlobal).rxBridge.connect(),
    );
    await page.reload();
    const secondClientId = await page.evaluate(async () =>
      (globalThis as unknown as BridgeGlobal).rxBridge.connect(),
    );

    expect(secondClientId.clientId).not.toBe(firstClientId.clientId);
    await expect(
      page.evaluate(() =>
        (globalThis as unknown as BridgeGlobal).rxBridge.invoke({
          requestId: "old-session",
          key: "rpc:device/ping",
          input: "late",
        }),
      ),
    ).resolves.toMatchObject({ type: "success" });

    const childFrame = page.waitForEvent("frameattached");
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.srcdoc = "<title>child</title>";
      document.body.append(frame);
    });
    const child = await childFrame;
    await expect(child.evaluate(() => "rxBridge" in globalThis)).resolves.toBe(
      false,
    );

    const unattachedPage = app.waitForEvent("window");
    await app.evaluate(async ({ BrowserWindow }) => {
      const preload = process.env.RX_BRIDGE_PRELOAD;
      if (preload === undefined) throw new Error("fixture preload is required");
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          preload,
        },
      });
      await window.loadFile(process.env.RX_BRIDGE_RENDERER!);
    });
    const second = await unattachedPage;
    await expect(
      second.evaluate(() =>
        (globalThis as unknown as BridgeGlobal).rxBridge.invoke({
          requestId: "unattached",
          key: "rpc:device/ping",
          input: "blocked",
        }),
      ),
    ).resolves.toMatchObject({ type: "error", error: { code: "FORBIDDEN" } });

    await page.goto("data:text/html,<title>untrusted</title>");
    await expect(
      page.evaluate(() =>
        (globalThis as unknown as BridgeGlobal).rxBridge.connect(),
      ),
    ).rejects.toThrow();
  });
});
