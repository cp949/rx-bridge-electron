import { createBridgeServer } from "@cp949/rx-bridge-electron/main";
import type { BridgeImpl } from "@cp949/rx-bridge-electron/contract";
import type { AppBridge } from "../bridge/contract.js";
import { errors, schemas } from "./schemas.js";
import { registerDevice } from "./register-device.js";
import { registerRelay } from "./register-relay.js";
import { createVirtualDevice } from "./virtual-device.js";
import { createVirtualRelay } from "./virtual-relay.js";

export function createDemoComposition() {
  const device = createVirtualDevice();
  const relay = createVirtualRelay();
  const impl: BridgeImpl<AppBridge> = {
    device: registerDevice(device),
    relay: registerRelay(relay),
  };
  const server = createBridgeServer(impl, {
    schemas,
    errors,
    authorize: (context, operation) =>
      context.windowRole === "main" ||
      (context.windowRole === "monitor" && operation.category !== "rpc"),
  });
  return {
    server,
    dispose() {
      server.dispose();
      device.dispose();
      relay.dispose();
    },
  };
}
