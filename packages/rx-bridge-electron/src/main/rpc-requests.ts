import {
  BridgeProtocolError,
  parseBridgeValue,
  withEnvelope,
  type BridgeValue,
  type PayloadLimits,
  type RpcResponse,
  type TransportErrorCode,
  type WireRpcRequest,
} from "../protocol/index.js";
import { PayloadLimitError } from "../protocol/bridge-value.js";
import type { LibraryErrorPayload } from "../protocol/messages.js";
import { authorizeOperation, bridgeContext } from "./authorization.js";
import { recordDiagnostic } from "./diagnostics.js";
import type { DocumentSession } from "./document-sessions.js";
import { internalError, serializeError } from "./error-serializer.js";
import { parseOutput } from "./output-boundary.js";
import type {
  RegistrationTable,
  RpcRegistrationEntry,
} from "./registration.js";
import type { ResourceLimits } from "./resource-limits.js";
import { SessionSlots, type SlotLease } from "./session-slots.js";
import type {
  Authorize,
  BridgeContext,
  DiagnosticsSink,
  SenderIdentity,
} from "./types.js";

type RpcResponseBody =
  | { readonly type: "success"; readonly result: BridgeValue }
  | {
      readonly type: "error";
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: BridgeValue;
      };
    };

/** `parseBridgeValue`·입력 스키마 실패가 함께 쓰는 `INVALID_ARGUMENT` 응답 payload. */
const invalidArgumentError: LibraryErrorPayload = Object.freeze({
  code: "INVALID_ARGUMENT",
  message: "Invalid bridge argument.",
});

/** 요청 envelope의 `clientId`·`requestId`를 붙여 응답을 만든다. */
function respond(envelope: WireRpcRequest, body: RpcResponseBody): RpcResponse {
  return withEnvelope(envelope.clientId, {
    requestId: envelope.requestId,
    ...body,
  });
}

/**
 * ADR 0011 "CANCELLED 우선" 규칙의 단일 정의 지점. `signal`이 aborted면
 * 취소 오류 응답을 돌려주고, 아니면 `undefined`를 돌려줘 호출부가 원래
 * 분기(성공 처리·다른 오류 분류·진단 기록)를 계속 타게 한다. 이 오류의
 * 메시지 문자열은 이 함수 밖에서 만들지 않는다.
 */
function cancelledIfAborted(
  signal: AbortSignal,
  envelope: WireRpcRequest,
): RpcResponse | undefined {
  if (!signal.aborted) return undefined;
  return respond(envelope, {
    type: "error",
    error: {
      code: "CANCELLED",
      message: "Request cancelled.",
    } satisfies LibraryErrorPayload,
  });
}

/** 진행 중인 요청 하나. `key`는 진단 기록용, `controller`는 취소·deadline abort. */
interface ActiveRequest {
  readonly key: string;
  readonly controller: AbortController;
  readonly lease: SlotLease;
}

/**
 * RPC 요청 1건의 수명주기 전체(등록 조회·slot부터 authorize 판정·validation
 * pipeline·handler·deadline·retire·slot 반환까지)를 소유한다. `authorize`
 * 호출과 예외·거부 분류는 `authorization.ts`의 공유 단계가 맡고, 이 class는
 * 그 판정을 응답으로 번역만 한다. `create-bridge-server.ts`는 세션 해석만
 * 맡긴다 — 이 클래스는 `DocumentSessions`를 모른다(`DocumentSession` 타입만
 * 참조). "세션이 여전히 현재인가"는 재검사하지 않는다: retire 경로는 전부
 * `SessionSlots` lease의 retire listener로 통지하므로(ADR 0015) 요청 signal
 * 판정 하나로 충분하다. slot 한도 판정·반납·전역 집계는 `SessionSlots`(RD-041)
 * 소유다 — retire된 세션이라도 handler가 아직 끝나지 않았다면 lease가
 * release되기 전까지 계속 센다(ADR 0010 §10).
 */
export class RpcRequests {
  readonly #table: RegistrationTable;
  readonly #limits: PayloadLimits;
  readonly #resourceLimits: ResourceLimits;
  readonly #diagnostics: DiagnosticsSink | undefined;
  readonly #authorize: Authorize | undefined;
  readonly #active = new WeakMap<DocumentSession, Map<string, ActiveRequest>>();
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
    this.#resourceLimits = resourceLimits;
    this.#diagnostics = diagnostics;
    this.#authorize = authorize;
    this.#slots = new SessionSlots(resourceLimits.maxConcurrentRpc);
  }

  public inFlightCount(): number {
    return this.#slots.count();
  }

  /** RPC 요청 1건을 처리한다. `session`은 이미 해석된 현재 세션이다. */
  public async dispatch(
    session: DocumentSession,
    sender: SenderIdentity,
    envelope: WireRpcRequest,
  ): Promise<RpcResponse> {
    const error = (code: TransportErrorCode, message: string): RpcResponse =>
      respond(envelope, { type: "error", error: { code, message } });

    const registration = this.#lookupRegistration(envelope.key);
    if (registration === undefined) {
      recordDiagnostic(this.#diagnostics, {
        type: "rejected",
        reason: "unknown-operation",
      });
      return error("NOT_FOUND", "Unknown bridge operation.");
    }
    const lease = this.#slots.acquire(session);
    if (lease === undefined) {
      recordDiagnostic(this.#diagnostics, {
        type: "rejected",
        reason: "rpc-limit",
        key: envelope.key,
      });
      return error(
        "RESOURCE_EXHAUSTED",
        "Too many concurrent bridge requests.",
      );
    }
    const controller = this.#begin(
      session,
      envelope.requestId,
      envelope.key,
      lease,
    );
    const context = bridgeContext(session, sender, envelope, controller.signal);
    const started = performance.now();
    const work = (async (): Promise<RpcResponse> => {
      let response: RpcResponse | undefined;
      try {
        const pending = authorizeOperation(
          this.#authorize,
          this.#diagnostics,
          context,
          registration.bridgeOperation,
        );
        const verdict = pending instanceof Promise ? await pending : pending;
        if (verdict.type === "cancelled") {
          // authorizeOperation이 cancelled를 돌려준 것은 signal이 aborted라는
          // 증거이므로 cancelledIfAborted는 항상 값을 돌려준다(CANCELLED
          // 문구를 여기서 복제하지 않는다, ADR 0015).
          response = cancelledIfAborted(controller.signal, envelope)!;
          return response;
        }
        if (verdict.type === "rejected") {
          response = respond(envelope, { type: "error", error: verdict.error });
          return response;
        }
        response = await this.#runRegistered(registration, envelope, context);
        return response;
      } finally {
        this.#finish(session, envelope.requestId, controller);
        lease.release();
        recordDiagnostic(this.#diagnostics, {
          type: "rpc-finished",
          key: envelope.key,
          durationMs: performance.now() - started,
          outcome: response?.type === "success" ? "ok" : "error",
        });
      }
    })();
    if (!Number.isFinite(this.#resourceLimits.maxRpcDurationMs))
      return await work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<RpcResponse>((resolve) => {
      timer = setTimeout(() => {
        // 취소가 먼저 확정됐으면 deadline은 응답만 대신 확정하고 진단을 남기지 않는다.
        const cancelled = cancelledIfAborted(controller.signal, envelope);
        if (cancelled !== undefined) {
          resolve(cancelled);
          return;
        }
        controller.abort();
        recordDiagnostic(this.#diagnostics, {
          type: "rpc-timed-out",
          key: envelope.key,
        });
        resolve(
          error("DEADLINE_EXCEEDED", "Request exceeded the server deadline."),
        );
      }, this.#resourceLimits.maxRpcDurationMs);
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Renderer가 보낸 `cancel` 명령. `session`은 이미 해석된 현재 세션이다. */
  public cancel(session: DocumentSession, requestId: string): void {
    this.#cancelActive(session, requestId);
  }

  #lookupRegistration(key: string): RpcRegistrationEntry | undefined {
    return this.#table.rpc.get(key);
  }

  #activeFor(session: DocumentSession): Map<string, ActiveRequest> {
    let active = this.#active.get(session);
    if (active === undefined) {
      active = new Map();
      this.#active.set(session, active);
    }
    return active;
  }

  /**
   * 같은 `requestId`의 기존 요청을 취소하고 새 controller를 등록한다.
   * lease의 `onRetire`로 retire 통지를 구독해 이 요청을 스스로 취소하게
   * 한다 — 이미 retire된 세션이면 `onRetire`가 등록 즉시 동기 호출하므로
   * (그 안에서 entry가 map에서 먼저 빠진다) 재검사 없이 즉시 취소한 것과
   * 같은 결과를 낸다.
   */
  #begin(
    session: DocumentSession,
    id: string,
    key: string,
    lease: SlotLease,
  ): AbortController {
    this.#cancelActive(session, id);
    const active = this.#activeFor(session);
    const controller = new AbortController();
    const entry: ActiveRequest = { key, controller, lease };
    active.set(id, entry);
    lease.onRetire(() => this.#cancelActive(session, id));
    return controller;
  }

  #finish(
    session: DocumentSession,
    id: string,
    controller: AbortController,
  ): void {
    const active = this.#active.get(session);
    if (active === undefined) return;
    const entry = active.get(id);
    if (entry === undefined || entry.controller !== controller) return;
    active.delete(id);
  }

  #cancelActive(session: DocumentSession, id: string): void {
    const active = this.#active.get(session);
    if (active === undefined) return;
    const entry = active.get(id);
    if (entry === undefined) return;
    active.delete(id);
    entry.lease.offRetire();
    // active에 남은 채 이미 aborted면 deadline이 먼저 확정해 rpc-timed-out을 남긴 요청이다.
    if (entry.controller.signal.aborted) return;
    entry.controller.abort();
    recordDiagnostic(this.#diagnostics, {
      type: "rpc-cancelled",
      key: entry.key,
    });
  }

  async #runRegistered(
    registration: RpcRegistrationEntry,
    envelope: WireRpcRequest,
    context: BridgeContext,
  ): Promise<RpcResponse> {
    let parsed: BridgeValue;
    try {
      parsed = parseBridgeValue(envelope.input, this.#limits);
    } catch (cause) {
      const cancelled = cancelledIfAborted(context.signal, envelope);
      if (cancelled !== undefined) return cancelled;
      recordDiagnostic(this.#diagnostics, {
        type: "rejected",
        reason:
          cause instanceof PayloadLimitError
            ? "payload-too-large"
            : "invalid-input",
        key: envelope.key,
      });
      return respond(envelope, { type: "error", error: invalidArgumentError });
    }
    let input: BridgeValue;
    try {
      input =
        registration.input === undefined
          ? parsed
          : registration.input.parse(parsed);
    } catch {
      const cancelled = cancelledIfAborted(context.signal, envelope);
      if (cancelled !== undefined) return cancelled;
      recordDiagnostic(this.#diagnostics, {
        type: "rejected",
        reason: "invalid-input",
        key: envelope.key,
      });
      return respond(envelope, { type: "error", error: invalidArgumentError });
    }
    let result: BridgeValue;
    try {
      result = await registration.handler(input, context);
    } catch (error) {
      const cancelled = cancelledIfAborted(context.signal, envelope);
      if (cancelled !== undefined) return cancelled;
      if (error instanceof BridgeProtocolError)
        return respond(envelope, {
          type: "error",
          error: internalError,
        });
      return respond(envelope, {
        type: "error",
        error: serializeError(error, registration.errors, this.#limits),
      });
    }
    const cancelledAfterHandler = cancelledIfAborted(context.signal, envelope);
    if (cancelledAfterHandler !== undefined) return cancelledAfterHandler;
    let output: BridgeValue;
    try {
      output = parseOutput(registration.output, result, this.#limits);
    } catch {
      recordDiagnostic(this.#diagnostics, {
        type: "validation-failed",
        key: envelope.key,
      });
      const cancelled = cancelledIfAborted(context.signal, envelope);
      if (cancelled !== undefined) return cancelled;
      return respond(envelope, {
        type: "error",
        error: internalError,
      });
    }
    return respond(envelope, { type: "success", result: output });
  }
}
