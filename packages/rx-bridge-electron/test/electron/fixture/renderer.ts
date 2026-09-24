import { createRendererApi } from "../../../src/renderer/index.js";
import type { FixtureBridge } from "./contract.js";

declare global {
  interface Window {
    fixtureRendererResult?: {
      readonly ready: boolean;
      readonly error?: string;
    };
  }
}

void createRendererApi<FixtureBridge>()
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
