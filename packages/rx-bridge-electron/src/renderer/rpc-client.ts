import {
  parseRpcResponse,
  type BridgeValue,
  type ProtocolEnvelope,
} from "../protocol/index.js";
import { createOpaqueId } from "./ids.js";
import {
  createDisposedError,
  localError,
  RemoteError,
} from "./remote-error.js";
import type { BridgeTransport, CallOptions } from "./transport.js";

const DEFAULT_TIMEOUT_MS = 30_000;

function readTimeout(timeoutMs: number | undefined): number {
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
  #disposed = false;
  readonly #pending = new Set<() => void>();

  public constructor(transport: BridgeTransport, session: ProtocolEnvelope) {
    this.#transport = transport;
    this.#session = session;
  }

  public call(
    key: string,
    input: BridgeValue,
    options: CallOptions = {},
  ): Promise<BridgeValue> {
    if (this.#disposed) {
      return Promise.reject(createDisposedError());
    }

    if (options.signal?.aborted === true) {
      return Promise.reject(localError("CANCELLED", "RPC call was cancelled."));
    }

    let timeoutMs: number;
    try {
      timeoutMs = readTimeout(options.timeoutMs);
    } catch (error) {
      return Promise.reject(error);
    }

    const requestId = createOpaqueId("request");
    let settled = false;
    let sent = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let disposeListener: (() => void) | undefined;

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

      // 확정을 cancel 전송보다 먼저 선점한다. `transport.cancel`이 이 호출의
      // abort·dispose를 동기로 재진입시켜도 먼저 발생한 원인이 이기고 cancel은
      // 한 번만 나간다.
      const cancelOnce = (error: RemoteError): void => {
        if (!beginSettlement()) {
          return;
        }
        if (sent) {
          try {
            this.#transport.cancel(requestId);
          } catch {
            // Local settlement must not depend on cancellation delivery.
          }
        }
        reject(error);
      };

      disposeListener = () => {
        cancelOnce(createDisposedError());
      };
      this.#pending.add(disposeListener);

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
            const response = parseRpcResponse(rawResponse);
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
      if (disposeListener !== undefined) {
        this.#pending.delete(disposeListener);
      }
    });
  }

  /**
   * Settles every RPC that is still pending as CANCELLED and marks this
   * client as disposed so future calls are rejected without being sent.
   * Idempotent: a second call is a no-op.
   */
  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    const listeners = [...this.#pending];
    this.#pending.clear();
    for (const listener of listeners) {
      listener();
    }
  }
}
