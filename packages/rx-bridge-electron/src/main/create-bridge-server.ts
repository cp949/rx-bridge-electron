import { publicManifest, type ComposedContract } from "../contract/index.js";
import type {
  HandshakeResponse,
  PayloadLimits,
  RpcResponse,
  WireCancelRequest,
  WireRpcRequest,
  WireStreamCommand,
} from "../protocol/index.js";
import { parseOpaqueIdSequence } from "../protocol/index.js";
import { recordDiagnostic } from "./diagnostics.js";
import { dispatchRegistered, findRpc } from "./rpc-dispatcher.js";
import { DocumentSessions } from "./document-sessions.js";
import { registerImplementations } from "./registration.js";
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

/**
 * Adapter-only recording pathway for rejections the adapter itself judges
 * (`frame-not-main`, `origin-not-allowed`, `malformed-envelope`). Not exported
 * from `./index.js` so user-defined `StreamBridgeServer` implementations never
 * need to know about it.
 */
export const recordAdapterRejection = Symbol("recordAdapterRejection");

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
  [recordAdapterRejection]?(reason: RejectReason): void;
}

export function createBridgeServer<Contract extends ComposedContract>(
  contract: Contract,
  implementations: readonly DomainImplementation<
    keyof Contract["domains"] & string
  >[],
  options: {
    readonly authorize?: Authorize;
    readonly diagnostics?: DiagnosticsSink;
    readonly resourceLimits?: Partial<ResourceLimits>;
  } = {},
): StreamBridgeServer {
  const resourceLimits = resolveResourceLimits(options.resourceLimits);
  let disposed = false;
  const registrations = registerImplementations(contract, implementations);
  const sessions = new DocumentSessions(resourceLimits, options.diagnostics);
  const manifest = publicManifest(contract);
  const limits: PayloadLimits = {
    ...defaultLimits,
    ...contract.payloadLimits,
  };
  const streams = new StreamHub(
    contract,
    registrations,
    limits,
    options.diagnostics,
  );
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
      const registration = findRpc(contract, registrations, envelope.key);
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
        try {
          let allowed: boolean;
          try {
            allowed =
              options.authorize === undefined
                ? true
                : await options.authorize(context, envelope.key);
          } catch (cause) {
            if (controller.signal.aborted)
              return error(envelope, "CANCELLED", "Request cancelled.");
            throw cause;
          }
          if (
            controller.signal.aborted ||
            sessions.current(sender, envelope.clientId) !== session
          )
            return error(envelope, "CANCELLED", "Request cancelled.");
          if (!allowed) {
            recordDiagnostic(options.diagnostics, {
              type: "rejected",
              reason: "authorize-denied",
              key: envelope.key,
            });
            return error(
              envelope,
              "FORBIDDEN",
              "Bridge operation is forbidden.",
            );
          }
          return await dispatchRegistered(
            registration,
            envelope,
            context,
            limits,
            options.diagnostics,
          );
        } finally {
          sessions.finishRpc(session, id, controller);
          sessions.releaseRpc(session);
          recordDiagnostic(options.diagnostics, {
            type: "rpc-finished",
            key: envelope.key,
            durationMs: performance.now() - started,
          });
        }
      })();
      if (!Number.isFinite(resourceLimits.maxRpcDurationMs)) return await work;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<RpcResponse>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
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
          ...(streams.isRegistered(command.key)
            ? { key: command.key }
            : {}),
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
  };
}
