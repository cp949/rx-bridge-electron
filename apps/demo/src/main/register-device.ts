import { deviceContract } from "../bridge/device-contract.js";
import {
  broadcastEvent,
  currentValueSource,
  implementDomain,
} from "@cp949/rx-bridge-electron/main";
import type { Device } from "./virtual-device.js";

export function registerDevice(device: Device) {
  return implementDomain(deviceContract, {
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
      data: broadcastEvent(device.data$),
      error: broadcastEvent(device.error$),
    },
  });
}
