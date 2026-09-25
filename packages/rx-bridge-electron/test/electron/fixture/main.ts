import { app, BrowserWindow } from "electron";
import { BehaviorSubject, Subject } from "rxjs";
import { fileURLToPath } from "node:url";

import {
  type BridgeImpl,
  type Schema,
  type SchemasFor,
} from "@cp949/rx-bridge-electron/contract";
import {
  bindElectronBridge,
  broadcastEvent,
  createBridgeServer,
  currentValueSource,
} from "@cp949/rx-bridge-electron/main";

import type { FixtureBridge } from "./contract.js";

const string: Schema<string> = {
  parse(value) {
    if (typeof value !== "string") throw new TypeError("string required");
    return value;
  },
};
const status = new BehaviorSubject("ready");
const notices = new Subject<string>();
const impl: BridgeImpl<FixtureBridge> = {
  device: {
    rpc: { ping: (input) => `pong:${input}` },
    state: { status: currentValueSource(status) },
    event: { notice: broadcastEvent(notices) },
  },
};
const schemas = {
  device: {
    rpc: { ping: { input: string, output: string } },
    state: { status: string },
    event: { notice: string },
  },
} satisfies SchemasFor<FixtureBridge>;
declare global {
  // bind `dispose()`·재bind를 test가 `app.evaluate`로 부르는 main process 훅.
  var rxBridgeFixture: { disposeBridge(): void; rebind(): void } | undefined;
}

type Bind = ReturnType<typeof bindElectronBridge>;

function bind(): Bind {
  const server = createBridgeServer(impl, { schemas });
  return bindElectronBridge({ server, allowedOrigins: ["file://"] });
}

async function start(): Promise<void> {
  await app.whenReady();
  let bridge = bind();
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload:
        process.env.RX_BRIDGE_PRELOAD ??
        fileURLToPath(new URL("./preload.ts", import.meta.url)),
    },
  });
  bridge.attach(window.webContents);
  window.on("closed", () => bridge.dispose());
  globalThis.rxBridgeFixture = {
    disposeBridge: () => bridge.dispose(),
    // 같은 기본 namespace로 새 server·bind를 만들어 같은 창을 attach한다.
    rebind() {
      bridge = bind();
      bridge.attach(window.webContents);
    },
  };
  await window.loadFile(
    process.env.RX_BRIDGE_RENDERER ??
      fileURLToPath(new URL("./renderer.html", import.meta.url)),
  );
}

void start();
