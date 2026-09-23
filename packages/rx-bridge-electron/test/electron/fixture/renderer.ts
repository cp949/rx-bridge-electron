import {
  createRendererApi,
  type BridgeTransport,
} from "../../../src/renderer/index.js";
import type { FixtureBridge } from "./contract.js";

declare global {
  interface Window {
    readonly rxBridge: BridgeTransport;
    fixtureRendererResult?: {
      readonly ready: boolean;
      readonly error?: string;
    };
  }
}

void createRendererApi<FixtureBridge>(window.rxBridge)
  .then((api) => {
    window.fixtureRendererResult = {
      ready: typeof api.device.rpc.ping === "function",
    };
  })
  .catch((error: unknown) => {
    window.fixtureRendererResult = {
      ready: false,
      error: error instanceof Error ? error.message : String(error),
    };
  });
