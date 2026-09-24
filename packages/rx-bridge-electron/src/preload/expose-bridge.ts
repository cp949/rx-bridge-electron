import type { ContextBridge, IpcRenderer, IpcRendererEvent } from "electron";
// Named import(`import { contextBridge, ipcRenderer } from "electron"`)는 Electron 밖(Node
// 유닛 테스트 등)에서 "electron" 패키지가 실행 파일 경로 문자열 하나만 export하기 때문에
// ESM 링크 단계에서 SyntaxError를 낸다. namespace import는 그 환경에서도 링크가 되고, 없는
// 프로퍼티 접근은 단순히 undefined를 반환한다 — 그래서 실제 조회는 호출 시점에 프로퍼티
// 접근으로 미룬다. ADR 0013 참고.
import * as electron from "electron";

import {
  parseHandshakeResponse,
  parseRendererRpcRequest,
  parseRendererStreamCommand,
  parseRpcResponse,
  parseStreamMessage,
  withEnvelope,
  type HandshakeResponse,
  type RendererRpcRequest,
  type RendererStreamCommand,
  type RpcResponse,
  type StreamMessage,
} from "../protocol/index.js";
import {
  DEFAULT_ELECTRON_BRIDGE_NAMESPACE,
  ELECTRON_BRIDGE_CHANNELS,
} from "../protocol/electron-channels.js";
import {
  DEFAULT_BRIDGE_GLOBAL_NAME,
  type BridgeTransport,
} from "../renderer/transport.js";

export interface ExposeBridgeOptions {
  readonly contextBridge?: ContextBridge;
  readonly ipcRenderer?: IpcRenderer;
  readonly namespace?: string;
  readonly globalName?: string;
  readonly clientId?: string;
}

function newClientId(): string {
  return `client-${crypto.randomUUID()}`;
}

export function exposeBridgeInMainWorld(
  options: ExposeBridgeOptions = {},
): void {
  // 주입값이 항상 우선한다. 둘 다 없으면(preload 밖, 예: Node 유닛 테스트에서 이 기본값
  // 경로를 탄 경우) `electron.contextBridge`/`electron.ipcRenderer`는 undefined이며
  // (namespace import이므로 여기서 링크 에러는 나지 않는다), 아래에서 명확한 에러로
  // 실패한다. ADR 0013 참고.
  const contextBridge = options.contextBridge ?? electron.contextBridge;
  if (contextBridge === undefined) {
    throw new TypeError(
      "exposeBridgeInMainWorld requires 'contextBridge': no 'contextBridge' " +
        "option was given and Electron's 'contextBridge' export is unavailable " +
        "in this runtime (not running inside Electron's preload script). Pass " +
        "'contextBridge' explicitly, e.g. in unit tests.",
    );
  }
  const ipcRenderer = options.ipcRenderer ?? electron.ipcRenderer;
  if (ipcRenderer === undefined) {
    throw new TypeError(
      "exposeBridgeInMainWorld requires 'ipcRenderer': no 'ipcRenderer' " +
        "option was given and Electron's 'ipcRenderer' export is unavailable " +
        "in this runtime (not running inside Electron's preload script). Pass " +
        "'ipcRenderer' explicitly, e.g. in unit tests.",
    );
  }
  const namespace = options.namespace ?? DEFAULT_ELECTRON_BRIDGE_NAMESPACE;
  const channels = ELECTRON_BRIDGE_CHANNELS(namespace);
  const clientId = options.clientId ?? newClientId();
  const transport: BridgeTransport = Object.freeze({
    async connect(): Promise<HandshakeResponse> {
      return parseHandshakeResponse(
        await ipcRenderer.invoke(
          channels.handshake,
          withEnvelope(clientId, {}),
        ),
      );
    },
    async invoke(request: RendererRpcRequest): Promise<RpcResponse> {
      const parsed = parseRendererRpcRequest(request);
      return parseRpcResponse(
        await ipcRenderer.invoke(channels.rpc, withEnvelope(clientId, parsed)),
      );
    },
    cancel(requestId: string): void {
      ipcRenderer.send(channels.cancel, withEnvelope(clientId, { requestId }));
    },
    control(command: RendererStreamCommand): void {
      ipcRenderer.send(
        channels.control,
        withEnvelope(clientId, parseRendererStreamCommand(command)),
      );
    },
    onStreamMessage(listener: (message: StreamMessage) => void): () => void {
      const wrapped = (_event: IpcRendererEvent, value: unknown) => {
        try {
          listener(parseStreamMessage(value));
        } catch {}
      };
      ipcRenderer.on(channels.stream, wrapped);
      return () => ipcRenderer.removeListener(channels.stream, wrapped);
    },
  });
  contextBridge.exposeInMainWorld(
    options.globalName ?? DEFAULT_BRIDGE_GLOBAL_NAME,
    transport,
  );
}
