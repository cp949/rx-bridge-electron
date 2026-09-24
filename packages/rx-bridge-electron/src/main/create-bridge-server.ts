// bridge-types.ts에서 직접 import한다(barrel `../contract/index.js`를 거치면
// tsup의 dts 번들러가 `contract`/`main` 두 entry가 같은 파일을 서로 다른
// chunk에서 참조한다고 보고 순환 chunk 경고를 낸다 — 타입 전용 import라
// 런타임 순환은 없지만, 경고 자체를 없애기 위해 원본 모듈을 직접 가리킨다).
import type {
  BridgeImpl,
  ErrorsFor,
  SchemasFor,
} from "../contract/bridge-types.js";
import type {
  HandshakeResponse,
  PayloadLimits,
  RpcResponse,
  WireCancelRequest,
  WireRpcRequest,
  WireStreamCommand,
} from "../protocol/index.js";
import { recordAdapterRejection, recordDiagnostic } from "./diagnostics.js";
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

const defaultLimits: PayloadLimits = {
  maxDepth: 32,
  maxEntries: 10_000,
  maxStringBytes: 1_000_000,
  maxTotalBytes: 16_777_216,
};

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
    clientId: string,
  ): HandshakeResponse | undefined;
  controlStream(
    sender: SenderIdentity,
    command: WireStreamCommand,
    send: StreamSender,
  ): Promise<void>;
  getDiagnosticsSnapshot(): DiagnosticsSnapshot;
  [recordAdapterRejection]?(reason: RejectReason): void;
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
  const error = (
    envelope: WireRpcRequest,
    code: string,
    message: string,
  ): RpcResponse => ({
    protocolVersion: 1,
    clientId: envelope.clientId,
    requestId: envelope.requestId,
    type: "error",
    error: { code, message },
  });
  return {
    [recordAdapterRejection](reason: RejectReason): void {
      recordDiagnostic(options.diagnostics, { type: "rejected", reason });
    },
    handshake(sender, clientId) {
      if (sessions.establish(sender, clientId) === undefined) {
        recordDiagnostic(options.diagnostics, {
          type: "rejected",
          reason: "sender-unauthorized",
        });
        return undefined;
      }
      return { protocolVersion: 1, clientId, manifest };
    },
    attach(target: AttachedTarget): () => void {
      return sessions.attach(target);
    },
    async dispatchRpc(
      sender: SenderIdentity,
      envelope: WireRpcRequest,
    ): Promise<RpcResponse> {
      if (envelope.protocolVersion !== 1) {
        recordDiagnostic(options.diagnostics, {
          type: "rejected",
          reason: "version-mismatch",
        });
        return error(
          envelope,
          "VERSION_MISMATCH",
          "Unsupported protocol version.",
        );
      }
      const session = sessions.establish(sender, envelope.clientId);
      if (session === undefined) {
        recordDiagnostic(options.diagnostics, {
          type: "rejected",
          reason: "sender-unauthorized",
        });
        return error(envelope, "FORBIDDEN", "Bridge sender is not authorized.");
      }
      return rpcRequests.dispatch(session, sender, envelope);
    },
    cancel(sender: SenderIdentity, envelope: WireCancelRequest): void {
      const session = sessions.current(sender, envelope.clientId);
      if (session !== undefined)
        rpcRequests.cancel(session, envelope.requestId);
    },
    async controlStream(
      sender: SenderIdentity,
      command: WireStreamCommand,
      send: StreamSender,
    ): Promise<void> {
      if (command.protocolVersion !== 1) {
        recordDiagnostic(options.diagnostics, {
          type: "rejected",
          reason: "version-mismatch",
        });
        return;
      }
      if (command.type !== "subscribe") {
        const session = sessions.current(sender, command.clientId);
        if (session === undefined) {
          recordDiagnostic(options.diagnostics, {
            type: "rejected",
            reason: "sender-unauthorized",
          });
          return;
        }
        subscriptions.control(session, command);
        return;
      }
      const session = sessions.establish(sender, command.clientId);
      if (session === undefined) {
        recordDiagnostic(options.diagnostics, {
          type: "rejected",
          reason: "sender-unauthorized",
        });
        return;
      }
      await subscriptions.subscribe(session, sender, command, send);
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
