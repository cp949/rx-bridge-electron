import {
  parseRpcResponse,
  type BridgeValue,
  type PayloadLimits,
  type ProtocolEnvelope,
} from "../protocol/index.js";
import { createOpaqueId } from "./ids.js";
import { RemoteError } from "./remote-error.js";
import type { BridgeTransport, CallOptions } from "./transport.js";

const envelopeLimits: PayloadLimits = {
  maxDepth: Number.MAX_SAFE_INTEGER,
  maxEntries: Number.MAX_SAFE_INTEGER,
  maxStringBytes: Number.MAX_SAFE_INTEGER,
};

const DEFAULT_TIMEOUT_MS = 30_000;

export interface RpcClientOptions {
  readonly defaultTimeoutMs?: number;
}

function localError(code: string, message: string): RemoteError {
  return new RemoteError(code, message);
}

function readTimeout(
  timeoutMs: number | undefined,
  defaultTimeoutMs: number,
): number {
  const timeout = timeoutMs ?? defaultTimeoutMs;
  if (timeout === Number.POSITIVE_INFINITY) {
    return timeout;
  }
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw localError(
      "INVALID_ARGUMENT",
      "RPC timeout must be a non-negative finite number or Infinity.",
    );
  }
  return timeout;
}

export class RpcClient {
  readonly #transport: BridgeTransport;
  readonly #session: ProtocolEnvelope;
  readonly #defaultTimeoutMs: number;

  public constructor(
    transport: BridgeTransport,
    session: ProtocolEnvelope,
    options: RpcClientOptions = {},
  ) {
    this.#transport = transport;
    this.#session = session;
    this.#defaultTimeoutMs = readTimeout(
      options.defaultTimeoutMs,
      DEFAULT_TIMEOUT_MS,
    );
  }

  public call(
    key: string,
    input: BridgeValue,
    options: CallOptions = {},
  ): Promise<BridgeValue> {
    if (options.signal?.aborted === true) {
      return Promise.reject(localError("CANCELLED", "RPC call was cancelled."));
    }

    let timeoutMs: number;
    try {
      timeoutMs = readTimeout(options.timeoutMs, this.#defaultTimeoutMs);
    } catch (error) {
      return Promise.reject(error);
    }

    const requestId = createOpaqueId("request");
    let settled = false;
    let sent = false;
    let cancellationSent = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;

    const result = new Promise<BridgeValue>((resolve, reject) => {
      const beginSettlement = (): boolean => {
        if (settled) {
          return false;
        }
        settled = true;
        return true;
      };

      const rejectOnce = (error: RemoteError): void => {
        if (beginSettlement()) {
          reject(error);
        }
      };

      const resolveOnce = (value: BridgeValue): void => {
        if (beginSettlement()) {
          resolve(value);
        }
      };

      const cancelOnce = (error: RemoteError): void => {
        if (settled) {
          return;
        }
        if (sent && !cancellationSent) {
          cancellationSent = true;
          try {
            this.#transport.cancel(requestId);
          } catch {
            // Local settlement must not depend on cancellation delivery.
          }
        }
        rejectOnce(error);
      };

      abortListener = () => {
        cancelOnce(localError("CANCELLED", "RPC call was cancelled."));
      };
      options.signal?.addEventListener("abort", abortListener, { once: true });
      if (options.signal?.aborted === true) {
        abortListener();
        return;
      }

      if (timeoutMs !== Number.POSITIVE_INFINITY) {
        timer = setTimeout(() => {
          cancelOnce(
            localError("DEADLINE_EXCEEDED", "RPC call exceeded its deadline."),
          );
        }, timeoutMs);
      }

      let invocation: Promise<unknown>;
      try {
        sent = true;
        invocation = this.#transport.invoke({ requestId, key, input });
      } catch {
        rejectOnce(localError("INTERNAL", "RPC transport failed."));
        return;
      }

      void Promise.resolve(invocation).then(
        (rawResponse) => {
          if (settled) {
            return;
          }
          try {
            const response = parseRpcResponse(rawResponse, envelopeLimits);
            if (
              response.protocolVersion !== this.#session.protocolVersion ||
              response.clientId !== this.#session.clientId ||
              response.requestId !== requestId
            ) {
              throw new Error(
                "RPC response does not match the active request.",
              );
            }
            if (response.type === "error") {
              rejectOnce(
                new RemoteError(
                  response.error.code,
                  response.error.message,
                  response.error.details,
                ),
              );
              return;
            }
            resolveOnce(response.result);
          } catch (error) {
            if (error instanceof RemoteError) {
              rejectOnce(error);
              return;
            }
            rejectOnce(localError("INTERNAL", "Malformed RPC response."));
          }
        },
        () => {
          rejectOnce(localError("INTERNAL", "RPC transport failed."));
        },
      );
    });

    return result.finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (abortListener !== undefined) {
        options.signal?.removeEventListener("abort", abortListener);
      }
    });
  }
}
