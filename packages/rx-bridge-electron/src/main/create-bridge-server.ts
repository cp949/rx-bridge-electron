import type { ComposedContract } from "../contract/index.js";
// bridge-types.ts에서 직접 import한다(barrel `../contract/index.js`를 거치면
// tsup의 dts 번들러가 `contract`/`main` 두 entry가 같은 파일을 서로 다른
// chunk에서 참조한다고 보고 순환 chunk 경고를 낸다 — 타입 전용 import라
// 런타임 순환은 없지만, 경고 자체를 없애기 위해 원본 모듈을 직접 가리킨다).
import type { BridgeImpl, ErrorsFor, SchemasFor } from "../contract/bridge-types.js";
import type {
  HandshakeResponse,
  PayloadLimits,
  RpcResponse,
  WireCancelRequest,
  WireRpcRequest,
  WireStreamCommand,
} from "../protocol/index.js";
import { parseOpaqueIdSequence } from "../protocol/index.js";
import { recordAdapterRejection, recordDiagnostic } from "./diagnostics.js";
import { dispatchRegistered, findRpc } from "./rpc-dispatcher.js";
import { DocumentSessions } from "./document-sessions.js";
import {
  buildRegistrationTableFromContract,
  buildRegistrationTableFromImpl,
  manifestFromTable,
  registerImplementations,
  type RegistrationTable,
} from "./registration.js";
import {
  resolveResourceLimits,
  type ResourceLimits,
} from "./resource-limits.js";
import { StreamHub, type StreamSender } from "./stream-hub.js";
import type {
  AttachedTarget,
  Authorize,
  BridgeContext,
  BridgeServer,
  DiagnosticsSink,
  DiagnosticsSnapshot,
  DomainImplementation,
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
 * `options.payloadLimits`(경량 계약 impl 경로, DELTA-04)를 검증한다.
 * `contract.payloadLimits`(기존 경로, `composeContracts`가 검증)와 달리 이
 * 옵션은 부분 지정을 허용한다(`ResourceLimits`와 같은 패턴) — 생략한 필드는
 * `defaultLimits`를 그대로 쓴다.
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

/**
 * 첫 인자가 기존 descriptor 기반 `ComposedContract`인지 판별한다.
 * `composeContracts`가 만든 값은 항상 own property `domains`(non-null
 * object)를 갖는다 — 경량 계약 impl 트리는 도메인 이름이 `"domains"`인
 * 극단적인 경우가 아니면 이 모양을 만들 수 없다. 두 번째 인자가 배열인지
 * (기존 시그니처의 `implementations`) 함께 확인해 오판별 위험을 낮춘다.
 */
function looksLikeComposedContract(value: unknown): value is ComposedContract {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "domains") &&
    typeof (value as { domains?: unknown }).domains === "object" &&
    (value as { domains?: unknown }).domains !== null
  );
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

/** 기존(descriptor 기반) `createBridgeServer(contract, implementations, options)` 오버로드의 옵션. */
export type ContractServerOptions = CommonServerOptions;

/** 신규(경량 계약 impl 기반) `createBridgeServer(impl, options)` 오버로드의 옵션(RD-011). */
export interface ImplServerOptions<B> extends CommonServerOptions {
  readonly schemas?: SchemasFor<B>;
  readonly errors?: ErrorsFor<B>;
  readonly payloadLimits?: Partial<PayloadLimits>;
}

export function createBridgeServer<Contract extends ComposedContract>(
  contract: Contract,
  implementations: readonly DomainImplementation<
    keyof Contract["domains"] & string
  >[],
  options?: ContractServerOptions,
): StreamBridgeServer;
export function createBridgeServer<B>(
  impl: BridgeImpl<B>,
  options?: ImplServerOptions<B>,
): StreamBridgeServer;
export function createBridgeServer(
  first: unknown,
  second?: unknown,
  third?: unknown,
): StreamBridgeServer {
  if (Array.isArray(second)) {
    if (!looksLikeComposedContract(first)) {
      throw new TypeError(
        "createBridgeServer(contract, implementations, options) requires a composed contract (from composeContracts) as the first argument.",
      );
    }
    const contract = first;
    const implementations = second as readonly DomainImplementation[];
    const options = (third ?? {}) as ContractServerOptions;
    const registrations = registerImplementations(contract, implementations);
    const table = buildRegistrationTableFromContract(contract, registrations);
    const limits: PayloadLimits = {
      ...defaultLimits,
      ...contract.payloadLimits,
    };
    return buildBridgeServer(table, limits, options);
  }
  if (third !== undefined) {
    throw new TypeError(
      "createBridgeServer(impl, options) accepts at most two arguments.",
    );
  }
  const options = (second ?? {}) as ImplServerOptions<unknown>;
  assertPartialPayloadLimits(options.payloadLimits);
  const limits: PayloadLimits = {
    ...defaultLimits,
    ...options.payloadLimits,
  };
  const table = buildRegistrationTableFromImpl(
    first,
    options.schemas,
    options.errors,
  );
  return buildBridgeServer(table, limits, options);
}

/**
 * `RegistrationTable`(descriptor 기반이든 impl 기반이든 같은 모양)로부터
 * 실제 `StreamBridgeServer`를 만드는 공유 코어. DELTA-03이 두 경로의 내부를
 * 이 테이블 모양으로 정규화해 둔 덕에, DELTA-04는 테이블을 만드는 방법만
 * 늘리고 dispatch·session·stream 로직은 그대로 재사용한다.
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
  const streams = new StreamHub(table, limits, options.diagnostics);
  const keyOf = (sender: SenderIdentity, clientId: string, requestId: string) =>
    JSON.stringify([sender.webContentsId, sender.frameId, clientId, requestId]);
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
      const registration = findRpc(table, envelope.key);
      if (registration === undefined) {
        recordDiagnostic(options.diagnostics, {
          type: "rejected",
          reason: "unknown-operation",
        });
        return error(envelope, "NOT_FOUND", "Unknown bridge operation.");
      }
      if (!sessions.tryAcquireRpc(session)) {
        recordDiagnostic(options.diagnostics, {
          type: "rejected",
          reason: "rpc-limit",
          key: envelope.key,
        });
        return error(
          envelope,
          "RESOURCE_EXHAUSTED",
          "Too many concurrent bridge requests.",
        );
      }
      const id = keyOf(sender, envelope.clientId, envelope.requestId);
      const controller = sessions.beginRpc(session, id, envelope.key);
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
              options.authorize === undefined
                ? true
                : await options.authorize(context, envelope.key);
          } catch {
            response = controller.signal.aborted
              ? error(envelope, "CANCELLED", "Request cancelled.")
              : error(envelope, "INTERNAL", "Internal bridge error.");
            return response;
          }
          if (
            controller.signal.aborted ||
            sessions.current(sender, envelope.clientId) !== session
          ) {
            response = error(envelope, "CANCELLED", "Request cancelled.");
            return response;
          }
          if (!allowed) {
            recordDiagnostic(options.diagnostics, {
              type: "rejected",
              reason: "authorize-denied",
              key: envelope.key,
            });
            response = error(
              envelope,
              "FORBIDDEN",
              "Bridge operation is forbidden.",
            );
            return response;
          }
          response = await dispatchRegistered(
            registration,
            envelope,
            context,
            limits,
            options.diagnostics,
          );
          return response;
        } finally {
          sessions.finishRpc(session, id, controller);
          sessions.releaseRpc(session);
          recordDiagnostic(options.diagnostics, {
            type: "rpc-finished",
            key: envelope.key,
            durationMs: performance.now() - started,
            outcome: response?.type === "success" ? "ok" : "error",
          });
        }
      })();
      if (!Number.isFinite(resourceLimits.maxRpcDurationMs)) return await work;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<RpcResponse>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          recordDiagnostic(options.diagnostics, {
            type: "rpc-timed-out",
            key: envelope.key,
          });
          resolve(
            error(
              envelope,
              "DEADLINE_EXCEEDED",
              "Request exceeded the server deadline.",
            ),
          );
        }, resourceLimits.maxRpcDurationMs);
      });
      try {
        return await Promise.race([work, deadline]);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel(sender: SenderIdentity, envelope: WireCancelRequest): void {
      const session = sessions.current(sender, envelope.clientId);
      if (session !== undefined)
        sessions.cancelRpc(
          session,
          keyOf(sender, envelope.clientId, envelope.requestId),
        );
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
        if (command.type === "unsubscribe")
          sessions.cancelStream(
            session,
            keyOf(sender, command.clientId, command.subscriptionId),
          );
        streams.control(sender, command);
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
      const sequence = parseOpaqueIdSequence(command.subscriptionId);
      if (sequence === undefined) {
        recordDiagnostic(options.diagnostics, {
          type: "rejected",
          reason: "invalid-input",
        });
        streams.reject(
          sender,
          command,
          send,
          {
            code: "INVALID_ARGUMENT",
            message: "Invalid bridge subscription ID.",
          },
          session.signal,
        );
        return;
      }
      const id = keyOf(sender, command.clientId, command.subscriptionId);
      const begin = sessions.beginStream(session, id, sequence);
      if (begin.kind === "duplicate") return;
      if (begin.kind === "exhausted") {
        recordDiagnostic(options.diagnostics, {
          type: "rejected",
          reason: "subscription-limit",
        });
        streams.reject(
          sender,
          command,
          send,
          {
            code: "RESOURCE_EXHAUSTED",
            message: "Too many bridge subscriptions.",
          },
          session.signal,
        );
        return;
      }
      const controller = begin.controller;
      const context: BridgeContext = {
        requestId: command.subscriptionId,
        clientId: command.clientId,
        windowRole: session.target.role,
        sender,
        signal: controller.signal,
      };
      let allowed: boolean;
      try {
        allowed =
          options.authorize === undefined
            ? true
            : await options.authorize(context, command.key);
      } catch {
        if (
          sessions.finishStream(session, id, controller) &&
          sessions.current(sender, command.clientId) === session
        )
          streams.reject(
            sender,
            command,
            send,
            {
              code: "INTERNAL",
              message: "Internal bridge error.",
            },
            session.signal,
          );
        sessions.releaseStream(session, id);
        return;
      }
      if (
        !sessions.finishStream(session, id, controller) ||
        sessions.current(sender, command.clientId) !== session
      ) {
        sessions.releaseStream(session, id);
        return;
      }
      if (!allowed) {
        recordDiagnostic(options.diagnostics, {
          type: "rejected",
          reason: "authorize-denied",
          ...(streams.isRegistered(command.key) ? { key: command.key } : {}),
        });
        streams.reject(
          sender,
          command,
          send,
          {
            code: "FORBIDDEN",
            message: "Bridge operation is forbidden.",
          },
          session.signal,
        );
        sessions.releaseStream(session, id);
        return;
      }
      streams.subscribe(
        sender,
        command.clientId,
        session.target.role,
        command,
        send,
        session.signal,
        () => sessions.releaseStream(session, id),
      );
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      sessions.dispose();
      streams.dispose();
    },
    getDiagnosticsSnapshot(): DiagnosticsSnapshot {
      return {
        sessions: sessions.sessionCount(),
        rpcInFlight: sessions.rpcInFlightCount(),
        subscriptions: sessions.subscriptionCount(),
        queuedEvents: streams.queuedEventsCount(),
      };
    },
  };
}
