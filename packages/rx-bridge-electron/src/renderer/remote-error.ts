import type { BridgeValue } from "../protocol/index.js";

export class RemoteError extends Error {
  public readonly code: string;
  public readonly details?: BridgeValue;

  public constructor(code: string, message: string, details?: BridgeValue) {
    super(message);
    this.name = "RemoteError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

/**
 * Creates the RemoteError returned to callers whose RPC is settled locally
 * because the renderer API has been disposed. Always returns a fresh
 * instance so callers cannot observe shared mutable state through it.
 */
export function createDisposedError(): RemoteError {
  return new RemoteError("CANCELLED", "Renderer API is disposed.");
}

/** Renderer가 원격 응답 없이 로컬에서 확정하는 RemoteError를 만든다. */
export function localError(code: string, message: string): RemoteError {
  return new RemoteError(code, message);
}
