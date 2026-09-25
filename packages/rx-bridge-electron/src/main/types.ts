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

/**
 * 등록 조회를 통과한 뒤에만 판정되는 사유 — `rejected` 진단에 `key`가 반드시
 * 있다(ADR 0010 §6). `invalid-input`은 RPC 입력 검증(key 있음)과 subscriptionId
 * 형식 오류(key 없음) 두 경로에서 나오므로 어느 쪽에도 넣지 않는다.
 */
type KeyedRejectReason =
  "authorize-denied" | "payload-too-large" | "rpc-limit" | "subscription-limit";

/** 등록 조회 전에 판정되는 사유 — `rejected` 진단에 `key`를 넣지 않는다(ADR 0010 §6). */
export type UnkeyedRejectReason = Exclude<
  RejectReason,
  KeyedRejectReason | "invalid-input"
>;

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
      readonly reason: KeyedRejectReason;
      readonly key: string;
    }
  | {
      readonly type: "rejected";
      readonly reason: UnkeyedRejectReason;
      readonly key?: never;
    }
  | {
      readonly type: "rejected";
      readonly reason: "invalid-input";
      readonly key?: string;
    }
  | { readonly type: "session-opened" }
  | { readonly type: "session-closed" }
  | { readonly type: "subscription-opened"; readonly key: string }
  | { readonly type: "subscription-closed"; readonly key: string }
  /**
   * 사용자 State·Event source의 teardown이 upstream 해지 중 예외를 던졌다
   * (RD-045). 예외는 삼키고 정리는 끝난다. 구독이 아니라 upstream 단위라
   * 구독을 닫은 뒤 해지하는 경로에서는 그 구독의 `subscription-closed` 뒤에
   * 기록된다.
   */
  | { readonly type: "upstream-teardown-failed"; readonly key: string };
export interface DiagnosticsSink {
  record(event: BridgeDiagnostic): void;
}

export type RpcHandler = (
  input: BridgeValue,
  context: BridgeContext,
) => Promise<BridgeValue> | BridgeValue;
