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
import { DocumentSessions } from "./document-sessions.js";
import {
  buildRegistrationTableFromImpl,
  manifestFromTable,
  type RegistrationTable,
} from "./registration.js";
import {
  resolveResourceLimits,
  type ResourceLimits,
} from "./resource-limits.js";
import { Subscriptions, type StreamSender } from "./subscriptions.js";
import type {
  AttachedTarget,
  Authorize,
  BridgeServer,
  DiagnosticsSink,
  DiagnosticsSnapshot,
  RejectReason,
  SenderIdentity,
} from "./types.js";

/** RPC·stream subscribe admission 거부가 함께 쓰는 `FORBIDDEN` 문구. */
const SENDER_UNAUTHORIZED_MESSAGE = "Bridge sender is not authorized.";

const defaultLimits: PayloadLimits = {
  maxDepth: 32,
  maxEntries: 10_000,
  maxStringBytes: 1_000_000,
  maxTotalBytes: 16_777_216,
};

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

const PAYLOAD_LIMIT_KEYS = [
  "maxDepth",
  "maxEntries",
  "maxStringBytes",
  "maxTotalBytes",
] as const;

/**
 * `options.payloadLimits`를 검증한다. 부분 지정을 허용한다(`ResourceLimits`와
 * 같은 패턴) — 생략한 필드는 `defaultLimits`를 그대로 쓴다.
 */
function assertPartialPayloadLimits(
  payloadLimits: Partial<PayloadLimits> | undefined,
): void {
  if (payloadLimits === undefined) return;
  for (const key of Object.keys(payloadLimits)) {
    if (!(PAYLOAD_LIMIT_KEYS as readonly string[]).includes(key)) {
      throw new TypeError(`Unknown payload limit '${key}'.`);
    }
  }
  for (const key of ["maxDepth", "maxEntries", "maxStringBytes"] as const) {
    if (!Object.hasOwn(payloadLimits, key)) continue;
    const value = payloadLimits[key];
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new TypeError(
        `Payload limit '${key}' must be a non-negative safe integer.`,
      );
    }
  }
  if (Object.hasOwn(payloadLimits, "maxTotalBytes")) {
    const value = payloadLimits.maxTotalBytes;
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new TypeError(
        "Payload limit 'maxTotalBytes' must be a non-negative safe integer.",
      );
    }
  }
}

export interface StreamBridgeServer extends BridgeServer {
  handshake(
    sender: SenderIdentity,
    value: unknown,
  ): HandshakeResponse | RpcResponse;
  controlStream(
    sender: SenderIdentity,
    value: unknown,
    send: StreamSender,
  ): Promise<void>;
  getDiagnosticsSnapshot(): DiagnosticsSnapshot;
}

interface CommonServerOptions {
  readonly authorize?: Authorize;
  readonly diagnostics?: DiagnosticsSink;
  readonly resourceLimits?: Partial<ResourceLimits>;
}

/** `createBridgeServer(impl, options)`의 옵션(RD-011). */
export interface ImplServerOptions<B> extends CommonServerOptions {
  readonly schemas?: SchemasFor<B>;
  readonly errors?: ErrorsFor<B>;
  readonly payloadLimits?: Partial<PayloadLimits>;
}

export function createBridgeServer<B>(
  impl: BridgeImpl<B>,
  options?: ImplServerOptions<B>,
): StreamBridgeServer {
  assertPartialPayloadLimits(options?.payloadLimits);
  const limits: PayloadLimits = {
    ...defaultLimits,
    ...options?.payloadLimits,
  };
  const table = buildRegistrationTableFromImpl(
    impl,
    options?.schemas,
    options?.errors,
  );
  return buildBridgeServer(table, limits, options ?? {});
}

/**
 * `RegistrationTable`로부터 실제 `StreamBridgeServer`를 만드는 코어.
 * dispatch·session·stream 로직은 테이블을 만드는 방법(impl 트리 순회)과
 * 분리되어 있다.
 */
function buildBridgeServer(
  table: RegistrationTable,
  limits: PayloadLimits,
  options: CommonServerOptions,
): StreamBridgeServer {
  const resourceLimits = resolveResourceLimits(options.resourceLimits);
  let disposed = false;
  const sessions = new DocumentSessions(resourceLimits, options.diagnostics);
  const manifest = manifestFromTable(table);
  const subscriptions = new Subscriptions(
    table,
    limits,
    resourceLimits,
    options.diagnostics,
    options.authorize,
  );
  const rpcRequests = new RpcRequests(
    table,
    limits,
    resourceLimits,
    options.diagnostics,
    options.authorize,
  );
  const reject = (reason: RejectReason): void => {
    recordDiagnostic(options.diagnostics, { type: "rejected", reason });
  };
  return {
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
    attach(target: AttachedTarget): () => void {
      return sessions.attach(target);
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
        try {
          send(
            withEnvelope(command.clientId, {
              subscriptionId: command.subscriptionId,
              type: "subscribed" as const,
              sequence: 0,
            }),
          );
          send(
            withEnvelope(command.clientId, {
              subscriptionId: command.subscriptionId,
              type: "error" as const,
              sequence: 1,
              error: {
                code: "FORBIDDEN",
                message: SENDER_UNAUTHORIZED_MESSAGE,
              },
            }),
          );
        } catch {
          // 닫힌 renderer route는 통지 대상이 없다(best-effort).
        }
        return;
      }
      await subscriptions.subscribe(admission.session, sender, command, send);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      sessions.dispose();
      subscriptions.dispose();
    },
    getDiagnosticsSnapshot(): DiagnosticsSnapshot {
      return {
        sessions: sessions.sessionCount(),
        rpcInFlight: rpcRequests.inFlightCount(),
        subscriptions: subscriptions.subscriptionCount(),
        queuedEvents: subscriptions.queuedEventsCount(),
      };
    },
  };
}
