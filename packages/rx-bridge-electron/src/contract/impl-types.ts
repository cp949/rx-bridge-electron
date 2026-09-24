import type { Observable } from "rxjs";

import type { BridgeValue } from "../protocol/index.js";

/**
 * `BridgeImpl<B>`가 참조하는 Main 구현 측 타입. `contract`는 `main`을 import하지
 * 않으므로 정의는 여기 두고 `main`이 re-export한다. source를 만드는 런타임
 * 함수(`currentValueSource`·`broadcastEvent`·`scopedEvent`)는 `main/sources.ts`에 있다.
 */

export interface SenderIdentity {
  readonly webContentsId: number;
  readonly frameId: number;
  readonly isMainFrame: boolean;
  readonly origin: string;
}

export interface BridgeContext {
  readonly requestId: string;
  readonly clientId: string;
  readonly windowRole: string;
  readonly sender: SenderIdentity;
  readonly signal: AbortSignal;
}

export interface CurrentValueSource<T> extends Observable<T> {
  getValue(): T;
}

/** Event source 버퍼가 가득 찼을 때의 처리 정책. */
export type OverflowPolicy = "error" | "drop-oldest" | "drop-newest";

/**
 * Event source의 배압 버퍼 설정. `broadcastEvent`·`scopedEvent` 호출 시
 * 값을 줄 수 있지만, 생략 시 기본값 적용과 `capacity`·`overflow` 값 검증은
 * `main/registration.ts`의 `buildRegistrationTableFromImpl`(등록 단계)이
 * 한다 — 두 helper는 검증하지 않는 순수 생성자다. 헬퍼 없이 직접 작성한
 * source 객체 리터럴도 같은 등록 단계에서 같은 규칙으로 검증된다.
 */
export interface EventSourceBuffer {
  readonly capacity: number;
  readonly overflow: OverflowPolicy;
}

export interface BroadcastEventSource<T> {
  readonly mode: "broadcast";
  readonly source: Observable<T>;
  readonly buffer?: EventSourceBuffer;
}

export interface ScopedEventSource<T> {
  readonly mode: "scoped";
  readonly factory: (context: BridgeContext) => Observable<T>;
  readonly buffer?: EventSourceBuffer;
}

export type EventSource<T extends BridgeValue = BridgeValue> =
  Observable<T> | BroadcastEventSource<T> | ScopedEventSource<T>;
