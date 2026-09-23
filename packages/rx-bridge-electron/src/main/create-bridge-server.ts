import { publicManifest, type ComposedContract } from "../contract/index.js";
import type {
  HandshakeResponse,
  PayloadLimits,
  RpcResponse,
  WireCancelRequest,
  WireRpcRequest,
  WireStreamCommand,
} from "../protocol/index.js";
import { dispatchRegistered, findRpc } from "./rpc-dispatcher.js";
import { DocumentSessions } from "./document-sessions.js";
import { StreamHub, type StreamSender } from "./stream-hub.js";
import type { StreamDomainImplementation } from "./implement-domain.js";
import type {
  AttachedTarget,
  Authorize,
  BridgeContext,
  BridgeServer,
  DiagnosticsSink,
  DomainImplementation,
  SenderIdentity,
} from "./types.js";

const defaultLimits: PayloadLimits = {
  maxDepth: 32,
  maxEntries: 10_000,
  maxStringBytes: 1_000_000,
};

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
}

export function createBridgeServer(
  contract: ComposedContract,
  implementations: readonly DomainImplementation[],
  options: {
    readonly authorize?: Authorize;
    readonly diagnostics?: DiagnosticsSink;
  } = {},
): StreamBridgeServer {
  const sessions = new DocumentSessions(options.diagnostics);
  const manifest = publicManifest(contract);
  const limits = contract.payloadLimits ?? defaultLimits;
  const streams = new StreamHub(
    contract,
    implementations as readonly StreamDomainImplementation[],
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
    handshake(sender, clientId) {
      if (sessions.establish(sender, clientId) === undefined) return undefined;
      return { protocolVersion: 1, clientId, manifest };
    },
    attach(target: AttachedTarget): () => void {
      return sessions.attach(target);
    },
    async dispatchRpc(
      sender: SenderIdentity,
      envelope: WireRpcRequest,
    ): Promise<RpcResponse> {
      if (envelope.protocolVersion !== 1)
        return error(
          envelope,
          "VERSION_MISMATCH",
          "Unsupported protocol version.",
        );
      const session = sessions.establish(sender, envelope.clientId);
      if (session === undefined)
        return error(envelope, "FORBIDDEN", "Bridge sender is not authorized.");
      const registration = findRpc(contract, implementations, envelope.key);
      if (registration === undefined)
        return error(envelope, "NOT_FOUND", "Unknown bridge operation.");
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
        if (!allowed)
          return error(envelope, "FORBIDDEN", "Bridge operation is forbidden.");
        return await dispatchRegistered(
          registration,
          envelope,
          context,
          limits,
        );
      } finally {
        sessions.finishRpc(session, id, controller);
        options.diagnostics?.record({
          type: "rpc-finished",
          key: envelope.key,
          durationMs: performance.now() - started,
        });
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
      if (command.protocolVersion !== 1) return;
      if (command.type !== "subscribe") {
        const session = sessions.current(sender, command.clientId);
        if (session === undefined) return;
        if (command.type === "unsubscribe")
          sessions.cancelStream(
            session,
            keyOf(sender, command.clientId, command.subscriptionId),
          );
        streams.control(sender, command);
        return;
      }
      const session = sessions.establish(sender, command.clientId);
      if (session === undefined) return;
      const id = keyOf(sender, command.clientId, command.subscriptionId);
      const controller = sessions.beginStream(session, id);
      if (controller === undefined) return;
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
        return;
      }
      if (
        !sessions.finishStream(session, id, controller) ||
        sessions.current(sender, command.clientId) !== session
      )
        return;
      if (!allowed) {
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
        return;
      }
      streams.subscribe(
        sender,
        command.clientId,
        session.target.role,
        command,
        send,
        session.signal,
      );
    },
    dispose(): void {
      sessions.dispose();
      streams.dispose();
    },
  };
}
