import {
  parseStreamMessage,
  type BridgeValue,
  type ProtocolEnvelope,
  type RpcErrorPayload,
  type StreamMessage,
} from "../protocol/index.js";
import {
  recordRendererDiagnostic,
  type RendererDiagnosticsSink,
} from "./diagnostics.js";
import { createOpaqueId } from "./ids.js";
import { localError, RemoteError } from "./remote-error.js";
import type { BridgeTransport } from "./transport.js";

export interface StreamGenerationHandlers {
  next(value: BridgeValue): void;
  error(error: RemoteError): void;
  complete(): void;
}

interface StreamGeneration {
  readonly key: string;
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
  readonly #diagnostics: RendererDiagnosticsSink | undefined;
  readonly #generations = new Map<string, StreamGeneration>();
  readonly #removeListener: () => void;
  #disposed = false;

  public constructor(
    transport: BridgeTransport,
    session: ProtocolEnvelope,
    diagnostics?: RendererDiagnosticsSink,
  ) {
    this.#transport = transport;
    this.#session = session;
    this.#diagnostics = diagnostics;
    this.#removeListener = transport.onStreamMessage((message) => {
      this.#dispatch(message);
    });
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  // 종료 여부는 호출자(`LocalGeneration.subscribe`)가 먼저 확인한다. 종료 뒤
  // 호출하면 generation이 등록된 채 남고 subscribe control이 전송된다.
  public open(
    key: string,
    handlers: StreamGenerationHandlers,
    registered: (subscriptionId: string) => void,
  ): void {
    const subscriptionId = createOpaqueId("subscription");
    const generation: StreamGeneration = {
      key,
      handlers,
      active: false,
      lastSequence: -1,
    };
    this.#generations.set(subscriptionId, generation);
    registered(subscriptionId);
    recordRendererDiagnostic(this.#diagnostics, {
      type: "subscription-opened",
      key,
    });

    try {
      this.#transport.control({ type: "subscribe", subscriptionId, key });
    } catch {
      if (this.#generations.get(subscriptionId) === generation) {
        this.#generations.delete(subscriptionId);
        recordRendererDiagnostic(this.#diagnostics, {
          type: "subscription-closed",
          key,
          cause: "transport-failed",
        });
        handlers.error(localError("INTERNAL", "Stream transport failed."));
      }
    }
  }

  public close(subscriptionId: string): void {
    const generation = this.#generations.get(subscriptionId);
    if (generation === undefined || this.#disposed) {
      return;
    }
    this.#generations.delete(subscriptionId);
    recordRendererDiagnostic(this.#diagnostics, {
      type: "subscription-closed",
      key: generation.key,
      cause: "unsubscribed",
    });
    try {
      this.#transport.control({ type: "unsubscribe", subscriptionId });
    } catch {
      recordRendererDiagnostic(this.#diagnostics, {
        type: "transport-failed",
        channel: "control",
      });
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
      recordRendererDiagnostic(this.#diagnostics, {
        type: "subscription-closed",
        key: generation.key,
        cause: "disposed",
      });
      try {
        this.#transport.control({ type: "unsubscribe", subscriptionId });
      } catch {
        recordRendererDiagnostic(this.#diagnostics, {
          type: "transport-failed",
          channel: "control",
        });
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
      recordRendererDiagnostic(this.#diagnostics, {
        type: "message-dropped",
        reason: "malformed",
      });
      return;
    }
    if (
      message.protocolVersion !== this.#session.protocolVersion ||
      message.clientId !== this.#session.clientId
    ) {
      recordRendererDiagnostic(this.#diagnostics, {
        type: "message-dropped",
        reason: "envelope-mismatch",
      });
      return;
    }

    const generation = this.#generations.get(message.subscriptionId);
    if (generation === undefined) {
      // unsubscribe와 Main 전송 사이의 정상 경합이다(ADR 0022 결정 7) — 기록 안 함.
      return;
    }
    if (message.type === "subscribed") {
      if (generation.active || message.sequence <= generation.lastSequence) {
        recordRendererDiagnostic(this.#diagnostics, {
          type: "message-dropped",
          reason: "out-of-order",
        });
        return;
      }
      generation.lastSequence = message.sequence;
      generation.active = true;
      return;
    }
    if (!generation.active || message.sequence <= generation.lastSequence) {
      recordRendererDiagnostic(this.#diagnostics, {
        type: "message-dropped",
        reason: "out-of-order",
      });
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
        recordRendererDiagnostic(this.#diagnostics, {
          type: "transport-failed",
          channel: "control",
        });
      }
      return;
    }

    this.#generations.delete(message.subscriptionId);
    if (message.type === "error") {
      recordRendererDiagnostic(this.#diagnostics, {
        type: "subscription-closed",
        key: generation.key,
        cause: "remote-error",
        code: message.error.code,
      });
      generation.handlers.error(remoteError(message.error));
      return;
    }
    recordRendererDiagnostic(this.#diagnostics, {
      type: "subscription-closed",
      key: generation.key,
      cause: "completed",
    });
    generation.handlers.complete();
  }
}
