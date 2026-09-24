import { app, BrowserWindow, net, protocol } from "electron";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDemoComposition } from "./composition.js";
import { originOf } from "./origin.js";
import { bindElectronBridge } from "@cp949/rx-bridge-electron/main";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
const developmentUrl = process.env.ELECTRON_RENDERER_URL;
const rendererDirectory = fileURLToPath(
  new URL("../renderer/", import.meta.url),
);
async function loadWindow(
  window: BrowserWindow,
  role: "main" | "monitor",
): Promise<void> {
  if (developmentUrl !== undefined) {
    const url = new URL(developmentUrl);
    url.searchParams.set("role", role);
    await window.loadURL(url.toString());
  } else {
    await window.loadURL(`app://./index.html?role=${role}`);
  }
}
async function start(): Promise<void> {
  await app.whenReady();
  protocol.handle("app", (request) => {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const resource = pathname === "/" ? "index.html" : pathname.slice(1);
    const target = resolve(rendererDirectory, resource);
    if (relative(rendererDirectory, target).startsWith(".."))
      throw new Error("Untrusted app protocol path.");
    return net.fetch(pathToFileURL(target).toString());
  });
  const allowedOrigins = [
    developmentUrl === undefined ? "app://." : originOf(developmentUrl),
  ];
  const composition = createDemoComposition();
  const bridge = bindElectronBridge({
    server: composition.server,
    allowedOrigins,
  });
  const createWindow = async (role: "main" | "monitor"): Promise<void> => {
    const window = new BrowserWindow({
      width: role === "main" ? 1100 : 460,
      height: role === "main" ? 900 : 740,
      title: role === "main" ? "Virtual Device Monitor" : "Device Monitor",
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        preload: fileURLToPath(
          new URL("../preload/index.cjs", import.meta.url),
        ),
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (originOf(url) !== allowedOrigins[0]) event.preventDefault();
    });
    bridge.attach(window.webContents, role);
    await loadWindow(window, role);
  };
  await Promise.all([createWindow("main"), createWindow("monitor")]);
  app.once("before-quit", () => {
    bridge.dispose();
    composition.dispose();
  });
}
app.on("window-all-closed", () => app.quit());
void start();
