import {
  parseOpaqueIdSequence,
  withEnvelope,
  type BridgeValue,
  type PayloadLimits,
  type RpcErrorPayload,
  type StreamMessage,
  type WireStreamCommand,
} from "../protocol/index.js";
import { authorizeOperation, bridgeContext } from "./authorization.js";
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
} from "./document-sessions.js";
import { internalError } from "./error-serializer.js";
import { parseOutput } from "./output-boundary.js";
import type {
  EventRegistrationEntry,
  RegistrationTable,
  StateRegistrationEntry,
} from "./registration.js";
import type { ResourceLimits } from "./resource-limits.js";
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
  /** consumer 1건의 전달 창(RD-034). "닫힘"은 이 창이 단독 소유한다. */
  readonly window: DeliveryWindow;
  /**
   * `subscribed`(0) 송신 여부. 송신 직전에 켠다. `onSessionAbort`가 이 값으로
   * retire 처리를 가른다 — 꺼져 있으면(시작 전) 거부 전용 창으로 통지하고,
   * 켜져 있으면(활성) 이 창을 `preempt`한다.
   */
  opened: boolean;
}

/** 세션 1개가 소유한 구독 상태. `pending`+`consumers` 합이 slot 점유 수다. */
interface SessionState {
  watermark: number;
  readonly pending: Map<string, PendingEntry>;
  readonly consumers: Map<string, Consumer>;
}

const senderUnauthorizedError: RpcErrorPayload = {
  code: "FORBIDDEN",
  message: SENDER_UNAUTHORIZED_MESSAGE,
};
/** detach·`server.dispose()`로 살아 있는 문서의 세션이 끝날 때 스트림에 보내는 종료 사유. */
const sessionEndedError: RpcErrorPayload = {
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
 * session이 없거나 살아 있으면 `rejected.error`(`retired`는 항상 aborted라 이
 * 분기에 오지 않는다), aborted고 사유가 `detach`·`dispose`면 `CANCELLED`, 그 외
 * aborted 사유는 침묵한다. `undefined`면 아무것도 보내지 않는다.
 */
function endNotice(
  cause: EndCause,
  sessionSignal?: AbortSignal,
): RpcErrorPayload | undefined {
  if (cause.kind === "admission") return senderUnauthorizedError;
  if (sessionSignal === undefined || !sessionSignal.aborted)
    return cause.kind === "rejected" ? cause.error : undefined;
  return sessionSignal.reason === "detach" || sessionSignal.reason === "dispose"
    ? sessionEndedError
    : undefined;
}

/**
 * `WindowMessage`를 wire `StreamMessage`로 조립하는 순수 함수. envelope
 * 조립(`withEnvelope`)을 이 함수 하나로 모은다 — 창(`DeliveryWindow`)은
 * envelope도 `subscriptionId`도 모른다(RD-034 결정 3 유지).
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
 * consumer 1건의 전달 창(`DeliveryWindow`, RD-034)이 "수락 → ack 대기 → 다음
 * 값 | terminal"과 선점 종료를 소유한다. 이 클래스는 값·ack·세션 종료를
 * 창에 넘기고, 창이 돌려준 메시지를 envelope로 감싸 보낸다.
 *
 * upstream 연결(State·broadcast Event 공유, scoped Event 개별)은 내부 module
 * `Upstreams`가 소유한다. 이 클래스는 consumer를 토큰으로 연결·해제만 한다.
 */
export class Subscriptions {
  readonly #table: RegistrationTable;
  readonly #upstreams = new Upstreams();
  readonly #sessions = new WeakMap<DocumentSession, SessionState>();
  /**
   * 구독을 하나 이상 가진 세션의 `SessionState`만 담는다(비면 즉시 제거) — 진단
   * 집계(`subscriptionCount`·`queuedEventsCount`)에 필요한 순회 수단이다. 세션별
   * 상태 자체는 `#sessions`(WeakMap)가 세션 수명에 맞춰 소유한다.
   */
  readonly #liveStates = new Set<SessionState>();
  readonly #limits: PayloadLimits;
  readonly #resourceLimits: ResourceLimits;
  readonly #diagnostics: DiagnosticsSink | undefined;
  readonly #authorize: Authorize | undefined;

  public constructor(
    table: RegistrationTable,
    limits: PayloadLimits,
    resourceLimits: ResourceLimits,
    diagnostics?: DiagnosticsSink,
    authorize?: Authorize,
  ) {
    this.#table = table;
    this.#limits = limits;
    this.#resourceLimits = resourceLimits;
    this.#diagnostics = diagnostics;
    this.#authorize = authorize;
  }

  public subscriptionCount(): number {
    let count = 0;
    for (const state of this.#liveStates)
      count += state.pending.size + state.consumers.size;
    return count;
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
          },
        },
        session.signal,
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
          error: { code: "NOT_FOUND", message: "Unknown bridge stream." },
        },
        session.signal,
      );
      return;
    }

    if (
      state.pending.size + state.consumers.size >=
      this.#resourceLimits.maxSubscriptions
    ) {
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
          },
        },
        session.signal,
      );
      return;
    }

    const controller = new AbortController();
    const entry: PendingEntry = {
      controller,
      onAbort: () => {
        state.pending.delete(command.subscriptionId);
        this.#pruneIfEmpty(state);
        controller.abort();
        this.#endUnstarted(command, send, { kind: "retired" }, session.signal);
      },
    };
    state.pending.set(command.subscriptionId, entry);
    this.#liveStates.add(state);
    session.signal.addEventListener("abort", entry.onAbort, { once: true });
    if (session.signal.aborted) {
      // 세션이 등록 이전에 이미 retire됐다 — "abort" listener는 지난 이벤트를
      // 받지 못하므로 여기서 직접 `onAbort`를 불러 같은 처리(삭제·prune·
      // controller.abort()·통지, ADR 0020)를 맡긴다.
      session.signal.removeEventListener("abort", entry.onAbort);
      entry.onAbort();
      return;
    }

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
    if (!this.#finishPending(session, state, command.subscriptionId, entry))
      return;
    if (verdict.type === "rejected") {
      this.#endUnstarted(
        command,
        send,
        { kind: "rejected", error: verdict.error },
        session.signal,
      );
      return;
    }
    if (verdict.type === "cancelled") return;
    this.#start(session, state, sender, command, send, registration);
  }

  public control(session: DocumentSession, command: ControlCommand): void {
    const state = this.#sessions.get(session);
    if (state === undefined) return;
    if (command.type === "unsubscribe") {
      const pending = state.pending.get(command.subscriptionId);
      if (pending !== undefined) {
        state.pending.delete(command.subscriptionId);
        this.#pruneIfEmpty(state);
        session.signal.removeEventListener("abort", pending.onAbort);
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
      for (const pending of [...state.pending.values()])
        pending.controller.abort();
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
   * `authorize` 대기가 여전히 유효한지 확인하고 slot을 반환한다. authorize
   * 판정 뒤, 번역 전에 호출된다 — `authorize-denied` 진단은 이 호출보다
   * 먼저(공유 단계 안에서) 기록되므로 slot 반환보다 앞선다(RPC와 같은 순서).
   * 그 사이 sink가 동기로 detach·dispose를 일으키면 아직 등록된 pending
   * `onAbort`가 retire 통지를 맡는다. `false`면 이미 취소됐거나(unsubscribe·
   * retire) signal이 abort된 것이므로 `subscribe()`는 이어서 진행하지 않는다.
   * (등록 직후, 이 메서드에 닿기 전에 이미 retire된 경우는 호출부가 같은
   * `entry.onAbort`를 직접 불러 처리한다 — RD-037.)
   */
  #finishPending(
    session: DocumentSession,
    state: SessionState,
    id: string,
    entry: PendingEntry,
  ): boolean {
    const current = state.pending.get(id);
    if (current !== entry) return false;
    const ok = !entry.controller.signal.aborted && !session.signal.aborted;
    state.pending.delete(id);
    this.#pruneIfEmpty(state);
    session.signal.removeEventListener("abort", entry.onAbort);
    return ok;
  }

  #start(
    session: DocumentSession,
    state: SessionState,
    sender: SenderIdentity,
    command: SubscribeCommand,
    send: StreamSender,
    registration: Registration,
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
      onSessionAbort: () => {
        if (!consumer.opened) {
          // `subscribed` 송신 전 retire(시작 전 거부와 같은 창) — 활성 구독의
          // `preempt` 대신 `#endUnstarted`가 sequence 0·1을 매겨 통지한다.
          this.#close(consumer);
          this.#endUnstarted(
            command,
            send,
            { kind: "retired" },
            session.signal,
          );
          return;
        }
        const error = endNotice({ kind: "retired" }, session.signal);
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
    session.signal.addEventListener("abort", consumer.onSessionAbort, {
      once: true,
    });
    if (session.signal.aborted) {
      // 세션이 등록 이전에 이미 retire됐다 — "abort" listener는 지난 이벤트를
      // 받지 못하므로 여기서 직접 `onSessionAbort`를 불러 open 전 분기를 태운다.
      consumer.onSessionAbort();
      return;
    }
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
   * 송신 전 retire된 consumer, RD-037)의 통지: `subscribed`(0) 전후로
   * `endNotice`를 평가해 `error`(1)를 보낸다. 앞 평가는 진단 sink가 동기로
   * 일으킨 retire를, 뒤 평가는 `send` 중 동기 retire를 반영한다. 거부 전용
   * 창(`createRejectionDeliveryWindow`)이 두 sequence를 매긴다. 전송 실패는
   * 삼킨다(ADR 0020 결정 6).
   */
  #endUnstarted(
    command: SubscribeCommand,
    send: StreamSender,
    cause: EndCause,
    sessionSignal?: AbortSignal,
  ): void {
    if (endNotice(cause, sessionSignal) === undefined) return;
    const window = createRejectionDeliveryWindow();
    try {
      send(
        streamFrame(command.clientId, command.subscriptionId, window.open()),
      );
      const error = endNotice(cause, sessionSignal);
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
    consumer.session.signal.removeEventListener(
      "abort",
      consumer.onSessionAbort,
    );
    const state = this.#sessions.get(consumer.session);
    if (state !== undefined) {
      state.consumers.delete(consumer.subscriptionId);
      this.#pruneIfEmpty(state);
    }
    consumer.controller.abort();
    this.#upstreams.disconnect(consumer);
  }
}
