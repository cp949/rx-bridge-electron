import {
  parseOpaqueIdSequence,
  withEnvelope,
  type BridgeValue,
  type PayloadLimits,
  type RpcErrorPayload,
  type StreamMessage,
  type WireStreamCommand,
} from "../protocol/index.js";
import type { LibraryErrorPayload } from "../protocol/messages.js";
import {
  authorizeOperation,
  bridgeContext,
  type AuthorizeVerdict,
} from "./authorization.js";
import {
  createEventDeliveryWindow,
  createRejectionDeliveryWindow,
  createStateDeliveryWindow,
  type DeliveryWindow,
  type WindowMessage,
  type WindowTerminal,
} from "./delivery-window.js";
import { recordDiagnostic } from "./diagnostics.js";
import {
  SENDER_UNAUTHORIZED_MESSAGE,
  type DocumentSession,
  type RetireReason,
} from "./document-sessions.js";
import { internalError } from "./error-serializer.js";
import { parseOutput } from "./output-boundary.js";
import type {
  EventRegistrationEntry,
  RegistrationTable,
  StateRegistrationEntry,
} from "./registration.js";
import type { ResourceLimits } from "./resource-limits.js";
import { SessionSlots, type SlotLease } from "./session-slots.js";
import type { Authorize, DiagnosticsSink, SenderIdentity } from "./types.js";
import { Upstreams } from "./upstreams.js";

export type StreamSender = (message: StreamMessage) => void;

type Registration = StateRegistrationEntry | EventRegistrationEntry;
type SubscribeCommand = Extract<WireStreamCommand, { type: "subscribe" }>;
type ControlCommand = Exclude<WireStreamCommand, { type: "subscribe" }>;

/** authorize 대기 중인 구독 하나. 결정되면 제거되고(성공 시) Consumer로 이어진다. */
interface PendingEntry {
  readonly controller: AbortController;
  readonly onAbort: () => void;
  /** slot lease. 승인되면 `#start`의 `Consumer`가 이어받는다. */
  readonly lease: SlotLease;
}

interface Consumer {
  readonly session: DocumentSession;
  readonly key: string;
  readonly clientId: string;
  readonly subscriptionId: string;
  readonly sender: SenderIdentity;
  readonly send: StreamSender;
  readonly registration: Registration;
  readonly controller: AbortController;
  readonly onSessionAbort: () => void;
  /** slot lease. pending entry에서 이어받는다. */
  readonly lease: SlotLease;
  /** consumer 1건의 전달 창. "닫힘"은 이 창이 단독 소유한다. */
  readonly window: DeliveryWindow;
  /**
   * `subscribed`(0) 송신 여부. 송신 직전에 켠다. `onSessionAbort`가 이 값으로
   * retire 처리를 가른다 — 꺼져 있으면(시작 전) 거부 전용 창으로 통지하고,
   * 켜져 있으면(활성) 이 창을 `preempt`한다.
   */
  opened: boolean;
}

/** 세션 1개가 소유한 구독 상태. slot 점유 수·회수는 `SessionSlots`가 lease로 셈한다 — `pending`·`consumers`는 id → entry map일 뿐이다. */
interface SessionState {
  watermark: number;
  readonly pending: Map<string, PendingEntry>;
  readonly consumers: Map<string, Consumer>;
}

const senderUnauthorizedError: LibraryErrorPayload = {
  code: "FORBIDDEN",
  message: SENDER_UNAUTHORIZED_MESSAGE,
};
/** detach·`server.dispose()`로 살아 있는 문서의 세션이 끝날 때 스트림에 보내는 종료 사유. */
const sessionEndedError: LibraryErrorPayload = {
  code: "CANCELLED",
  message: "Bridge session ended.",
};

/** 구독 종료 통지 판정의 입력. `admission`(sender admission 거부)·`rejected`(시작 전 거부)·`retired`(대기·활성 구독 retire) 중 하나다. */
type EndCause =
  | { readonly kind: "admission" }
  | { readonly kind: "rejected"; readonly error: RpcErrorPayload }
  | { readonly kind: "retired" };

/**
 * cause → 통지 표(ADR 0020). `admission`은 `FORBIDDEN`을 항상 보낸다. 그 외는
 * `retireReason`이 `undefined`면(세션이 없거나 살아 있으면) `rejected.error`
 * (`retired`는 항상 retire된 세션에서만 오므로 이 분기에 오지 않는다), 사유가
 * `detach`·`dispose`면 `CANCELLED`, 그 외 사유는 침묵한다. `undefined`면
 * 아무것도 보내지 않는다.
 */
function endNotice(
  cause: EndCause,
  retireReason?: RetireReason,
): RpcErrorPayload | undefined {
  if (cause.kind === "admission") return senderUnauthorizedError;
  if (retireReason === undefined)
    return cause.kind === "rejected" ? cause.error : undefined;
  return retireReason === "detach" || retireReason === "dispose"
    ? sessionEndedError
    : undefined;
}

/**
 * `WindowMessage`를 wire `StreamMessage`로 조립하는 순수 함수. envelope
 * 조립(`withEnvelope`)을 이 함수 하나로 모은다 — 창(`DeliveryWindow`)은
 * envelope도 `subscriptionId`도 모른다.
 */
function streamFrame(
  clientId: string,
  subscriptionId: string,
  message: WindowMessage,
): StreamMessage {
  return withEnvelope(clientId, { subscriptionId, ...message });
}

/**
 * 구독(subscription) 1건의 수명주기 전체(admission부터 terminal·slot 반환까지)를
 * 소유한다. server(`create-bridge-server.ts`)는 세션 해석과 sender admission
 * 판정(`DocumentSessions#admit` — `frame-not-main`·`origin-not-allowed`·
 * `sender-unauthorized`)만 하고, subscriptionId 파싱·watermark·등록 조회·slot·
 * `authorize` 대기·consumer·교차 세션 fan-out·terminal은 이 모듈이 맡는다.
 *
 * consumer 1건의 전달 창(`DeliveryWindow`)이 "수락 → ack 대기 → 다음
 * 값 | terminal"과 선점 종료를 소유한다. 이 클래스는 값·ack·세션 종료를
 * 창에 넘기고, 창이 돌려준 메시지를 envelope로 감싸 보낸다.
 *
 * upstream 연결(State·broadcast Event 공유, scoped Event 개별)은 내부 module
 * `Upstreams`가 소유한다. 이 클래스는 consumer를 토큰으로 연결·해제만 한다.
 */
export class Subscriptions {
  readonly #table: RegistrationTable;
  readonly #upstreams: Upstreams;
  readonly #sessions = new WeakMap<DocumentSession, SessionState>();
  /**
   * 구독을 하나 이상 가진 세션의 `SessionState`만 담는다(비면 즉시 제거) —
   * `queuedEventsCount`·`dispose` 순회에만 쓰인다(slot 집계는
   * `SessionSlots`가 맡는다). 세션별 상태 자체는 `#sessions`(WeakMap)가 세션
   * 수명에 맞춰 소유한다.
   */
  readonly #liveStates = new Set<SessionState>();
  readonly #limits: PayloadLimits;
  readonly #diagnostics: DiagnosticsSink | undefined;
  readonly #authorize: Authorize | undefined;
  readonly #slots: SessionSlots;

  public constructor(
    table: RegistrationTable,
    limits: PayloadLimits,
    resourceLimits: ResourceLimits,
    diagnostics?: DiagnosticsSink,
    authorize?: Authorize,
  ) {
    this.#table = table;
    this.#limits = limits;
    this.#diagnostics = diagnostics;
    this.#authorize = authorize;
    this.#slots = new SessionSlots(resourceLimits.maxSubscriptions);
    this.#upstreams = new Upstreams((key) =>
      recordDiagnostic(diagnostics, { type: "upstream-teardown-failed", key }),
    );
  }

  public subscriptionCount(): number {
    return this.#slots.count();
  }

  public queuedEventsCount(): number {
    let count = 0;
    for (const state of this.#liveStates)
      for (const consumer of state.consumers.values())
        count += consumer.window.queuedValueCount();
    return count;
  }

  /** sender admission 거부(server가 판정)의 wire 응답: `subscribed`(0)+`FORBIDDEN error`(1). */
  public rejectAdmission(command: SubscribeCommand, send: StreamSender): void {
    this.#endUnstarted(command, send, { kind: "admission" });
  }

  public async subscribe(
    session: DocumentSession,
    sender: SenderIdentity,
    command: SubscribeCommand,
    send: StreamSender,
  ): Promise<void> {
    const sequence = parseOpaqueIdSequence(command.subscriptionId);
    if (sequence === undefined) {
      recordDiagnostic(this.#diagnostics, {
        type: "rejected",
        reason: "invalid-input",
      });
      this.#endUnstarted(
        command,
        send,
        {
          kind: "rejected",
          error: {
            code: "INVALID_ARGUMENT",
            message: "Invalid bridge subscription ID.",
          } satisfies LibraryErrorPayload,
        },
        session,
      );
      return;
    }
    const state = this.#state(session);
    if (sequence <= state.watermark) return;
    state.watermark = sequence;

    const registration =
      this.#table.state.get(command.key) ?? this.#table.event.get(command.key);
    if (registration === undefined) {
      recordDiagnostic(this.#diagnostics, {
        type: "rejected",
        reason: "unknown-operation",
      });
      this.#endUnstarted(
        command,
        send,
        {
          kind: "rejected",
          error: {
            code: "NOT_FOUND",
            message: "Unknown bridge stream.",
          } satisfies LibraryErrorPayload,
        },
        session,
      );
      return;
    }

    const lease = this.#slots.acquire(session);
    if (lease === undefined) {
      recordDiagnostic(this.#diagnostics, {
        type: "rejected",
        reason: "subscription-limit",
        key: command.key,
      });
      this.#endUnstarted(
        command,
        send,
        {
          kind: "rejected",
          error: {
            code: "RESOURCE_EXHAUSTED",
            message: "Too many bridge subscriptions.",
          } satisfies LibraryErrorPayload,
        },
        session,
      );
      return;
    }

    const controller = new AbortController();
    const entry: PendingEntry = {
      controller,
      lease,
      onAbort: () => {
        state.pending.delete(command.subscriptionId);
        lease.release();
        this.#pruneIfEmpty(state);
        controller.abort();
        this.#endUnstarted(command, send, { kind: "retired" }, session);
      },
    };
    state.pending.set(command.subscriptionId, entry);
    this.#liveStates.add(state);
    // 세션이 등록 이전에 이미 retire됐으면 `lease.onRetire`가 여기서
    // `entry.onAbort`를 즉시 동기 호출한다(같은 처리: 삭제·release·prune·
    // controller.abort()·통지, ADR 0020) — 이 경우 entry는 이미 map에서
    // 빠지고 lease도 release됐으므로 아래 `lease.released`로 감지해 그대로
    // return한다(authorize로 진행하지 않는다).
    lease.onRetire(entry.onAbort);
    if (lease.released) return;

    const context = bridgeContext(
      session,
      sender,
      { requestId: command.subscriptionId, clientId: command.clientId },
      controller.signal,
    );
    const pending = authorizeOperation(
      this.#authorize,
      this.#diagnostics,
      context,
      registration.bridgeOperation,
    );
    const verdict = pending instanceof Promise ? await pending : pending;
    if (
      !this.#finishPending(
        session,
        state,
        command.subscriptionId,
        entry,
        verdict,
      )
    )
      return;
    if (verdict.type === "rejected") {
      this.#endUnstarted(
        command,
        send,
        { kind: "rejected", error: verdict.error },
        session,
      );
      return;
    }
    if (verdict.type === "cancelled") return;
    this.#start(session, state, sender, command, send, registration, lease);
  }

  public control(session: DocumentSession, command: ControlCommand): void {
    const state = this.#sessions.get(session);
    if (state === undefined) return;
    if (command.type === "unsubscribe") {
      const pending = state.pending.get(command.subscriptionId);
      if (pending !== undefined) {
        state.pending.delete(command.subscriptionId);
        this.#pruneIfEmpty(state);
        pending.lease.release();
        pending.controller.abort();
        return;
      }
      const consumer = state.consumers.get(command.subscriptionId);
      if (consumer !== undefined) this.#close(consumer);
      return;
    }
    const consumer = state.consumers.get(command.subscriptionId);
    if (consumer === undefined) return;
    const message = consumer.window.ack(command.sequence);
    if (message !== undefined) this.#send(consumer, message);
  }

  public dispose(): void {
    for (const state of [...this.#liveStates]) {
      for (const pending of [...state.pending.values()]) {
        pending.lease.release();
        pending.controller.abort();
      }
      state.pending.clear();
      for (const consumer of [...state.consumers.values()])
        this.#close(consumer);
    }
  }

  #state(session: DocumentSession): SessionState {
    let state = this.#sessions.get(session);
    if (state === undefined) {
      state = { watermark: 0, pending: new Map(), consumers: new Map() };
      this.#sessions.set(session, state);
    }
    return state;
  }

  #pruneIfEmpty(state: SessionState): void {
    if (state.pending.size === 0 && state.consumers.size === 0)
      this.#liveStates.delete(state);
  }

  /**
   * `authorize` 대기가 여전히 유효한지 확인하고 pending 등록을 정리한다.
   * authorize 판정 뒤, 번역 전에 호출된다 — `authorize-denied` 진단은 이
   * 호출보다 먼저(공유 단계 안에서) 기록되므로 slot 정리보다 앞선다(RPC와
   * 같은 순서). 그 사이 sink가 동기로 detach·dispose를 일으키면 아직 등록된
   * pending `onAbort`가 retire 통지와 lease 반환을 맡는다. `false`면 이미
   * 취소됐거나(unsubscribe·retire) 세션이 retire된 것이므로 `subscribe()`는
   * 이어서 진행하지 않는다. (등록 시점에 이미 retire된 세션이면 `onRetire`의
   * 즉시 호출이 그 자리에서 `entry.onAbort`를 대신 실행한다 — ADR 0023.)
   *
   * lease 처리: 승인(`ok`이고 verdict가 `allowed`)이면 `offRetire()`만
   * 불러 slot을 유지한다 — `#start`가 같은 lease를 이어받아 곧바로
   * `consumers.set`하므로 관측 가능한 slot 반환은 없다. 이 이음 구간에는
   * 진단·`send`·`authorize`·source 호출을 넣지 않는다(외부 호출 지점마다
   * slot 수 = pending + consumers). 그 외(거부·취소·`ok`가 false)면
   * `release()`로 slot을 반환한다.
   */
  #finishPending(
    session: DocumentSession,
    state: SessionState,
    id: string,
    entry: PendingEntry,
    verdict: AuthorizeVerdict,
  ): boolean {
    const current = state.pending.get(id);
    if (current !== entry) return false;
    const ok =
      !entry.controller.signal.aborted && session.retireReason === undefined;
    state.pending.delete(id);
    this.#pruneIfEmpty(state);
    if (ok && verdict.type === "allowed") entry.lease.offRetire();
    else entry.lease.release();
    return ok;
  }

  #start(
    session: DocumentSession,
    state: SessionState,
    sender: SenderIdentity,
    command: SubscribeCommand,
    send: StreamSender,
    registration: Registration,
    lease: SlotLease,
  ): void {
    const controller = new AbortController();
    // registration이 이미 capacity·overflow를 검증하고 동결 복사본을
    // 저장했으므로(`registration.ts`의 `normalizeEventBuffer`), 여기서
    // `createEventDeliveryWindow`가 만드는 `BoundedQueue` 생성은 공개
    // seam에서 예외에 도달할 수 없다. 창이 `subscribed`(0)를 반환하므로
    // `subscribed` 송신 앞, try 밖에서 만든다.
    const window: DeliveryWindow =
      registration.kind === "event"
        ? createEventDeliveryWindow(
            registration.buffer.capacity,
            registration.buffer.overflow,
            {
              onDropped: (count) =>
                recordDiagnostic(this.#diagnostics, {
                  type: "stream-dropped",
                  key: command.key,
                  count,
                }),
              onQueueDepth: (depth) =>
                recordDiagnostic(this.#diagnostics, {
                  type: "stream-queue",
                  key: command.key,
                  depth,
                }),
            },
          )
        : createStateDeliveryWindow();
    const consumer: Consumer = {
      session,
      key: command.key,
      clientId: command.clientId,
      subscriptionId: command.subscriptionId,
      sender,
      send,
      registration,
      controller,
      window,
      opened: false,
      lease,
      onSessionAbort: () => {
        if (!consumer.opened) {
          // `subscribed` 송신 전 retire(시작 전 거부와 같은 창) — 활성 구독의
          // `preempt` 대신 `#endUnstarted`가 sequence 0·1을 매겨 통지한다.
          this.#close(consumer);
          this.#endUnstarted(command, send, { kind: "retired" }, session);
          return;
        }
        const error = endNotice({ kind: "retired" }, session.retireReason);
        if (error !== undefined) {
          const message = consumer.window.preempt(error);
          if (message !== undefined) this.#send(consumer, message);
        }
        this.#close(consumer);
      },
    };
    state.consumers.set(command.subscriptionId, consumer);
    this.#liveStates.add(state);
    recordDiagnostic(this.#diagnostics, {
      type: "subscription-opened",
      key: consumer.key,
    });
    // 세션이 등록 이전에 이미 retire됐으면 `lease.onRetire`가 여기서
    // `consumer.onSessionAbort`를 즉시 동기 호출해 open 전 분기(`#close` +
    // `#endUnstarted`)를 태운다. 진단 sink가 동기 unsubscribe·dispose로 창을
    // 먼저 닫았으면 `#close`가 이미 `lease.release()`를 불렀으므로 등록은
    // 남지 않는다 — 세션이 살아 있으면 no-op이고, 이미 retire됐으면 같은
    // 즉시 호출로 open 전 CANCELLED를 통지한다(`SlotLease.onRetire`). 별도
    // 해제가 필요 없다.
    lease.onRetire(consumer.onSessionAbort);
    if (window.closed) return;
    consumer.opened = true;
    this.#send(consumer, window.open());
    if (window.closed) return;
    try {
      const context = bridgeContext(
        session,
        sender,
        { requestId: command.subscriptionId, clientId: command.clientId },
        controller.signal,
      );
      this.#upstreams.connect(consumer, registration, context, {
        next: (value) => this.#next(consumer, value),
        error: () =>
          this.#terminate(consumer, { type: "error", error: internalError }),
        complete: () => this.#terminate(consumer, { type: "complete" }),
      });
    } catch {
      this.#terminate(consumer, { type: "error", error: internalError });
    }
  }

  /**
   * 시작하지 못한 구독(admission 거부, 시작 전 거부, 대기 중 retire, `subscribed`
   * 송신 전 retire된 consumer, ADR 0023)의 통지: `subscribed`(0) 전후로
   * `endNotice`를 평가해 `error`(1)를 보낸다. 앞 평가는 진단 sink가 동기로
   * 일으킨 retire를, 뒤 평가는 `send` 중 동기 retire를 반영한다. 거부 전용
   * 창(`createRejectionDeliveryWindow`)이 두 sequence를 매긴다. 전송 실패는
   * 삼킨다(ADR 0020 결정 6).
   */
  #endUnstarted(
    command: SubscribeCommand,
    send: StreamSender,
    cause: EndCause,
    session?: DocumentSession,
  ): void {
    if (endNotice(cause, session?.retireReason) === undefined) return;
    const window = createRejectionDeliveryWindow();
    try {
      send(
        streamFrame(command.clientId, command.subscriptionId, window.open()),
      );
      const error = endNotice(cause, session?.retireReason);
      if (error === undefined) return;
      const message = window.preempt(error);
      // 거부 경로에서 창을 쥔 쪽은 이 메서드 하나뿐이라 `preempt`가
      // `undefined`(닫힘·종결)를 돌려주는 경우는 도달하지 않는다.
      if (message === undefined) return;
      send(streamFrame(command.clientId, command.subscriptionId, message));
    } catch {
      // A closed renderer route has no subscriber to notify.
    }
  }

  #next(consumer: Consumer, raw: unknown): void {
    // fan-out 순회 스냅샷 안에서 앞 consumer의 동기 send가 이 consumer를
    // 닫거나 terminal을 기록할 수 있다. 검증 전에 확인해 버린다.
    if (!consumer.window.accepting) return;
    let value: BridgeValue;
    try {
      value = parseOutput(consumer.registration.output, raw, this.#limits);
    } catch {
      recordDiagnostic(this.#diagnostics, {
        type: "validation-failed",
        key: consumer.key,
      });
      this.#terminate(consumer, { type: "error", error: internalError });
      return;
    }
    const { message, overflowed } = consumer.window.accept(value);
    if (overflowed) this.#upstreams.disconnect(consumer);
    if (message !== undefined) this.#send(consumer, message);
  }

  #terminate(consumer: Consumer, terminal: WindowTerminal): void {
    const { recorded, message } = consumer.window.end(terminal);
    if (!recorded) return;
    this.#upstreams.disconnect(consumer);
    if (message !== undefined) this.#send(consumer, message);
  }

  #send(consumer: Consumer, message: WindowMessage): void {
    try {
      consumer.send(
        streamFrame(consumer.clientId, consumer.subscriptionId, message),
      );
    } catch {
      this.#close(consumer);
      return;
    }
    if (message.type === "complete" || message.type === "error") {
      this.#close(consumer);
    }
  }

  #close(consumer: Consumer): void {
    if (!consumer.window.close()) return;
    recordDiagnostic(this.#diagnostics, {
      type: "subscription-closed",
      key: consumer.key,
    });
    consumer.lease.release();
    const state = this.#sessions.get(consumer.session);
    if (state !== undefined) {
      state.consumers.delete(consumer.subscriptionId);
      this.#pruneIfEmpty(state);
    }
    consumer.controller.abort();
    this.#upstreams.disconnect(consumer);
  }
}
