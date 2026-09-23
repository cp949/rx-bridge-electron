import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import {
  createRendererApi,
  type BridgeTransport,
} from "@cp949/rx-bridge-electron/renderer";

import type { AppBridge } from "../src/bridge/contract.js";
import { MainMonitorApp } from "../src/renderer/App.js";

// `AppBridge`는 타입 계약이라 런타임 manifest를 만들지 못한다(DELTA-06).
// `composition.test.ts`가 `createDemoComposition()`으로 검증하는 실제
// manifest와 같은 모양을 여기서는 리터럴로 재현한다.
const manifest = {
  rpc: [
    "rpc:device/connect",
    "rpc:device/disconnect",
    "rpc:device/send",
    "rpc:device/setRate",
    "rpc:device/setSourceSampling",
    "rpc:device/simulateCableDisconnect",
    "rpc:device/triggerError",
    "rpc:relay/reset",
    "rpc:relay/simulateFault",
    "rpc:relay/turnOff",
    "rpc:relay/turnOn",
  ],
  state: [
    "state:device/connection",
    "state:device/metrics",
    "state:device/packetCount",
    "state:device/signalStrength",
    "state:device/temperature",
    "state:relay/status",
  ],
  event: ["event:device/data", "event:device/error", "event:relay/fault"],
};

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
      manifest,
    }),
    invoke,
    cancel: () => {},
    control: () => {},
    onStreamMessage: () => () => {},
  };
  return {
    api: await createRendererApi<AppBridge>(transport),
    invoke,
  };
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
