import { Observable, Subscriber, type Subscription } from "rxjs";

import type {
  ComposedContract,
  EventDescriptor,
  StateDescriptor,
} from "../contract/index.js";
import {
  type BridgeValue,
  type PayloadLimits,
  type RpcErrorPayload,
  type StreamMessage,
  type WireStreamCommand,
} from "../protocol/index.js";
import { BoundedQueue } from "./bounded-queue.js";
import { serializeError } from "./error-serializer.js";
import { parseOutput } from "./output-boundary.js";
import type {
  CurrentValueSource,
  EventSource,
  ScopedEventSource,
} from "./sources.js";
import type {
  BridgeContext,
  DiagnosticsSink,
  DomainImplementation,
  SenderIdentity,
} from "./types.js";

export type StreamSender = (message: StreamMessage) => void;

type Registration =
  | {
      readonly kind: "state";
      readonly descriptor: StateDescriptor<BridgeValue>;
      readonly source: CurrentValueSource<BridgeValue>;
    }
  | {
      readonly kind: "event";
      readonly descriptor: EventDescriptor<BridgeValue>;
      readonly source: EventSource;
    };

interface SharedSource {
  readonly source: Observable<BridgeValue>;
  readonly consumers: Set<Consumer>;
  upstream?: Subscription;
}

interface Consumer {
  readonly id: string;
  readonly key: string;
  readonly clientId: string;
  readonly subscriptionId: string;
  readonly sender: SenderIdentity;
  readonly send: StreamSender;
  readonly registration: Registration;
  readonly controller: AbortController;
  readonly sessionSignal: AbortSignal;
  readonly onSessionAbort: () => void;
  readonly onClose: () => void;
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

const internalError: RpcErrorPayload = {
  code: "INTERNAL",
  message: "Internal bridge error.",
};
const overflowError: RpcErrorPayload = {
  code: "STREAM_OVERFLOW",
  message: "Event buffer capacity exceeded.",
};

export class StreamHub {
  readonly #registrations = new Map<string, Registration>();
  readonly #shared = new Map<string, SharedSource>();
  readonly #consumers = new Map<string, Consumer>();
  readonly #limits: PayloadLimits;
  readonly #diagnostics: DiagnosticsSink | undefined;

  public constructor(
    contract: ComposedContract,
    implementations: ReadonlyMap<string, DomainImplementation>,
    limits: PayloadLimits,
    diagnostics?: DiagnosticsSink,
  ) {
    this.#limits = limits;
    this.#diagnostics = diagnostics;
    for (const domain of Object.values(contract.domains)) {
      const implementation = implementations.get(domain.name);
      for (const [operation, descriptor] of Object.entries(
        domain.definitions.state ?? {},
      )) {
        const source = implementation?.state?.[operation];
        if (source !== undefined)
          this.#registrations.set(`state:${domain.name}/${operation}`, {
            kind: "state",
            descriptor,
            source,
          });
      }
      for (const [operation, descriptor] of Object.entries(
        domain.definitions.event ?? {},
      )) {
        const source = implementation?.event?.[operation];
        if (source !== undefined)
          this.#registrations.set(`event:${domain.name}/${operation}`, {
            kind: "event",
            descriptor,
            source,
          });
      }
    }
  }

  public subscribe(
    sender: SenderIdentity,
    clientId: string,
    role: string,
    command: Extract<WireStreamCommand, { type: "subscribe" }>,
    send: StreamSender,
    sessionSignal: AbortSignal,
    onClose: () => void,
  ): void {
    const registration = this.#registrations.get(command.key);
    if (registration === undefined) {
      this.reject(
        sender,
        command,
        send,
        {
          code: "NOT_FOUND",
          message: "Unknown bridge stream.",
        },
        sessionSignal,
      );
      onClose();
      return;
    }
    const id = this.#id(sender, clientId, command.subscriptionId);
    if (sessionSignal.aborted || this.#consumers.has(id)) {
      onClose();
      return;
    }
    const controller = new AbortController();
    const consumer: Consumer = {
      id,
      key: command.key,
      clientId,
      subscriptionId: command.subscriptionId,
      sender,
      send,
      registration,
      controller,
      sessionSignal,
      onSessionAbort: () => this.#close(consumer),
      onClose,
      sourceDetached: false,
      pendingState: undefined,
      hasPendingState: false,
      inFlight: undefined,
      terminal: undefined,
      sequence: 0,
      closed: false,
    };
    this.#consumers.set(id, consumer);
    sessionSignal.addEventListener("abort", consumer.onSessionAbort, {
      once: true,
    });
    if (sessionSignal.aborted) {
      this.#close(consumer);
      return;
    }
    this.#send(consumer, { type: "subscribed", sequence: 0 });
    if (consumer.closed) return;
    if (registration.kind === "event") {
      consumer.pendingEvents = new BoundedQueue(
        registration.descriptor.buffer.capacity,
        registration.descriptor.buffer.overflow,
      );
    }
    try {
      if (
        registration.kind === "event" &&
        this.#isScoped(registration.source)
      ) {
        const context: BridgeContext = {
          requestId: command.subscriptionId,
          clientId,
          windowRole: role,
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

  public reject(
    sender: SenderIdentity,
    command: Extract<WireStreamCommand, { type: "subscribe" }>,
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

  public control(
    sender: SenderIdentity,
    command: Exclude<WireStreamCommand, { type: "subscribe" }>,
  ): void {
    const consumer = this.#consumers.get(
      this.#id(sender, command.clientId, command.subscriptionId),
    );
    if (consumer === undefined || consumer.closed) return;
    if (command.type === "unsubscribe") {
      this.#close(consumer);
      return;
    }
    if (consumer.inFlight !== command.sequence) return;
    consumer.inFlight = undefined;
    this.#flush(consumer);
  }

  public closeWhere(
    predicate: (consumer: {
      readonly sender: SenderIdentity;
      readonly clientId: string;
    }) => boolean,
  ): void {
    for (const consumer of [...this.#consumers.values()])
      if (predicate(consumer)) this.#close(consumer);
  }

  public dispose(): void {
    this.closeWhere(() => true);
  }

  #id(
    sender: SenderIdentity,
    clientId: string,
    subscriptionId: string,
  ): string {
    return JSON.stringify([
      sender.webContentsId,
      sender.frameId,
      clientId,
      subscriptionId,
    ]);
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
      value = parseOutput(
        consumer.registration.descriptor.output,
        raw,
        this.#limits,
      );
    } catch {
      this.#diagnostics?.record({
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
        this.#diagnostics?.record({
          type: "stream-dropped",
          key: consumer.key,
          count: result.dropped,
        });
      this.#diagnostics?.record({
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
      this.#diagnostics?.record({
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
    consumer.sessionSignal.removeEventListener(
      "abort",
      consumer.onSessionAbort,
    );
    this.#consumers.delete(consumer.id);
    consumer.controller.abort();
    this.#detachSource(consumer);
    consumer.onClose();
  }
}
