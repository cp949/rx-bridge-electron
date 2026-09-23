import type {
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
  WebFrameMain,
} from "electron";

import {
  BridgeProtocolError,
  parseHandshakeRequest,
  parseWireCancelRequest,
  parseWireRpcRequest,
  parseWireStreamCommand,
  type RpcResponse,
  type StreamMessage,
} from "../protocol/index.js";
import type { StreamSender } from "./stream-hub.js";
import {
  recordAdapterRejection,
  type StreamBridgeServer,
} from "./create-bridge-server.js";
import type { AttachedTarget, RejectReason, SenderIdentity } from "./types.js";

const limits = {
  maxDepth: Number.MAX_SAFE_INTEGER,
  maxEntries: Number.MAX_SAFE_INTEGER,
  maxStringBytes: Number.MAX_SAFE_INTEGER,
};

export interface ElectronBridgeChannels {
  readonly handshake: string;
  readonly rpc: string;
  readonly cancel: string;
  readonly control: string;
  readonly stream: string;
}

export function ELECTRON_BRIDGE_CHANNELS(
  namespace: string,
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
  readonly ipcMain: IpcMain;
  readonly server: StreamBridgeServer;
  readonly namespace: string;
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

function recordRejection(server: StreamBridgeServer, reason: RejectReason): void {
  server[recordAdapterRejection]?.(reason);
}

function protocolError(value: unknown): RpcResponse {
  const record = value !== null && typeof value === "object" ? value : {};
  const clientValue = (record as Record<string, unknown>).clientId;
  const requestValue = (record as Record<string, unknown>).requestId;
  const clientId =
    typeof clientValue === "string" ? clientValue : "invalid-client";
  const requestId =
    typeof requestValue === "string" ? requestValue : "invalid-request";
  return {
    protocolVersion: 1,
    clientId,
    requestId,
    type: "error",
    error: { code: "INVALID_ARGUMENT", message: "Invalid bridge request." },
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
  attach(contents: WebContents, role: string): () => void;
  dispose(): void;
} {
  const channels = ELECTRON_BRIDGE_CHANNELS(options.namespace);
  const attached = new Map<number, () => void>();
  const streamSender =
    (event: IpcMainEvent): StreamSender =>
    (message: StreamMessage) => {
      event.senderFrame?.send(channels.stream, message);
    };
  options.ipcMain.handle(channels.handshake, (event, value: unknown) => {
    let request;
    try {
      request = parseHandshakeRequest(value, limits);
    } catch {
      recordRejection(options.server, "malformed-envelope");
      return protocolError(value);
    }
    try {
      const identity = senderIdentity(event);
      if (!identity.isMainFrame) {
        recordRejection(options.server, "frame-not-main");
        return protocolError(value);
      }
      if (!options.allowedOrigins.includes(identity.origin)) {
        recordRejection(options.server, "origin-not-allowed");
        return protocolError(value);
      }
      const response = options.server.handshake(identity, request.clientId);
      if (response === undefined) {
        // server already recorded `sender-unauthorized` for this rejection.
        return protocolError(value);
      }
      return response;
    } catch {
      return protocolError(value);
    }
  });
  options.ipcMain.handle(channels.rpc, async (event, value: unknown) => {
    let request;
    try {
      request = parseWireRpcRequest(value, limits);
    } catch {
      recordRejection(options.server, "malformed-envelope");
      return protocolError(value);
    }
    try {
      return await options.server.dispatchRpc(senderIdentity(event), request);
    } catch {
      return protocolError(value);
    }
  });
  const onCancel = (event: IpcMainEvent, value: unknown) => {
    let request;
    try {
      request = parseWireCancelRequest(value, limits);
    } catch {
      recordRejection(options.server, "malformed-envelope");
      return;
    }
    try {
      options.server.cancel(senderIdentity(event), request);
    } catch {}
  };
  const onControl = (event: IpcMainEvent, value: unknown) => {
    let command;
    try {
      command = parseWireStreamCommand(value, limits);
    } catch {
      recordRejection(options.server, "malformed-envelope");
      return;
    }
    try {
      void options.server.controlStream(
        senderIdentity(event),
        command,
        streamSender(event),
      );
    } catch {}
  };
  options.ipcMain.on(channels.cancel, onCancel);
  options.ipcMain.on(channels.control, onControl);
  let disposed = false;
  return {
    channels,
    attach(contents, role) {
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
      options.ipcMain.removeHandler(channels.handshake);
      options.ipcMain.removeHandler(channels.rpc);
      options.ipcMain.removeListener(channels.cancel, onCancel);
      options.ipcMain.removeListener(channels.control, onControl);
      options.server.dispose();
    },
  };
}
