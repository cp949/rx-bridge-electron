import {
  createRendererApi,
  type BridgeTransport,
} from "../../../src/renderer/index.js";

interface FixtureApi {
  readonly device: { readonly ping: (input: string) => Promise<string> };
}

declare global {
  interface Window {
    readonly rxBridge: BridgeTransport;
    fixtureRendererResult?: {
      readonly ready: boolean;
      readonly error?: string;
    };
  }
}

void createRendererApi<FixtureApi>(window.rxBridge)
  .then((api) => {
    window.fixtureRendererResult = {
      ready: typeof api.device.ping === "function",
    };
  })
  .catch((error: unknown) => {
    window.fixtureRendererResult = {
      ready: false,
      error: error instanceof Error ? error.message : String(error),
    };
  });
