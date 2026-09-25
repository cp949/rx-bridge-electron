// main에는 타입만 의존한다(`import type`) — `./testing`은 electron·`bindElectronBridge`·
// `ipcMain`을 런타임에 불러오지 않는다(ADR 0017). envelope 조립(`withEnvelope`)과
// 요청·응답·stream 검사(`parse*`)는 preload adapter(`src/preload/expose-bridge.ts`)와 같은
// protocol 함수를 값으로 쓴다 — 같은 입력에 preload와 같은 지점에서 실패한다.
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
import type { BridgeTransport } from "../renderer/transport.js";
import type { StreamBridgeServer } from "../main/create-bridge-server.js";
import type { AttachedTarget, SenderIdentity } from "../main/types.js";

export interface LoopbackTransportOptions {
  readonly sender?: Partial<SenderIdentity>;
  readonly clientId?: string;
  readonly role?: string;
}

export interface LoopbackTransport extends BridgeTransport {
  dispose(): void;
}

const DEFAULT_SENDER: SenderIdentity = {
  webContentsId: 1,
  frameId: 1,
  isMainFrame: true,
  origin: "loopback://test",
};

function disposedError(): Error {
  return new Error("Loopback transport is disposed.");
}

/**
 * `BridgeTransport`의 두 번째 in-process adapter(test 전용). 호출자가 만든
 * `server`에 고정 target으로 `attach`해, admission 규칙(`DocumentSessions#admit`)을
 * 호출자가 몰라도 되게 한다. preload adapter와 같은 protocol 함수로 envelope를
 * 조립·검사하고 `structuredClone`으로 요청·응답·stream 메시지를 복제한다(실제 IPC
 * 경계처럼 참조를 공유하지 않는다). handshake 거부 응답은 preload처럼
 * `parseHandshakeResponse`에서 reject된다. `server` 자체는 dispose하지 않는다 — 한
 * `server`에 여러 loopback transport를 붙일 수 있다.
 */
export function createLoopbackTransport(
  server: StreamBridgeServer,
  options: LoopbackTransportOptions = {},
): LoopbackTransport {
  const sender: SenderIdentity = { ...DEFAULT_SENDER, ...options.sender };
  const clientId = options.clientId ?? "loopback-client";
  const role = options.role ?? "default";

  let disposed = false;
  const listeners = new Set<(message: StreamMessage) => void>();

  const target: AttachedTarget = {
    webContentsId: sender.webContentsId,
    role,
    isCurrentMainFrame: (candidate) =>
      candidate.webContentsId === sender.webContentsId &&
      candidate.frameId === sender.frameId &&
      candidate.isMainFrame,
    isAllowedOrigin: (origin) => origin === sender.origin,
    onLifecycle: () => () => {},
  };
  const detach = server.attach(target);

  return {
    async connect(): Promise<HandshakeResponse> {
      if (disposed) throw disposedError();
      const response = server.handshake(sender, withEnvelope(clientId, {}));
      return parseHandshakeResponse(structuredClone(response));
    },

    async invoke(request: RendererRpcRequest): Promise<RpcResponse> {
      if (disposed) throw disposedError();
      const parsed = parseRendererRpcRequest(request);
      const wireRequest = structuredClone(withEnvelope(clientId, parsed));
      const response = await server.dispatchRpc(sender, wireRequest);
      return parseRpcResponse(structuredClone(response));
    },

    cancel(requestId: string): void {
      if (disposed) return;
      queueMicrotask(() => {
        if (disposed) return;
        server.cancel(sender, withEnvelope(clientId, { requestId }));
      });
    },

    control(command: RendererStreamCommand): void {
      if (disposed) return;
      // preload처럼 잘못된 command는 호출 시점에 동기로 throw한다.
      const parsed = parseRendererStreamCommand(command);
      queueMicrotask(() => {
        if (disposed) return;
        const wireCommand = withEnvelope(clientId, parsed);
        void server.controlStream(sender, wireCommand, (message) => {
          // preload의 `onStreamMessage`(:99)와 같이 parse 실패분은 조용히
          // 버린다 — 여기서는 clone 실패도 같은 취급이다.
          try {
            const parsed = parseStreamMessage(structuredClone(message));
            queueMicrotask(() => {
              if (disposed) return;
              for (const listener of listeners) listener(parsed);
            });
          } catch {
            // 무시: 손상된 stream 메시지는 전달하지 않는다.
          }
        });
      });
    },

    onStreamMessage(listener: (message: StreamMessage) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      detach();
    },
  };
}
