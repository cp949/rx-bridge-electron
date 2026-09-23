import { appContract } from "../bridge/contract.js";
import { createBridgeServer } from "@cp949/rx-bridge-electron/main";
import { registerDevice } from "./register-device.js";
import { registerRelay } from "./register-relay.js";
import { createVirtualDevice } from "./virtual-device.js";
import { createVirtualRelay } from "./virtual-relay.js";

export function createDemoComposition() {
  const device = createVirtualDevice();
  const relay = createVirtualRelay();
  const server = createBridgeServer(
    appContract,
    [registerDevice(device), registerRelay(relay)],
    {
      authorize: (context, key) =>
        context.windowRole === "main" ||
        (context.windowRole === "monitor" &&
          (key.startsWith("state:") || key.startsWith("event:"))),
    },
  );
  return {
    server,
    dispose() {
      server.dispose();
      device.dispose();
      relay.dispose();
    },
  };
}
