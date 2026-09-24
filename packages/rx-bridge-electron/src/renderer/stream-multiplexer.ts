import {
  parseStreamMessage,
  type BridgeValue,
  type ProtocolEnvelope,
  type RpcErrorPayload,
  type StreamMessage,
} from "../protocol/index.js";
import type { ApiLifetime } from "./api-lifetime.js";
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

export class StreamMultiplexer {
  readonly #transport: BridgeTransport;
  readonly #session: ProtocolEnvelope;
  readonly #diagnostics: RendererDiagnosticsSink | undefined;
  readonly #lifetime: ApiLifetime;
  readonly #generations = new Map<string, StreamGeneration>();
  readonly #removeListener: () => void;

  public constructor(
    transport: BridgeTransport,
    session: ProtocolEnvelope,
    lifetime: ApiLifetime,
    diagnostics?: RendererDiagnosticsSink,
  ) {
    this.#transport = transport;
    this.#session = session;
    this.#lifetime = lifetime;
    this.#diagnostics = diagnostics;
    this.#removeListener = transport.onStreamMessage((message) => {
      this.#dispatch(message);
    });
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
    // sink가 수명 객체 종료를 재진입시켰으면 generation은 이미 닫혔다
    // (unsubscribe 전송 완료). 여기서 subscribe를 보내면 Main 구독이 남는다.
    if (this.#generations.get(subscriptionId) !== generation) {
      return;
    }

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

  // 종료 절차의 RPC 확정 단계에서 sink가 구독 해제를 재진입시키면 generation은
  // 아직 남아 있다. 여기서 닫지 않고 `closeAll()`이 `disposed`로 한 번 닫게 둔다.
  public close(subscriptionId: string): void {
    const generation = this.#generations.get(subscriptionId);
    if (generation === undefined || this.#lifetime.disposed) {
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

  /**
   * 멱등 guard 없이 listener 제거와 generation 정리(진단 기록 → unsubscribe
   * control 전송 → `handlers.complete()`)만 수행한다. 멱등성은 `ApiLifetime`이
   * 보장한다.
   */
  public closeAll(): void {
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
    if (this.#lifetime.disposed) {
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
