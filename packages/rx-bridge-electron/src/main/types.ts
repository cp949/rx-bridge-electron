import type {
  BridgeValue,
  RpcResponse,
  WireCancelRequest,
  WireRpcRequest,
} from "../protocol/index.js";
import type { CurrentValueSource, EventSource } from "./sources.js";

export interface SenderIdentity {
  readonly webContentsId: number;
  readonly frameId: number;
  readonly isMainFrame: boolean;
  readonly origin: string;
}

export interface AttachedTarget {
  readonly webContentsId: number;
  readonly role: string;
  isCurrentMainFrame(sender: SenderIdentity): boolean;
  isAllowedOrigin(origin: string): boolean;
  onLifecycle(
    listener: (
      reason: "main-frame-navigation" | "render-process-gone" | "destroyed",
    ) => void,
  ): () => void;
}

export interface BridgeContext {
  readonly requestId: string;
  readonly clientId: string;
  readonly windowRole: string;
  readonly sender: SenderIdentity;
  readonly signal: AbortSignal;
}

export type Authorize = (
  context: BridgeContext,
  operationId: string,
) => boolean | Promise<boolean>;
export type BridgeDiagnostic =
  | {
      readonly type: "rpc-finished";
      readonly key: string;
      readonly durationMs: number;
    }
  | { readonly type: "rpc-cancelled"; readonly key: string }
  | { readonly type: "validation-failed"; readonly key: string }
  | {
      readonly type: "stream-queue";
      readonly key: string;
      readonly depth: number;
    }
  | {
      readonly type: "stream-dropped";
      readonly key: string;
      readonly count: number;
    };
export interface DiagnosticsSink {
  record(event: BridgeDiagnostic): void;
}

export interface BridgeServer {
  attach(target: AttachedTarget): () => void;
  dispatchRpc(
    sender: SenderIdentity,
    envelope: WireRpcRequest,
  ): Promise<RpcResponse>;
  cancel(sender: SenderIdentity, envelope: WireCancelRequest): void;
  dispose(): void;
}

export type RpcHandler = (
  input: BridgeValue,
  context: BridgeContext,
) => Promise<BridgeValue> | BridgeValue;
export interface DomainImplementation<Name extends string = string> {
  readonly domainName: Name;
  readonly rpc: Readonly<Record<string, RpcHandler>>;
  readonly state: Readonly<Record<string, CurrentValueSource<BridgeValue>>>;
  readonly event: Readonly<Record<string, EventSource>>;
}
