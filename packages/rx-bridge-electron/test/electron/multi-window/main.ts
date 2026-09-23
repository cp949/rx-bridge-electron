import { app, BrowserWindow, ipcMain } from "electron";
import {
  BehaviorSubject,
  defer,
  finalize,
  Subject,
  type Observable,
} from "rxjs";
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
  type BridgeDiagnostic,
} from "@cp949/rx-bridge-electron/main";

const string: Schema<string> = {
  parse(value) {
    if (typeof value !== "string") throw new TypeError("string required");
    return value;
  },
};

type UpstreamName = "status" | "notice" | "strict" | "lossy";
const upstream: Record<
  UpstreamName,
  { subscribe: number; unsubscribe: number }
> = {
  status: { subscribe: 0, unsubscribe: 0 },
  notice: { subscribe: 0, unsubscribe: 0 },
  strict: { subscribe: 0, unsubscribe: 0 },
  lossy: { subscribe: 0, unsubscribe: 0 },
};
function counted<T>(name: UpstreamName, source: Observable<T>): Observable<T> {
  return defer(() => {
    upstream[name].subscribe += 1;
    return source.pipe(
      finalize(() => {
        upstream[name].unsubscribe += 1;
      }),
    );
  });
}

const status = new BehaviorSubject("ready");
const subjects = {
  notice: new Subject<string>(),
  strict: new Subject<string>(),
  lossy: new Subject<string>(),
};
const holds = new Set<() => void>();
const diagnostics: BridgeDiagnostic[] = [];

const lab = defineDomain("lab", {
  rpc: {
    ping: rpc({ input: string, output: string }),
    secure: rpc({ input: string, output: string }),
    hold: rpc({ input: string, output: string }),
  },
  state: { status: state(string) },
  event: {
    notice: event(string),
    strict: event(string, { buffer: { capacity: 4, overflow: "error" } }),
    lossy: event(string, { buffer: { capacity: 4, overflow: "drop-oldest" } }),
  },
});
const server = createBridgeServer(
  composeContracts(lab),
  [
    implementDomain(lab, {
      rpc: {
        ping: (input) => `pong:${input}`,
        secure: (input) => `secure:${input}`,
        hold: (input, context) =>
          new Promise<string>((resolve, reject) => {
            const release = () => {
              holds.delete(release);
              resolve(`held:${input}`);
            };
            holds.add(release);
            context.signal.addEventListener("abort", () => {
              holds.delete(release);
              reject(new Error("aborted"));
            });
          }),
      },
      state: {
        status: currentValueSource(
          Object.assign(counted("status", status), {
            getValue: () => status.getValue(),
          }),
        ),
      },
      event: {
        notice: broadcastEvent(counted("notice", subjects.notice)),
        strict: broadcastEvent(counted("strict", subjects.strict)),
        lossy: broadcastEvent(counted("lossy", subjects.lossy)),
      },
    }),
  ],
  {
    // viewer 창은 쓰기 성격의 RPC를 거부한다.
    authorize: (context, operationId) =>
      context.windowRole === "editor" ||
      !["rpc:lab/secure", "rpc:lab/hold"].includes(operationId),
    diagnostics: { record: (event) => diagnostics.push(event) },
  },
);

// 테스트가 `app.evaluate`로 읽는 Main 관측·제어 지점.
const probe = {
  snapshot: () => server.getDiagnosticsSnapshot(),
  diagnostics: () => [...diagnostics],
  upstream: () => structuredClone(upstream),
  setStatus: (value: string) => status.next(value),
  emit: (name: keyof typeof subjects, values: readonly string[]) => {
    for (const value of values) subjects[name].next(value);
  },
  holds: () => holds.size,
  releaseHolds: () => {
    for (const release of [...holds]) release();
  },
};
Object.assign(globalThis, { __rxBridgeProbe: probe });
export type MultiWindowProbe = typeof probe;

async function start(): Promise<void> {
  await app.whenReady();
  const bridge = bindElectronBridge({
    ipcMain,
    server,
    namespace: "fixture",
    allowedOrigins: ["file://"],
  });
  const renderer =
    process.env.RX_BRIDGE_RENDERER ??
    fileURLToPath(new URL("./renderer.html", import.meta.url));
  for (const role of ["editor", "viewer"]) {
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
    bridge.attach(window.webContents, role);
    await window.loadFile(renderer, { query: { role } });
  }
  app.on("window-all-closed", () => bridge.dispose());
}

void start();
