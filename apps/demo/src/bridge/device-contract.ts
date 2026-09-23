import {
  defineDomain,
  event,
  rpc,
  state,
} from "@cp949/rx-bridge-electron/contract";
import {
  connectionState,
  deviceError,
  deviceMetrics,
  noInput,
  nonNegativeInteger,
  numberValue,
  sendCommandInput,
  sendResult,
  serialLine,
  setRateInput,
  setSourceSamplingInput,
} from "./schemas.js";

export const deviceContract = defineDomain("device", {
  rpc: {
    connect: rpc({ input: noInput, output: connectionState }),
    disconnect: rpc({ input: noInput, output: connectionState }),
    send: rpc({ input: sendCommandInput, output: sendResult }),
    setRate: rpc({ input: setRateInput, output: deviceMetrics }),
    setSourceSampling: rpc({
      input: setSourceSamplingInput,
      output: deviceMetrics,
    }),
    triggerError: rpc({ input: noInput, output: noInput }),
    simulateCableDisconnect: rpc({ input: noInput, output: connectionState }),
  },
  state: {
    connection: state(connectionState),
    temperature: state(numberValue),
    signalStrength: state(numberValue),
    packetCount: state(nonNegativeInteger),
    metrics: state(deviceMetrics),
  },
  event: {
    data: event(serialLine, {
      buffer: { capacity: 100, overflow: "drop-oldest" },
    }),
    error: event(deviceError, {
      buffer: { capacity: 20, overflow: "drop-oldest" },
    }),
  },
});
