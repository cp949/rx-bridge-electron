import type { DeviceBridge } from "./device-contract.js";
import type { RelayBridge } from "./relay-contract.js";

export type AppBridge = DeviceBridge & RelayBridge;
