import type { BridgeImpl, ErrorsFor, SchemasFor } from "../contract/index.js";
import {
  BridgeProtocolError,
  parseHandshakeRequest,
  parseWireCancelRequest,
  parseWireRpcRequest,
  parseWireStreamCommand,
  withEnvelope,
  type HandshakeResponse,
  type PayloadLimits,
  type RpcResponse,
} from "../protocol/index.js";
import { recordDiagnostic } from "./diagnostics.js";
import { invalidRequest, protocolError } from "./protocol-error.js";
import { RpcRequests } from "./rpc-requests.js";
import {
  DocumentSessions,
  SENDER_UNAUTHORIZED_MESSAGE,
} from "./document-sessions.js";
import {
  buildRegistrationTableFromImpl,
  manifestFromTable,
  type RegistrationTable,
} from "./registration.js";
import { resolvePayloadLimits } from "./payload-limits.js";
import {
  resolveResourceLimits,
  type ResourceLimits,
} from "./resource-limits.js";
import { Subscriptions, type StreamSender } from "./subscriptions.js";
import type {
  AttachedTarget,
  Authorize,
  DiagnosticsSink,
  DiagnosticsSnapshot,
  SenderIdentity,
  UnkeyedRejectReason,
} from "./types.js";

/**
 * envelope parse 실패를 사유로 분류한다. `BridgeProtocolError`이고
 * `VERSION_MISMATCH`면 `version-mismatch`, 그 외 모든 throw는
 * `malformed-envelope`다(ADR 0016 결정 2).
 */
function classifyParseFailure(
  error: unknown,
): "version-mismatch" | "malformed-envelope" {
  return error instanceof BridgeProtocolError &&
    error.code === "VERSION_MISMATCH"
    ? "version-mismatch"
    : "malformed-envelope";
}

export interface StreamBridgeServer {
  attach(target: AttachedTarget): () => void;
  handshake(
    sender: SenderIdentity,
    value: unknown,
  ): HandshakeResponse | RpcResponse;
  dispatchRpc(sender: SenderIdentity, value: unknown): Promise<RpcResponse>;
  cancel(sender: SenderIdentity, value: unknown): void;
  /** 반환된 promise는 reject하지 않는다(RD-029) — adapter가 `void`로 버리기 때문이다. */
  controlStream(
    sender: SenderIdentity,
    value: unknown,
    send: StreamSender,
  ): Promise<void>;
  getDiagnosticsSnapshot(): DiagnosticsSnapshot;
  dispose(): void;
}

/** `createBridgeServer(impl, options)`의 옵션(RD-011). */
export interface ImplServerOptions<B> {
  readonly authorize?: Authorize;
  readonly diagnostics?: DiagnosticsSink;
  readonly resourceLimits?: Partial<ResourceLimits>;
  readonly schemas?: SchemasFor<B>;
  readonly errors?: ErrorsFor<B>;
  readonly payloadLimits?: Partial<PayloadLimits>;
}

/** 옵션 해석을 마친 값만 담는다. `buildBridgeServer`는 이 형태만 받는다. */
interface ResolvedServerConfig {
  readonly payloadLimits: PayloadLimits;
  readonly resourceLimits: ResourceLimits;
  readonly authorize: Authorize | undefined;
  readonly diagnostics: DiagnosticsSink | undefined;
}

export function createBridgeServer<B>(
  impl: BridgeImpl<B>,
  options?: ImplServerOptions<B>,
): StreamBridgeServer {
  const payloadLimits = resolvePayloadLimits(options?.payloadLimits);
  const table = buildRegistrationTableFromImpl(
    impl,
    options?.schemas,
    options?.errors,
  );
  const resourceLimits = resolveResourceLimits(options?.resourceLimits);
  return buildBridgeServer(table, {
    payloadLimits,
    resourceLimits,
    authorize: options?.authorize,
    diagnostics: options?.diagnostics,
  });
}

/**
 * `RegistrationTable`로부터 실제 `StreamBridgeServer`를 만드는 코어.
 * 옵션 해석(`createBridgeServer`)과 조립(`buildBridgeServer`)을 나눈다.
 * 조립은 해석을 마친 값만 받는다.
 */
function buildBridgeServer(
  table: RegistrationTable,
  config: ResolvedServerConfig,
): StreamBridgeServer {
  const {
    payloadLimits: limits,
    resourceLimits,
    authorize,
    diagnostics,
  } = config;
  let disposed = false;
  const sessions = new DocumentSessions(resourceLimits, diagnostics);
  const manifest = manifestFromTable(table);
  const subscriptions = new Subscriptions(
    table,
    limits,
    resourceLimits,
    diagnostics,
    authorize,
  );
  const rpcRequests = new RpcRequests(
    table,
    limits,
    resourceLimits,
    diagnostics,
    authorize,
  );
  const reject = (reason: UnkeyedRejectReason): void => {
    recordDiagnostic(diagnostics, { type: "rejected", reason });
  };
  return {
    attach(target: AttachedTarget): () => void {
      return sessions.attach(target);
    },
    handshake(sender: SenderIdentity, value: unknown) {
      let envelope;
      try {
        envelope = parseHandshakeRequest(value);
      } catch (cause) {
        reject(classifyParseFailure(cause));
        return invalidRequest(value);
      }
      const admission = sessions.establish(sender, envelope.clientId);
      if ("reason" in admission) {
        reject(admission.reason);
        return invalidRequest(value);
      }
      return withEnvelope(envelope.clientId, { manifest });
    },
    async dispatchRpc(
      sender: SenderIdentity,
      value: unknown,
    ): Promise<RpcResponse> {
      let envelope;
      try {
        envelope = parseWireRpcRequest(value);
      } catch (cause) {
        const reason = classifyParseFailure(cause);
        reject(reason);
        return reason === "version-mismatch"
          ? protocolError(
              value,
              "VERSION_MISMATCH",
              "Unsupported protocol version.",
            )
          : invalidRequest(value);
      }
      const admission = sessions.establish(sender, envelope.clientId);
      if ("reason" in admission) {
        reject(admission.reason);
        return protocolError(
          envelope,
          "FORBIDDEN",
          SENDER_UNAUTHORIZED_MESSAGE,
        );
      }
      return rpcRequests.dispatch(admission.session, sender, envelope);
    },
    cancel(sender: SenderIdentity, value: unknown): void {
      let envelope;
      try {
        envelope = parseWireCancelRequest(value);
      } catch (cause) {
        reject(classifyParseFailure(cause));
        return;
      }
      const admission = sessions.current(sender, envelope.clientId);
      if ("reason" in admission) {
        reject(admission.reason);
        return;
      }
      rpcRequests.cancel(admission.session, envelope.requestId);
    },
    async controlStream(
      sender: SenderIdentity,
      value: unknown,
      send: StreamSender,
    ): Promise<void> {
      // 계약: 이 메서드는 reject하지 않는다(RD-029). 두 adapter
      // (`electron-adapter.ts`, `testing/loopback-transport.ts`)가 반환된
      // promise를 `void`로 버리므로, reject하면 unhandled rejection이 된다.
      // 알려진 예외 경로는 모두 위에서 개별 처리되어 여기 도달하지 않는다 —
      // 이 catch는 남은 경로에 대한 최종 방어일 뿐이다.
      try {
        let command;
        try {
          command = parseWireStreamCommand(value);
        } catch (cause) {
          reject(classifyParseFailure(cause));
          return;
        }
        if (command.type !== "subscribe") {
          const admission = sessions.current(sender, command.clientId);
          if ("reason" in admission) {
            reject(admission.reason);
            return;
          }
          subscriptions.control(admission.session, command);
          return;
        }
        const admission = sessions.establish(sender, command.clientId);
        if ("reason" in admission) {
          reject(admission.reason);
          subscriptions.rejectAdmission(command, send);
          return;
        }
        await subscriptions.subscribe(admission.session, sender, command, send);
      } catch {
        // 최종 방어: 조용히 무시한다. 진단 기록도, 재throw도 하지 않는다.
      }
    },
    getDiagnosticsSnapshot(): DiagnosticsSnapshot {
      return {
        sessions: sessions.sessionCount(),
        rpcInFlight: rpcRequests.inFlightCount(),
        subscriptions: subscriptions.subscriptionCount(),
        queuedEvents: subscriptions.queuedEventsCount(),
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      sessions.dispose();
      subscriptions.dispose();
    },
  };
}
