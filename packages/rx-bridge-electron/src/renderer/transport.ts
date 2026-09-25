import type {
  HandshakeResponse,
  RendererRpcRequest,
  RendererStreamCommand,
  RpcResponse,
  StreamMessage,
} from "../protocol/index.js";

/**
 * preload `exposeBridgeInMainWorld`가 `globalName` 생략 시 노출하는 전역 이름이자
 * `createRendererApi`가 `transport` 생략 시 읽는 전역 이름. 두 지점이 어긋나면 축약형
 * 연결 설정이 항상 실패하므로 이 상수 하나를 공유한다(ADR 0013). 이 파일은 electron에
 * 의존하지 않으므로 preload와 renderer 번들이 모두 import할 수 있다.
 */
export const DEFAULT_BRIDGE_GLOBAL_NAME = "rxBridge";

export interface BridgeTransport {
  connect(): Promise<HandshakeResponse>;
  invoke(request: RendererRpcRequest): Promise<RpcResponse>;
  cancel(requestId: string): void;
  control(command: RendererStreamCommand): void;
  onStreamMessage(listener: (message: StreamMessage) => void): () => void;
}

export interface CallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
