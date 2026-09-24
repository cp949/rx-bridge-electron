import { Observable, Subscriber, type Subscription } from "rxjs";

import {
  parseOpaqueIdSequence,
  type BridgeValue,
  type PayloadLimits,
  type RpcErrorPayload,
  type StreamMessage,
  type WireStreamCommand,
} from "../protocol/index.js";
import { BoundedQueue } from "./bounded-queue.js";
import { recordDiagnostic } from "./diagnostics.js";
import type { DocumentSession } from "./document-sessions.js";
import { serializeError } from "./error-serializer.js";
import { parseOutput } from "./output-boundary.js";
import type {
  EventRegistrationEntry,
  RegistrationTable,
  StateRegistrationEntry,
} from "./registration.js";
import type { ResourceLimits } from "./resource-limits.js";
import type { EventSource, ScopedEventSource } from "./sources.js";
import type {
  Authorize,
  BridgeContext,
  DiagnosticsSink,
  SenderIdentity,
} from "./types.js";

export type StreamSender = (message: StreamMessage) => void;

type Registration = StateRegistrationEntry | EventRegistrationEntry;
type SubscribeCommand = Extract<WireStreamCommand, { type: "subscribe" }>;
type ControlCommand = Exclude<WireStreamCommand, { type: "subscribe" }>;

interface SharedSource {
  readonly source: Observable<BridgeValue>;
  readonly consumers: Set<Consumer>;
  upstream?: Subscription;
}

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
  readonly shared?: SharedSource;
  sourceDetached: boolean;
  own?: Subscription;
  pendingState: BridgeValue;
  hasPendingState: boolean;
  pendingEvents?: BoundedQueue<BridgeValue>;
  inFlight: number | undefined;
  terminal:
    | { readonly type: "complete" }
    | { readonly type: "error"; readonly error: RpcErrorPayload }
    | undefined;
  sequence: number;
  closed: boolean;
}

/** 세션 1개가 소유한 구독 상태. `pending`+`consumers` 합이 slot 점유 수다. */
interface SessionState {
  watermark: number;
  readonly pending: Map<string, PendingEntry>;
  readonly consumers: Map<string, Consumer>;
}

const internalError: RpcErrorPayload = {
  code: "INTERNAL",
  message: "Internal bridge error.",
};
const overflowError: RpcErrorPayload = {
  code: "STREAM_OVERFLOW",
  message: "Event buffer capacity exceeded.",
};

/**
 * 구독(subscription) 1건의 수명주기 전체(admission부터 terminal·slot 반환까지)를
 * 소유한다. server(`create-bridge-server.ts`)는 세션 해석과 `sender-unauthorized`
 * 판정만 하고, subscriptionId 파싱·watermark·등록 조회·slot·`authorize` 대기·
 * consumer·교차 세션 fan-out·terminal은 이 모듈이 맡는다.
 */
export class Subscriptions {
  readonly #registrations = new Map<string, Registration>();
  readonly #shared = new Map<string, SharedSource>();
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
    this.#limits = limits;
    this.#resourceLimits = resourceLimits;
    this.#diagnostics = diagnostics;
    this.#authorize = authorize;
    for (const entry of table.state.values())
      this.#registrations.set(
        `state:${entry.domainName}/${entry.operation}`,
        entry,
      );
    for (const entry of table.event.values())
      this.#registrations.set(
        `event:${entry.domainName}/${entry.operation}`,
        entry,
      );
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
        count += consumer.pendingEvents?.length ?? 0;
    return count;
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
      this.#reject(
        command,
        send,
        { code: "INVALID_ARGUMENT", message: "Invalid bridge subscription ID." },
        session.signal,
      );
      return;
    }
    const state = this.#state(session);
    if (sequence <= state.watermark) return;
    state.watermark = sequence;

    const registration = this.#registrations.get(command.key);
    if (registration === undefined) {
      recordDiagnostic(this.#diagnostics, {
        type: "rejected",
        reason: "unknown-operation",
      });
      this.#reject(
        command,
        send,
        { code: "NOT_FOUND", message: "Unknown bridge stream." },
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
      this.#reject(
        command,
        send,
        {
          code: "RESOURCE_EXHAUSTED",
          message: "Too many bridge subscriptions.",
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
      },
    };
    state.pending.set(command.subscriptionId, entry);
    this.#liveStates.add(state);
    session.signal.addEventListener("abort", entry.onAbort, { once: true });
    if (session.signal.aborted) {
      session.signal.removeEventListener("abort", entry.onAbort);
      state.pending.delete(command.subscriptionId);
      this.#pruneIfEmpty(state);
      return;
    }

    const context: BridgeContext = {
      requestId: command.subscriptionId,
      clientId: command.clientId,
      windowRole: session.target.role,
      sender,
      signal: controller.signal,
    };
    let allowed: boolean;
    try {
      allowed =
        this.#authorize === undefined
          ? true
          : await this.#authorize(context, command.key);
    } catch {
      if (this.#finishPending(session, state, command.subscriptionId, entry))
        this.#reject(
          command,
          send,
          { code: "INTERNAL", message: "Internal bridge error." },
          session.signal,
        );
      return;
    }
    if (!this.#finishPending(session, state, command.subscriptionId, entry))
      return;
    if (!allowed) {
      recordDiagnostic(this.#diagnostics, {
        type: "rejected",
        reason: "authorize-denied",
        key: command.key,
      });
      this.#reject(
        command,
        send,
        { code: "FORBIDDEN", message: "Bridge operation is forbidden." },
        session.signal,
      );
      return;
    }
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
      if (consumer !== undefined && !consumer.closed) this.#close(consumer);
      return;
    }
    const consumer = state.consumers.get(command.subscriptionId);
    if (consumer === undefined || consumer.closed) return;
    if (consumer.inFlight !== command.sequence) return;
    consumer.inFlight = undefined;
    this.#flush(consumer);
  }

  public dispose(): void {
    for (const state of [...this.#liveStates]) {
      for (const pending of [...state.pending.values()]) pending.controller.abort();
      state.pending.clear();
      for (const consumer of [...state.consumers.values()])
        if (!consumer.closed) this.#close(consumer);
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
   * `authorize` 대기가 여전히 유효한지 확인하고 slot을 반환한다(성공·실패
   * 무관하게 반환은 항상 일어난다). `false`면 이미 취소됐거나(unsubscribe·
   * retire) signal이 abort된 것이므로 `subscribe()`는 이어서 진행하지 않는다.
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
    const consumer: Consumer = {
      session,
      key: command.key,
      clientId: command.clientId,
      subscriptionId: command.subscriptionId,
      sender,
      send,
      registration,
      controller,
      onSessionAbort: () => this.#close(consumer),
      sourceDetached: false,
      pendingState: undefined,
      hasPendingState: false,
      inFlight: undefined,
      terminal: undefined,
      sequence: 0,
      closed: false,
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
      this.#close(consumer);
      return;
    }
    this.#send(consumer, { type: "subscribed", sequence: 0 });
    if (consumer.closed) return;
    if (registration.kind === "event") {
      consumer.pendingEvents = new BoundedQueue(
        registration.buffer.capacity,
        registration.buffer.overflow,
      );
    }
    try {
      if (
        registration.kind === "event" &&
        this.#isScoped(registration.source)
      ) {
        const context: BridgeContext = {
          requestId: command.subscriptionId,
          clientId: command.clientId,
          windowRole: session.target.role,
          sender,
          signal: controller.signal,
        };
        const source = registration.source.factory(context);
        if (consumer.closed) return;
        if (!(source instanceof Observable))
          throw new TypeError("Scoped factory must return an Observable.");
        const upstream = new Subscriber<BridgeValue>(this.#observer(consumer));
        consumer.own = upstream;
        source.subscribe(upstream);
      } else {
        const source =
          registration.kind === "state"
            ? registration.source
            : this.#broadcastSource(registration.source);
        let shared = this.#shared.get(command.key);
        if (shared === undefined) {
          shared = { source, consumers: new Set() };
          this.#shared.set(command.key, shared);
        }
        (consumer as { shared?: SharedSource }).shared = shared;
        const startsUpstream = shared.consumers.size === 0;
        shared.consumers.add(consumer);
        if (startsUpstream) {
          const upstream = new Subscriber<BridgeValue>({
            next: (value) => {
              for (const member of [...shared.consumers])
                this.#next(member, value);
            },
            error: (error: unknown) => {
              for (const member of [...shared.consumers])
                this.#terminate(member, {
                  type: "error",
                  error: serializeError(error, [], this.#limits),
                });
            },
            complete: () => {
              for (const member of [...shared.consumers])
                this.#terminate(member, { type: "complete" });
            },
          });
          shared.upstream = upstream;
          source.subscribe(upstream);
          if (shared.consumers.size === 0) upstream.unsubscribe();
        } else if (registration.kind === "state") {
          this.#next(consumer, registration.source.getValue());
        }
      }
    } catch {
      this.#terminate(consumer, { type: "error", error: internalError });
    }
  }

  #reject(
    command: SubscribeCommand,
    send: StreamSender,
    error: RpcErrorPayload,
    sessionSignal: AbortSignal,
  ): void {
    if (sessionSignal.aborted) return;
    try {
      send({
        protocolVersion: 1,
        clientId: command.clientId,
        subscriptionId: command.subscriptionId,
        type: "subscribed",
        sequence: 0,
      });
      if (sessionSignal.aborted) return;
      send({
        protocolVersion: 1,
        clientId: command.clientId,
        subscriptionId: command.subscriptionId,
        type: "error",
        sequence: 1,
        error,
      });
    } catch {
      // A closed renderer route has no subscriber to notify.
    }
  }

  #isScoped(source: EventSource): source is ScopedEventSource<BridgeValue> {
    return !(source instanceof Observable) && source.mode === "scoped";
  }

  #broadcastSource(source: EventSource): Observable<BridgeValue> {
    return source instanceof Observable
      ? source
      : source.mode === "broadcast"
        ? source.source
        : (() => {
            throw new TypeError("Scoped source needs context.");
          })();
  }

  #observer(consumer: Consumer) {
    return {
      next: (value: BridgeValue) => this.#next(consumer, value),
      error: (error: unknown) =>
        this.#terminate(consumer, {
          type: "error",
          error: serializeError(error, [], this.#limits),
        }),
      complete: () => this.#terminate(consumer, { type: "complete" }),
    };
  }

  #next(consumer: Consumer, raw: unknown): void {
    if (consumer.closed || consumer.terminal !== undefined) return;
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
    if (consumer.registration.kind === "state") {
      consumer.pendingState = value;
      consumer.hasPendingState = true;
    } else {
      const queue = consumer.pendingEvents;
      if (queue === undefined) return;
      const result = queue.push(value);
      if (result.dropped > 0)
        recordDiagnostic(this.#diagnostics, {
          type: "stream-dropped",
          key: consumer.key,
          count: result.dropped,
        });
      recordDiagnostic(this.#diagnostics, {
        type: "stream-queue",
        key: consumer.key,
        depth: queue.length,
      });
      if (result.overflow)
        this.#terminate(consumer, { type: "error", error: overflowError });
    }
    this.#flush(consumer);
  }

  #flush(consumer: Consumer): void {
    if (consumer.closed || consumer.inFlight !== undefined) return;
    let hasValue = false;
    let value: BridgeValue;
    if (consumer.registration.kind === "state" && consumer.hasPendingState) {
      hasValue = true;
      value = consumer.pendingState;
      consumer.pendingState = undefined;
      consumer.hasPendingState = false;
    } else if (
      consumer.registration.kind === "event" &&
      (consumer.pendingEvents?.length ?? 0) > 0
    ) {
      hasValue = true;
      value = consumer.pendingEvents?.shift();
      recordDiagnostic(this.#diagnostics, {
        type: "stream-queue",
        key: consumer.key,
        depth: consumer.pendingEvents?.length ?? 0,
      });
    }
    if (hasValue) {
      const sequence = ++consumer.sequence;
      consumer.inFlight = sequence;
      this.#send(consumer, { type: "batch", sequence, values: [value] });
      return;
    }
    if (consumer.terminal !== undefined) {
      this.#send(consumer, {
        ...consumer.terminal,
        sequence: ++consumer.sequence,
      });
      this.#close(consumer);
    }
  }

  #terminate(
    consumer: Consumer,
    terminal: NonNullable<Consumer["terminal"]>,
  ): void {
    if (consumer.closed || consumer.terminal !== undefined) return;
    consumer.terminal = terminal;
    this.#detachSource(consumer);
    this.#flush(consumer);
  }

  #send(
    consumer: Consumer,
    message:
      | { readonly type: "subscribed" | "complete"; readonly sequence: number }
      | {
          readonly type: "batch";
          readonly sequence: number;
          readonly values: readonly BridgeValue[];
        }
      | {
          readonly type: "error";
          readonly sequence: number;
          readonly error: RpcErrorPayload;
        },
  ): void {
    try {
      consumer.send({
        protocolVersion: 1,
        clientId: consumer.clientId,
        subscriptionId: consumer.subscriptionId,
        ...message,
      } as StreamMessage);
    } catch {
      this.#close(consumer);
    }
  }

  #detachSource(consumer: Consumer): void {
    if (consumer.sourceDetached) return;
    consumer.sourceDetached = true;
    consumer.own?.unsubscribe();
    const shared = consumer.shared;
    if (shared !== undefined) {
      shared.consumers.delete(consumer);
      if (shared.consumers.size === 0) {
        shared.upstream?.unsubscribe();
        if (this.#shared.get(consumer.key) === shared)
          this.#shared.delete(consumer.key);
      }
    }
  }

  #close(consumer: Consumer): void {
    if (consumer.closed) return;
    consumer.closed = true;
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
    this.#detachSource(consumer);
  }
}
