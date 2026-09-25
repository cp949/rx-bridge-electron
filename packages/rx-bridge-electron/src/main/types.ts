import type { BridgeContext, SenderIdentity } from "../contract/impl-types.js";
import type { BridgeValue } from "../protocol/index.js";
import type { OperationCategory } from "../protocol/operation-key.js";

export type { BridgeContext, SenderIdentity } from "../contract/impl-types.js";
export type { OperationCategory } from "../protocol/operation-key.js";

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

/**
 * `authorize`가 받는 등록된 operation의 식별 정보. 등록 시 operation마다 한 번
 * 만들어 동결한다(객체와 `domain` 배열 모두). 같은 operation이 같은 객체라는
 * 동일성은 계약이 아니다 — 비교는 `key`로 한다.
 */
export interface BridgeOperation {
  /** wire key(`category:domain/op`). 예: `"rpc:device/connect"`. */
  readonly key: string;
  readonly category: OperationCategory;
  /** 도메인 segment 배열. 예: `["device"]`, 중첩이면 `["admin", "users"]`. */
  readonly domain: readonly string[];
  readonly operation: string;
}

export type Authorize = (
  context: BridgeContext,
  operation: BridgeOperation,
) => boolean | Promise<boolean>;
export type RejectReason =
  | "frame-not-main"
  | "origin-not-allowed"
  | "sender-unauthorized"
  | "authorize-denied"
  | "version-mismatch"
  | "malformed-envelope"
  | "unknown-operation"
  | "invalid-input"
  | "payload-too-large"
  | "rpc-limit"
  | "subscription-limit";

export interface DiagnosticsSnapshot {
  readonly sessions: number;
  readonly rpcInFlight: number;
  readonly subscriptions: number;
  readonly queuedEvents: number;
}

export type BridgeDiagnostic =
  | {
      readonly type: "rpc-finished";
      readonly key: string;
      readonly durationMs: number;
      readonly outcome: "ok" | "error";
    }
  | { readonly type: "rpc-timed-out"; readonly key: string }
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
    }
  | {
      readonly type: "rejected";
      readonly reason: RejectReason;
      readonly key?: string;
    }
  | { readonly type: "session-opened" }
  | { readonly type: "session-closed" }
  | { readonly type: "subscription-opened"; readonly key: string }
  | { readonly type: "subscription-closed"; readonly key: string };
export interface DiagnosticsSink {
  record(event: BridgeDiagnostic): void;
}

export type RpcHandler = (
  input: BridgeValue,
  context: BridgeContext,
) => Promise<BridgeValue> | BridgeValue;
