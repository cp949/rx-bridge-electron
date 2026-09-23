import type { BridgeValue } from "../protocol/index.js";

/** Structural runtime validator used at the Main IPC boundary. */
export interface Schema<T extends BridgeValue> {
  parse(value: unknown): T;
}
