import {
  broadcastEvent,
  currentValueSource,
} from "@cp949/rx-bridge-electron/main";
import type { BridgeImpl } from "@cp949/rx-bridge-electron/contract";
import type { AppBridge } from "../bridge/contract.js";
import type { Device } from "./virtual-device.js";

export function registerDevice(
  device: Device,
): BridgeImpl<AppBridge>["device"] {
  return {
    rpc: {
      connect: (_input, context) => device.connect(context.signal),
      disconnect: (_input, context) => device.disconnect(context.signal),
      send: (input, context) => device.send(input, context.signal),
      setRate: (input) => device.setRate(input),
      setSourceSampling: (input) => device.setSourceSampling(input),
      triggerError: () => {
        device.triggerError();
        return undefined;
      },
      simulateCableDisconnect: () => device.simulateCableDisconnect(),
    },
    state: {
      connection: currentValueSource(device.connection$),
      temperature: currentValueSource(device.temperature$),
      signalStrength: currentValueSource(device.signalStrength$),
      packetCount: currentValueSource(device.packetCount$),
      metrics: currentValueSource(device.metrics$),
    },
    event: {
      data: broadcastEvent(device.data$, {
        buffer: { capacity: 100, overflow: "drop-oldest" },
      }),
      error: broadcastEvent(device.error$, {
        buffer: { capacity: 20, overflow: "drop-oldest" },
      }),
    },
  };
}
