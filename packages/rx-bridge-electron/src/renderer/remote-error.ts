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
