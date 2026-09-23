import { relayContract } from "../bridge/relay-contract.js";
import {
  broadcastEvent,
  currentValueSource,
  implementDomain,
} from "@cp949/rx-bridge-electron/main";
import type { VirtualRelay } from "./virtual-relay.js";

export function registerRelay(relay: VirtualRelay) {
  return implementDomain(relayContract, {
    rpc: {
      turnOn: () => relay.turnOn(),
      turnOff: () => relay.turnOff(),
      simulateFault: () => relay.simulateFault(),
      reset: () => relay.reset(),
    },
    state: { status: currentValueSource(relay.status$) },
    event: { fault: broadcastEvent(relay.fault$) },
  });
}
