import {
  parseStreamMessage,
  type BridgeValue,
  type ProtocolEnvelope,
  type RpcErrorPayload,
  type StreamMessage,
} from "../protocol/index.js";
import { createOpaqueId } from "./ids.js";
import {
  createDisposedError,
  localError,
  RemoteError,
} from "./remote-error.js";
import type { BridgeTransport } from "./transport.js";

export interface StreamGenerationHandlers {
  next(value: BridgeValue): void;
  error(error: RemoteError): void;
  complete(): void;
}

interface StreamGeneration {
  readonly handlers: StreamGenerationHandlers;
  active: boolean;
  lastSequence: number;
}

function remoteError(payload: RpcErrorPayload): RemoteError {
  return new RemoteError(payload.code, payload.message, payload.details);
}

export class StreamMultiplexer implements Disposable {
  readonly #transport: BridgeTransport;
  readonly #session: ProtocolEnvelope;
  readonly #generations = new Map<string, StreamGeneration>();
  readonly #removeListener: () => void;
  #disposed = false;

  public constructor(transport: BridgeTransport, session: ProtocolEnvelope) {
    this.#transport = transport;
    this.#session = session;
    this.#removeListener = transport.onStreamMessage((message) => {
      this.#dispatch(message);
    });
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  public open(
    key: string,
    handlers: StreamGenerationHandlers,
    registered: (subscriptionId: string) => void,
  ): void {
    const subscriptionId = createOpaqueId("subscription");
    const generation: StreamGeneration = {
      handlers,
      active: false,
      lastSequence: -1,
    };
    this.#generations.set(subscriptionId, generation);
    registered(subscriptionId);

    if (this.#disposed) {
      this.#generations.delete(subscriptionId);
      handlers.error(createDisposedError());
      return;
    }

    try {
      this.#transport.control({ type: "subscribe", subscriptionId, key });
    } catch {
      if (this.#generations.get(subscriptionId) === generation) {
        this.#generations.delete(subscriptionId);
        handlers.error(localError("INTERNAL", "Stream transport failed."));
      }
    }
  }

  public close(subscriptionId: string): void {
    if (!this.#generations.delete(subscriptionId) || this.#disposed) {
      return;
    }
    try {
      this.#transport.control({ type: "unsubscribe", subscriptionId });
    } catch {
      // The local generation is closed even if transport cleanup fails.
    }
  }

  public [Symbol.dispose](): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#removeListener();
    const generations = [...this.#generations.entries()];
    this.#generations.clear();
    for (const [subscriptionId, generation] of generations) {
      try {
        this.#transport.control({ type: "unsubscribe", subscriptionId });
      } catch {
        // Disposal remains local and idempotent when transport cleanup fails.
      }
      generation.handlers.complete();
    }
  }

  #dispatch(rawMessage: StreamMessage): void {
    if (this.#disposed) {
      return;
    }

    let message: StreamMessage;
    try {
      message = parseStreamMessage(rawMessage);
    } catch {
      return;
    }
    if (
      message.protocolVersion !== this.#session.protocolVersion ||
      message.clientId !== this.#session.clientId
    ) {
      return;
    }

    const generation = this.#generations.get(message.subscriptionId);
    if (generation === undefined) {
      return;
    }
    if (message.type === "subscribed") {
      if (generation.active || message.sequence <= generation.lastSequence) {
        return;
      }
      generation.lastSequence = message.sequence;
      generation.active = true;
      return;
    }
    if (!generation.active || message.sequence <= generation.lastSequence) {
      return;
    }
    generation.lastSequence = message.sequence;

    if (message.type === "batch") {
      for (const value of message.values) {
        if (this.#generations.get(message.subscriptionId) !== generation) {
          break;
        }
        generation.handlers.next(value);
      }
      try {
        this.#transport.control({
          type: "acknowledge",
          subscriptionId: message.subscriptionId,
          sequence: message.sequence,
        });
      } catch {
        // A future transport/session lifecycle event owns remote cleanup.
      }
      return;
    }

    this.#generations.delete(message.subscriptionId);
    if (message.type === "error") {
      generation.handlers.error(remoteError(message.error));
      return;
    }
    generation.handlers.complete();
  }
}
