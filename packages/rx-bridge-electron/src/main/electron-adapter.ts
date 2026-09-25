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
import {
  DEFAULT_ELECTRON_BRIDGE_NAMESPACE,
  ELECTRON_BRIDGE_CHANNELS,
  type ElectronBridgeChannels,
} from "../protocol/electron-channels.js";
import type { StreamSender } from "./subscriptions.js";
import type { StreamBridgeServer } from "./create-bridge-server.js";
import { invalidRequest } from "./protocol-error.js";
import type { AttachedTarget, SenderIdentity } from "./types.js";

export {
  DEFAULT_ELECTRON_BRIDGE_NAMESPACE,
  ELECTRON_BRIDGE_CHANNELS,
  type ElectronBridgeChannels,
};

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
      // `did-navigate`는 main frame이 새 문서로 실제 commit될 때만 발생한다
      // (정의상 main-frame 전용이라 `isMainFrame` 인자가 없다). pushState·hash
      // 변경·204·다운로드 취소·`will-navigate` 차단·beforeunload발 ERR_ABORTED에서는
      // 발생하지 않는다 — 그래서 구 탐색-시작 이벤트 대비 문서가 실제로
      // 바뀔 때만 retire한다(ADR 0019 실험).
      const navigated = () => listener("main-frame-navigation");
      // 오류 페이지 commit(예: ERR_CONNECTION_REFUSED)은 `did-navigate` 없이
      // `did-fail-load`만 온다. `isMainFrame`이 true이고, 콜백 실행 시점에
      // `contents.mainFrame.routingId`가 이 이벤트의 `frameRoutingId`와 같을 때만
      // retire로 본다 — 이 routingId 비교가 없으면 문서가 안 바뀐 취소
      // (`ERR_ABORTED`, `frameRoutingId`가 undefined이거나 옛 routingId)에서도
      // 오탐이 난다(ADR 0019 실험).
      const failedLoad = (
        _event: Electron.Event,
        _errorCode: number,
        _errorDescription: string,
        _validatedURL: string,
        isMainFrame: boolean,
        _frameProcessId: number,
        frameRoutingId: number,
      ) => {
        if (isMainFrame && contents.mainFrame.routingId === frameRoutingId)
          listener("main-frame-navigation");
      };
      const gone = () => listener("render-process-gone");
      const destroyed = () => listener("destroyed");
      contents.on("did-navigate", navigated);
      contents.on("did-fail-load", failedLoad);
      contents.on("render-process-gone", gone);
      contents.once("destroyed", destroyed);
      return () => {
        contents.removeListener("did-navigate", navigated);
        contents.removeListener("did-fail-load", failedLoad);
        contents.removeListener("render-process-gone", gone);
        contents.removeListener("destroyed", destroyed);
      };
    },
  };
}

/**
 * dispose된 bind의 IPC handler·listener 해제 함수. `ipcMain`별, handshake 채널
 * (namespace마다 유일)별로 하나다. dispose된 bind는 listener를 남겨 폐기된
 * server가 뒤이은 요청을 거부하게 하고, 같은 `ipcMain`·namespace의 새 bind가
 * 등록 전에 이 함수로 그 listener를 인수한다(ADR 0026). 활성 bind는 여기 없으므로
 * 중복 bind는 지금처럼 `ipcMain.handle`이 throw한다.
 */
const disposedBindings = new WeakMap<IpcMain, Map<string, () => void>>();

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
  disposedBindings.get(ipcMain)?.get(channels.handshake)?.();
  const attached = new Map<number, () => void>();
  const streamSender =
    (event: IpcMainEvent): StreamSender =>
    (message: StreamMessage) => {
      event.senderFrame?.send(channels.stream, message);
    };
  // 아래 네 catch는 server가 아니라 이 adapter의 Electron 객체 접근을 막는다.
  // server는 잘못된 `value`를 응답이나 침묵으로 처리하고 throw하지 않는다.
  // throw할 수 있는 곳은 `senderIdentity()`(`senderFrame`·`frame.url`)와
  // `targetFor()` target 콜백(`contents.mainFrame`)이다 — 파괴된 frame·
  // webContents에 접근하면 Electron이 throw할 수 있다.
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
      options.server.dispose();
      const bindings =
        disposedBindings.get(ipcMain) ?? new Map<string, () => void>();
      disposedBindings.set(ipcMain, bindings);
      bindings.set(channels.handshake, () => {
        bindings.delete(channels.handshake);
        ipcMain.removeHandler(channels.handshake);
        ipcMain.removeHandler(channels.rpc);
        ipcMain.removeListener(channels.cancel, onCancel);
        ipcMain.removeListener(channels.control, onControl);
      });
    },
  };
}
