import {
  broadcastEvent,
  currentValueSource,
} from "@cp949/rx-bridge-electron/main";
import type { BridgeImpl } from "@cp949/rx-bridge-electron/contract";
import type { AppBridge } from "../bridge/contract.js";
import type { VirtualRelay } from "./virtual-relay.js";

export function registerRelay(
  relay: VirtualRelay,
): BridgeImpl<AppBridge>["relay"] {
  return {
    rpc: {
      turnOn: () => relay.turnOn(),
      turnOff: () => relay.turnOff(),
      simulateFault: () => relay.simulateFault(),
      reset: () => relay.reset(),
    },
    state: { status: currentValueSource(relay.status$) },
    event: {
      fault: broadcastEvent(relay.fault$, {
        buffer: { capacity: 20, overflow: "drop-oldest" },
      }),
    },
  };
}
