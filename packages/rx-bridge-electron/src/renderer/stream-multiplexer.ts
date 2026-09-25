import {
  parseStreamMessage,
  type BridgeValue,
  type ProtocolEnvelope,
  type RendererStreamCommand,
  type RpcErrorPayload,
  type StreamMessage,
} from "../protocol/index.js";
import type { ApiLifetime } from "./api-lifetime.js";
import {
  recordRendererDiagnostic,
  type RendererDiagnosticsSink,
  type SubscriptionCloseCause,
} from "./diagnostics.js";
import { createOpaqueId } from "./ids.js";
import {
  localError,
  remoteErrorFromPayload,
  RemoteError,
} from "./remote-error.js";
import type { BridgeTransport } from "./transport.js";

/**
 * generation 하나의 통지 대상. `error`와 `complete`는 둘 중 하나만 generation당
 * 최대 1회 호출된다. generation이 닫힌 뒤에는(통지 없이 닫히는 `unsubscribed`
 * 포함) `next`를 포함해 어떤 handler도 호출되지 않는다.
 */
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

/**
 * generation 종료 원인의 판별 유니온(모듈 내부 전용). cause는
 * `subscription-closed` 진단의 cause와 같고, `remote-error`만 원격 오류
 * payload를 싣는다.
 */
type GenerationEnd =
  | { readonly cause: Exclude<SubscriptionCloseCause, "remote-error"> }
  | { readonly cause: "remote-error"; readonly error: RpcErrorPayload };

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

  // 종료 검사는 호출자(`LocalGeneration.subscribe`) 한 곳이 한다. 그 검사를
  // 우회해 종료 뒤 호출하면 generation이 map에 등록된 채 남고 subscribe control이
  // 전송된다.
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
      // ADR 0022 결정 8: subscribe 실패는 `subscription-closed(transport-failed)`
      // 만 기록한다 — `#sendControl`을 거치면 `transport-failed(control)`까지
      // 이중 기록되므로 여기서는 쓰지 않는다.
      this.#terminate(subscriptionId, generation, {
        cause: "transport-failed",
      });
    }
  }

  // 종료 절차의 RPC 확정 단계에서 sink가 구독 해제를 재진입시키면 generation은
  // 아직 남아 있다. 여기서 닫지 않고 `closeAll()`이 `disposed`로 한 번 닫게 둔다.
  public close(subscriptionId: string): void {
    const generation = this.#generations.get(subscriptionId);
    if (generation === undefined || this.#lifetime.disposed) {
      return;
    }
    this.#terminate(subscriptionId, generation, { cause: "unsubscribed" });
  }

  /**
   * 멱등 guard 없이 listener 제거와 남은 generation 전체의 `#terminate(disposed)`
   * 만 수행한다. 멱등성은 `ApiLifetime`이 보장한다.
   */
  public closeAll(): void {
    this.#removeListener();
    const generations = [...this.#generations.entries()];
    for (const [subscriptionId, generation] of generations) {
      this.#terminate(subscriptionId, generation, { cause: "disposed" });
    }
  }

  /**
   * generation 종료 경로 하나. 순서 고정: (1) identity guard(1회 보장) →
   * (2) `#generations.delete` → (3) `subscription-closed` 진단 → (4) cause별
   * unsubscribe 전송 → (5) cause별 handler 통지.
   */
  #terminate(
    subscriptionId: string,
    generation: StreamGeneration,
    end: GenerationEnd,
  ): void {
    if (this.#generations.get(subscriptionId) !== generation) {
      return;
    }
    this.#generations.delete(subscriptionId);
    recordRendererDiagnostic(this.#diagnostics, {
      type: "subscription-closed",
      key: generation.key,
      cause: end.cause,
      ...(end.cause === "remote-error" ? { code: end.error.code } : {}),
    });
    // cause → (unsubscribe 전송, handler 통지) 표. 전송이 있으면 통지보다 먼저다.
    switch (end.cause) {
      case "unsubscribed":
        this.#sendControl({ type: "unsubscribe", subscriptionId });
        break;
      case "disposed":
        this.#sendControl({ type: "unsubscribe", subscriptionId });
        generation.handlers.complete();
        break;
      case "completed":
        generation.handlers.complete();
        break;
      case "remote-error":
        generation.handlers.error(remoteErrorFromPayload(end.error));
        break;
      case "transport-failed":
        generation.handlers.error(
          localError("INTERNAL", "Stream transport failed."),
        );
        break;
    }
  }

  /** control 전송 하나. throw를 삼키고 `transport-failed(control)`을 기록한다. */
  #sendControl(message: RendererStreamCommand): void {
    try {
      this.#transport.control(message);
    } catch {
      recordRendererDiagnostic(this.#diagnostics, {
        type: "transport-failed",
        channel: "control",
      });
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
      // `next` 콜백 안에서 dispose됐으면 ack를 보내지 않는다(ADR 0006 개정).
      // 로컬 마지막 구독자 해제 뒤의 ack는 받아들인 batch의 확인이라 보낸다.
      if (this.#lifetime.disposed) {
        return;
      }
      this.#sendControl({
        type: "acknowledge",
        subscriptionId: message.subscriptionId,
        sequence: message.sequence,
      });
      return;
    }

    if (message.type === "error") {
      this.#terminate(message.subscriptionId, generation, {
        cause: "remote-error",
        error: message.error,
      });
      return;
    }
    this.#terminate(message.subscriptionId, generation, { cause: "completed" });
  }
}
