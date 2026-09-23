import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import {
  createRendererApi,
  type BridgeTransport,
} from "@cp949/rx-bridge-electron/renderer";

import { appContract, type AppBridge } from "../src/bridge/contract.js";
import { MainMonitorApp } from "../src/renderer/App.js";
import { publicManifest } from "@cp949/rx-bridge-electron/contract";

async function monitorHarness() {
  const invoke = vi.fn(async () => ({
    protocolVersion: 1 as const,
    clientId: "client-1",
    requestId: "request-1",
    type: "success" as const,
    result: {
      targetPerSecond: 10,
      sourceSamplingMs: 100,
      generatedPerSecond: 0,
      forwardedPerSecond: 0,
      generatedTotal: 0,
      forwardedTotal: 0,
    },
  }));
  const transport: BridgeTransport = {
    connect: async () => ({
      protocolVersion: 1,
      clientId: "client-1",
      manifest: publicManifest(appContract),
    }),
    invoke,
    cancel: () => {},
    control: () => {},
    onStreamMessage: () => () => {},
  };
  return { api: await createRendererApi<AppBridge>(transport), invoke };
}

describe("MainMonitorApp", () => {
  test("does not treat an absent sampling option as Off", async () => {
    const { api, invoke } = await monitorHarness();
    render(<MainMonitorApp api={api} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Main sampling" }), {
      target: { value: "" },
    });

    expect(invoke).not.toHaveBeenCalled();
  });
});
