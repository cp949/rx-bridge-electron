import {
  BridgeProtocolError,
  parseBridgeValue,
  type BridgeValue,
  type PayloadLimits,
  type RpcResponse,
  type WireRpcRequest,
} from "../protocol/index.js";
import { PayloadLimitError } from "../protocol/bridge-value.js";
import { recordDiagnostic } from "./diagnostics.js";
import type { DocumentSession } from "./document-sessions.js";
import { serializeError } from "./error-serializer.js";
import { parseOutput } from "./output-boundary.js";
import type {
  RegistrationTable,
  RpcRegistrationEntry,
} from "./registration.js";
import type { ResourceLimits } from "./resource-limits.js";
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

/** 요청 envelope의 `clientId`·`requestId`를 붙여 응답을 만든다. */
function respond(envelope: WireRpcRequest, body: RpcResponseBody): RpcResponse {
  return {
    protocolVersion: 1,
    clientId: envelope.clientId,
    requestId: envelope.requestId,
    ...body,
  } as RpcResponse;
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
    error: { code: "CANCELLED", message: "Request cancelled." },
  });
}

/** 진행 중인 요청 하나. `key`는 진단 기록용, `controller`는 취소·deadline abort. */
interface ActiveRequest {
  readonly key: string;
  readonly controller: AbortController;
  readonly onSessionAbort: () => void;
}

/** 세션 1개가 소유한 RPC 상태. `running`은 slot(동시 개수) 점유, `active`는 취소 대상 조회용. */
interface SessionState {
  running: number;
  readonly active: Map<string, ActiveRequest>;
}

/**
 * RPC 요청 1건의 수명주기 전체(등록 조회·slot부터 `authorize`·validation
 * pipeline·handler·deadline·retire·slot 반환까지)를 소유한다.
 * `create-bridge-server.ts`는 세션 해석만 맡긴다 — 이 클래스는
 * `DocumentSessions`를 모른다(`DocumentSession` 타입만 참조). "세션이
 * 여전히 현재인가"는 재검사하지 않는다: retire 경로는 전부 `session.signal`을
 * abort하므로(ADR 0015) 요청 signal 판정 하나로 충분하다.
 */
export class RpcRequests {
  readonly #table: RegistrationTable;
  readonly #limits: PayloadLimits;
  readonly #resourceLimits: ResourceLimits;
  readonly #diagnostics: DiagnosticsSink | undefined;
  readonly #authorize: Authorize | undefined;
  readonly #sessions = new WeakMap<DocumentSession, SessionState>();
  /**
   * retire된 세션이라도 handler가 아직 끝나지 않았다면 계속 센다(ADR 0010
   * §10) — 세션 상태 순회로 계산하지 않고 slot 획득·반환 시점에 직접
   * 증감한다.
   */
  #inFlight = 0;

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

  public inFlightCount(): number {
    return this.#inFlight;
  }

  /** RPC 요청 1건을 처리한다. `session`은 이미 해석된 현재 세션이다. */
  public async dispatch(
    session: DocumentSession,
    sender: SenderIdentity,
    envelope: WireRpcRequest,
  ): Promise<RpcResponse> {
    const error = (code: string, message: string): RpcResponse =>
      respond(envelope, { type: "error", error: { code, message } });

    const registration = this.#lookupRegistration(envelope.key);
    if (registration === undefined) {
      recordDiagnostic(this.#diagnostics, {
        type: "rejected",
        reason: "unknown-operation",
      });
      return error("NOT_FOUND", "Unknown bridge operation.");
    }
    if (!this.#tryAcquire(session)) {
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
    const controller = this.#begin(session, envelope.requestId, envelope.key);
    const context: BridgeContext = {
      requestId: envelope.requestId,
      clientId: envelope.clientId,
      windowRole: session.target.role,
      sender,
      signal: controller.signal,
    };
    const started = performance.now();
    const work = (async (): Promise<RpcResponse> => {
      let response: RpcResponse | undefined;
      try {
        let allowed: boolean;
        try {
          allowed =
            this.#authorize === undefined
              ? true
              : await this.#authorize(context, envelope.key);
        } catch {
          response =
            cancelledIfAborted(controller.signal, envelope) ??
            error("INTERNAL", "Internal bridge error.");
          return response;
        }
        const cancelled = cancelledIfAborted(controller.signal, envelope);
        if (cancelled !== undefined) {
          response = cancelled;
          return response;
        }
        if (!allowed) {
          recordDiagnostic(this.#diagnostics, {
            type: "rejected",
            reason: "authorize-denied",
            key: envelope.key,
          });
          response = error("FORBIDDEN", "Bridge operation is forbidden.");
          return response;
        }
        response = await this.#runRegistered(registration, envelope, context);
        return response;
      } finally {
        this.#finish(session, envelope.requestId, controller);
        this.#release(session);
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

  #stateFor(session: DocumentSession): SessionState {
    let state = this.#sessions.get(session);
    if (state === undefined) {
      state = { running: 0, active: new Map() };
      this.#sessions.set(session, state);
    }
    return state;
  }

  #tryAcquire(session: DocumentSession): boolean {
    const state = this.#stateFor(session);
    if (state.running >= this.#resourceLimits.maxConcurrentRpc) return false;
    state.running += 1;
    this.#inFlight += 1;
    return true;
  }

  #release(session: DocumentSession): void {
    const state = this.#sessions.get(session);
    if (state !== undefined) state.running = Math.max(0, state.running - 1);
    this.#inFlight = Math.max(0, this.#inFlight - 1);
  }

  /**
   * 같은 `requestId`의 기존 요청을 취소하고 새 controller를 등록한다.
   * `session.signal`에 abort listener를 달아 retire 시 이 요청을 스스로
   * 취소하게 한다 — 등록 시점에 이미 aborted면 listener가 뒤늦게 불리지
   * 않으므로 즉시 취소한 것과 같은 결과를 낸다.
   */
  #begin(session: DocumentSession, id: string, key: string): AbortController {
    this.#cancelActive(session, id);
    const state = this.#stateFor(session);
    const controller = new AbortController();
    const onSessionAbort = (): void => this.#cancelActive(session, id);
    state.active.set(id, { key, controller, onSessionAbort });
    session.signal.addEventListener("abort", onSessionAbort, { once: true });
    if (session.signal.aborted) this.#cancelActive(session, id);
    return controller;
  }

  #finish(
    session: DocumentSession,
    id: string,
    controller: AbortController,
  ): void {
    const state = this.#sessions.get(session);
    if (state === undefined) return;
    const entry = state.active.get(id);
    if (entry === undefined || entry.controller !== controller) return;
    state.active.delete(id);
    session.signal.removeEventListener("abort", entry.onSessionAbort);
  }

  #cancelActive(session: DocumentSession, id: string): void {
    const state = this.#sessions.get(session);
    if (state === undefined) return;
    const entry = state.active.get(id);
    if (entry === undefined) return;
    state.active.delete(id);
    session.signal.removeEventListener("abort", entry.onSessionAbort);
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
      return respond(envelope, {
        type: "error",
        error: {
          code: "INVALID_ARGUMENT",
          message: "Invalid bridge argument.",
        },
      });
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
      return respond(envelope, {
        type: "error",
        error: {
          code: "INVALID_ARGUMENT",
          message: "Invalid bridge argument.",
        },
      });
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
          error: { code: "INTERNAL", message: "Internal bridge error." },
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
        error: { code: "INTERNAL", message: "Internal bridge error." },
      });
    }
    return respond(envelope, { type: "success", result: output });
  }
}
