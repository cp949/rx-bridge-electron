import type { ContextBridge, IpcRenderer, IpcRendererEvent } from "electron";

import {
  parseHandshakeResponse,
  parseRendererRpcRequest,
  parseRendererStreamCommand,
  parseRpcResponse,
  parseStreamMessage,
  type HandshakeResponse,
  type RendererRpcRequest,
  type RendererStreamCommand,
  type RpcResponse,
  type StreamMessage,
} from "../protocol/index.js";
import { ELECTRON_BRIDGE_CHANNELS } from "../main/electron-adapter.js";
import type { BridgeTransport } from "../renderer/transport.js";

const limits = { maxDepth: 32, maxEntries: 10_000, maxStringBytes: 1_000_000 };

export interface ExposeBridgeOptions {
  readonly contextBridge: ContextBridge;
  readonly ipcRenderer: IpcRenderer;
  readonly namespace: string;
  readonly globalName?: string;
  readonly clientId?: string;
}

function newClientId(): string {
  return `client-${crypto.randomUUID()}`;
}

export function exposeBridgeInMainWorld(options: ExposeBridgeOptions): void {
  const channels = ELECTRON_BRIDGE_CHANNELS(options.namespace);
  const clientId = options.clientId ?? newClientId();
  const transport: BridgeTransport = Object.freeze({
    async connect(): Promise<HandshakeResponse> {
      return parseHandshakeResponse(
        await options.ipcRenderer.invoke(channels.handshake, {
          protocolVersion: 1,
          clientId,
        }),
        limits,
      );
    },
    async invoke(request: RendererRpcRequest): Promise<RpcResponse> {
      const parsed = parseRendererRpcRequest(request, limits);
      return parseRpcResponse(
        await options.ipcRenderer.invoke(channels.rpc, {
          ...parsed,
          protocolVersion: 1,
          clientId,
        }),
        limits,
      );
    },
    cancel(requestId: string): void {
      options.ipcRenderer.send(channels.cancel, {
        protocolVersion: 1,
        clientId,
        requestId,
      });
    },
    control(command: RendererStreamCommand): void {
      options.ipcRenderer.send(channels.control, {
        ...parseRendererStreamCommand(command, limits),
        protocolVersion: 1,
        clientId,
      });
    },
    onStreamMessage(listener: (message: StreamMessage) => void): () => void {
      const wrapped = (_event: IpcRendererEvent, value: unknown) => {
        try {
          listener(parseStreamMessage(value, limits));
        } catch {}
      };
      options.ipcRenderer.on(channels.stream, wrapped);
      return () => options.ipcRenderer.removeListener(channels.stream, wrapped);
    },
  });
  options.contextBridge.exposeInMainWorld(
    options.globalName ?? "rxBridge",
    transport,
  );
}
