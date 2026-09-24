import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { createRendererApi } from "@cp949/rx-bridge-electron/renderer";
import { createLoopbackTransport } from "@cp949/rx-bridge-electron/testing";

import type { AppBridge } from "../src/bridge/contract.js";
import { createDemoComposition } from "../src/main/composition.js";
import { MainMonitorApp } from "../src/renderer/App.js";

// 실제 composition(`createDemoComposition()`) + loopback transport로 실제
// manifest·handshake·RPC 경로를 거친다 — manifest literal을 수기로 재현하지
// 않는다.
async function monitorHarness() {
  const composition = createDemoComposition();
  const transport = createLoopbackTransport(composition.server, {
    role: "main",
  });
  const invoke = vi.spyOn(transport, "invoke");
  const api = await createRendererApi<AppBridge>(transport);
  return {
    api,
    invoke,
    dispose() {
      api.dispose();
      transport.dispose();
      composition.dispose();
    },
  };
}

describe("MainMonitorApp", () => {
  test("does not treat an absent sampling option as Off", async () => {
    const { api, invoke, dispose } = await monitorHarness();
    try {
      render(<MainMonitorApp api={api} />);

      fireEvent.change(
        screen.getByRole("combobox", { name: "Main sampling" }),
        {
          target: { value: "" },
        },
      );

      expect(invoke).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});
