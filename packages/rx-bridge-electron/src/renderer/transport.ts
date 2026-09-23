import type { PublicManifest } from "../contract/index.js";
import type {
  HandshakeResponse,
  RendererRpcRequest,
  RendererStreamCommand,
  RpcResponse,
  StreamMessage,
} from "../protocol/index.js";

export interface BridgeTransport {
  connect(): Promise<HandshakeResponse>;
  invoke(request: RendererRpcRequest): Promise<RpcResponse>;
  cancel(requestId: string): void;
  control(command: RendererStreamCommand): void;
  onStreamMessage(listener: (message: StreamMessage) => void): () => void;
}

/** The concrete handshake shape supplied by preload at runtime. */
export type HandshakeWithManifest = HandshakeResponse & {
  readonly manifest: PublicManifest;
};

export interface CallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
