import type {
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
  WebFrameMain,
} from "electron";
// Named import(`import { ipcMain } from "electron"`)는 Electron 밖(Node 유닛 테스트 등)에서
// "electron" 패키지가 실행 파일 경로 문자열 하나만 export하기 때문에 ESM 링크 단계에서
// SyntaxError를 낸다. namespace import는 그 환경에서도 링크가 되고, 없는 프로퍼티 접근은
// 단순히 undefined를 반환한다 — 그래서 실제 조회는 호출 시점에 프로퍼티 접근으로 미룬다.
// ADR 0013 참고.
import * as electron from "electron";

import { BridgeProtocolError, type StreamMessage } from "../protocol/index.js";
import type { StreamSender } from "./subscriptions.js";
import type { StreamBridgeServer } from "./create-bridge-server.js";
import { invalidRequest } from "./protocol-error.js";
import type { AttachedTarget, SenderIdentity } from "./types.js";

export interface ElectronBridgeChannels {
  readonly handshake: string;
  readonly rpc: string;
  readonly cancel: string;
  readonly control: string;
  readonly stream: string;
}

/**
 * Main과 preload가 `namespace`를 생략했을 때 함께 쓰는 기본값. 두 지점이 각자 다른
 * 기본값을 두면 한쪽만 생략했을 때 채널이 어긋나는 조용한 실패가 생기므로, 이 상수 하나를
 * 공유한다(ADR 0013). preload(`src/preload/expose-bridge.ts`)는 이 파일에서
 * `ELECTRON_BRIDGE_CHANNELS`를 이미 import하고 있으므로 같은 경로에서 이 상수도 가져온다.
 */
export const DEFAULT_ELECTRON_BRIDGE_NAMESPACE = "default";

export function ELECTRON_BRIDGE_CHANNELS(
  namespace: string = DEFAULT_ELECTRON_BRIDGE_NAMESPACE,
): ElectronBridgeChannels {
  const prefix = `rx-bridge-electron:v1:${namespace}`;
  return {
    handshake: `${prefix}:handshake`,
    rpc: `${prefix}:rpc`,
    cancel: `${prefix}:cancel`,
    control: `${prefix}:control`,
    stream: `${prefix}:stream`,
  };
}

export interface BindElectronBridgeOptions {
  readonly ipcMain?: IpcMain;
  readonly server: StreamBridgeServer;
  readonly namespace?: string;
  readonly allowedOrigins: readonly string[];
}

function originOf(frame: WebFrameMain): string {
  const url = new URL(frame.url);
  return url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin;
}

function senderIdentity(
  event: IpcMainEvent | IpcMainInvokeEvent,
): SenderIdentity {
  const frame = event.senderFrame;
  if (frame === null) {
    return {
      webContentsId: event.sender.id,
      frameId: -1,
      isMainFrame: false,
      origin: "invalid://",
    };
  }
  return {
    webContentsId: event.sender.id,
    frameId: frame.routingId,
    isMainFrame: event.sender.mainFrame === frame,
    origin: originOf(frame),
  };
}

function targetFor(
  contents: WebContents,
  role: string,
  allowedOrigins: readonly string[],
): AttachedTarget {
  return {
    webContentsId: contents.id,
    role,
    isCurrentMainFrame: (sender) =>
      sender.webContentsId === contents.id &&
      sender.isMainFrame &&
      contents.mainFrame.routingId === sender.frameId,
    isAllowedOrigin: (origin) => allowedOrigins.includes(origin),
    onLifecycle(listener) {
      const navigation = (
        _event: Electron.Event,
        _url: string,
        _inPlace: boolean,
        isMainFrame: boolean,
      ) => {
        if (isMainFrame) listener("main-frame-navigation");
      };
      const gone = () => listener("render-process-gone");
      const destroyed = () => listener("destroyed");
      contents.on("did-start-navigation", navigation);
      contents.on("render-process-gone", gone);
      contents.once("destroyed", destroyed);
      return () => {
        contents.removeListener("did-start-navigation", navigation);
        contents.removeListener("render-process-gone", gone);
        contents.removeListener("destroyed", destroyed);
      };
    },
  };
}

/** Binds fixed Electron channels; renderer code receives no Electron objects. */
export function bindElectronBridge(options: BindElectronBridgeOptions): {
  readonly channels: ElectronBridgeChannels;
  attach(contents: WebContents, role?: string): () => void;
  dispose(): void;
} {
  // 주입값이 항상 우선한다. 둘 다 없으면(비-Electron 런타임에서 이 기본값 경로를 탄 경우)
  // `electron.ipcMain`은 undefined이며(네임스페이스 import이므로 여기서 링크 에러는 나지
  // 않는다), 아래에서 명확한 에러로 실패한다. ADR 0013 참고.
  const ipcMain = options.ipcMain ?? electron.ipcMain;
  if (ipcMain === undefined) {
    throw new TypeError(
      "bindElectronBridge requires 'ipcMain': no 'ipcMain' option was given " +
        "and Electron's 'ipcMain' export is unavailable in this runtime " +
        "(not running inside Electron's main process). Pass 'ipcMain' " +
        "explicitly, e.g. in unit tests.",
    );
  }
  const channels = ELECTRON_BRIDGE_CHANNELS(options.namespace);
  const attached = new Map<number, () => void>();
  const streamSender =
    (event: IpcMainEvent): StreamSender =>
    (message: StreamMessage) => {
      event.senderFrame?.send(channels.stream, message);
    };
  ipcMain.handle(channels.handshake, (event, value: unknown) => {
    try {
      return options.server.handshake(senderIdentity(event), value);
    } catch {
      return invalidRequest(value);
    }
  });
  ipcMain.handle(channels.rpc, async (event, value: unknown) => {
    try {
      return await options.server.dispatchRpc(senderIdentity(event), value);
    } catch {
      return invalidRequest(value);
    }
  });
  const onCancel = (event: IpcMainEvent, value: unknown) => {
    try {
      options.server.cancel(senderIdentity(event), value);
    } catch {}
  };
  const onControl = (event: IpcMainEvent, value: unknown) => {
    try {
      void options.server.controlStream(
        senderIdentity(event),
        value,
        streamSender(event),
      );
    } catch {}
  };
  ipcMain.on(channels.cancel, onCancel);
  ipcMain.on(channels.control, onControl);
  let disposed = false;
  return {
    channels,
    attach(contents, role = "default") {
      if (disposed)
        throw new BridgeProtocolError(
          "FORBIDDEN",
          "Electron bridge is disposed.",
        );
      const prior = attached.get(contents.id);
      prior?.();
      const detach = options.server.attach(
        targetFor(contents, role, options.allowedOrigins),
      );
      attached.set(contents.id, detach);
      return () => {
        if (attached.get(contents.id) === detach) attached.delete(contents.id);
        detach();
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const detach of attached.values()) detach();
      attached.clear();
      ipcMain.removeHandler(channels.handshake);
      ipcMain.removeHandler(channels.rpc);
      ipcMain.removeListener(channels.cancel, onCancel);
      ipcMain.removeListener(channels.control, onControl);
      options.server.dispose();
    },
  };
}
