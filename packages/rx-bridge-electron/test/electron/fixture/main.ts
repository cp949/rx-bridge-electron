import { app, BrowserWindow } from "electron";
import { BehaviorSubject, Subject } from "rxjs";
import { fileURLToPath } from "node:url";

import {
  composeContracts,
  defineDomain,
  event,
  rpc,
  state,
  type Schema,
} from "@cp949/rx-bridge-electron/contract";
import {
  bindElectronBridge,
  broadcastEvent,
  createBridgeServer,
  currentValueSource,
  implementDomain,
} from "@cp949/rx-bridge-electron/main";

const string: Schema<string> = {
  parse(value) {
    if (typeof value !== "string") throw new TypeError("string required");
    return value;
  },
};
const status = new BehaviorSubject("ready");
const notices = new Subject<string>();
const device = defineDomain("device", {
  rpc: { ping: rpc({ input: string, output: string }) },
  state: { status: state(string) },
  event: { notice: event(string) },
});
const server = createBridgeServer(composeContracts(device), [
  implementDomain(device, {
    rpc: { ping: (input) => `pong:${input}` },
    state: { status: currentValueSource(status) },
    event: { notice: broadcastEvent(notices) },
  }),
]);

async function start(): Promise<void> {
  await app.whenReady();
  const bridge = bindElectronBridge({
    ipcMain: (await import("electron")).ipcMain,
    server,
    namespace: "fixture",
    allowedOrigins: ["file://"],
  });
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
  bridge.attach(window.webContents, "main");
  window.on("closed", () => bridge.dispose());
  await window.loadFile(
    process.env.RX_BRIDGE_RENDERER ??
      fileURLToPath(new URL("./renderer.html", import.meta.url)),
  );
}

void start();
