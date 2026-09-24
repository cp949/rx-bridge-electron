import { firstValueFrom } from "rxjs";
import { describe, expect, test } from "vitest";
import {
  createRendererApi,
  RemoteError,
} from "@cp949/rx-bridge-electron/renderer";
import { createLoopbackTransport } from "@cp949/rx-bridge-electron/testing";
import type { AppBridge } from "../src/bridge/contract.js";
import { createDemoComposition } from "../src/main/composition.js";

// 창마다 `webContentsId`가 다른 loopback transport를 만들어 실제 composition의
// server에 붙인다(admission은 loopback이 내부에서 처리한다). manifest·envelope·
// wire key를 수기로 재현하지 않고 실제 handshake + 타입 붙은 api로 검증한다.
async function connectWindow(
  composition: ReturnType<typeof createDemoComposition>,
  webContentsId: number,
  role: string,
) {
  const transport = createLoopbackTransport(composition.server, {
    sender: { webContentsId, frameId: webContentsId },
    clientId: `client-${webContentsId}`,
    role,
  });
  const api = await createRendererApi<AppBridge>(transport);
  return {
    api,
    dispose() {
      api.dispose();
      transport.dispose();
    },
  };
}

// broadcast event 구독 직후 곧바로 emit하면 loopback의 `control()` microtask
// 지연 때문에 값을 놓칠 수 있다(pending-traps/01). 구독 후 이 flush를 한 번
// 거쳐 실제 upstream 구독이 확정된 뒤에 emit한다.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("demo composition", () => {
  test("publishes only declared device and relay operations", async () => {
    const composition = createDemoComposition();
    const main = await connectWindow(composition, 1, "main");
    try {
      expect(Object.keys(main.api).sort()).toEqual(["device", "relay"]);

      expect(Object.keys(main.api.device).sort()).toEqual([
        "event",
        "rpc",
        "state",
      ]);
      expect(Object.keys(main.api.device.rpc).sort()).toEqual([
        "connect",
        "disconnect",
        "send",
        "setRate",
        "setSourceSampling",
        "simulateCableDisconnect",
        "triggerError",
      ]);
      expect(Object.keys(main.api.device.state).sort()).toEqual([
        "connection",
        "metrics",
        "packetCount",
        "signalStrength",
        "temperature",
      ]);
      expect(Object.keys(main.api.device.event).sort()).toEqual([
        "data",
        "error",
      ]);

      expect(Object.keys(main.api.relay).sort()).toEqual([
        "event",
        "rpc",
        "state",
      ]);
      expect(Object.keys(main.api.relay.rpc).sort()).toEqual([
        "reset",
        "simulateFault",
        "turnOff",
        "turnOn",
      ]);
      expect(Object.keys(main.api.relay.state).sort()).toEqual(["status"]);
      expect(Object.keys(main.api.relay.event).sort()).toEqual(["fault"]);
    } finally {
      main.dispose();
      composition.dispose();
    }
  });

  test("allows controller commands and denies monitor commands", async () => {
    const composition = createDemoComposition();
    const main = await connectWindow(composition, 1, "main");
    const monitor = await connectWindow(composition, 2, "monitor");
    try {
      await expect(main.api.device.rpc.triggerError()).resolves.toBeUndefined();
      await expect(monitor.api.device.rpc.triggerError()).rejects.toMatchObject(
        { code: "FORBIDDEN" },
      );
    } finally {
      main.dispose();
      monitor.dispose();
      composition.dispose();
    }
  });

  test("denies State and Event subscriptions for an unknown role", async () => {
    const composition = createDemoComposition();
    const unknown = await connectWindow(composition, 3, "unknown");
    try {
      const stateErrors: unknown[] = [];
      unknown.api.relay.state.status.subscribe({
        next: () => undefined,
        error: (error) => stateErrors.push(error),
      });
      await flushMicrotasks();
      expect(stateErrors).toEqual([
        expect.objectContaining({ code: "FORBIDDEN" }),
      ]);

      const eventErrors: unknown[] = [];
      unknown.api.relay.event.fault.subscribe({
        next: () => undefined,
        error: (error) => eventErrors.push(error),
      });
      await flushMicrotasks();
      expect(eventErrors).toEqual([
        expect.objectContaining({ code: "FORBIDDEN" }),
      ]);
    } finally {
      unknown.dispose();
      composition.dispose();
    }
  });

  test("routes relay commands, current State, and fault Event through the bridge", async () => {
    const composition = createDemoComposition();
    const main = await connectWindow(composition, 1, "main");
    const monitor = await connectWindow(composition, 2, "monitor");
    try {
      const faults: unknown[] = [];
      monitor.api.relay.event.fault.subscribe((value) => faults.push(value));
      await flushMicrotasks();

      await expect(main.api.relay.rpc.turnOn()).resolves.toMatchObject({
        energized: true,
        faulted: false,
      });
      await expect(main.api.relay.rpc.simulateFault()).resolves.toMatchObject({
        energized: false,
        faulted: true,
      });

      await flushMicrotasks();
      expect(faults).toEqual([
        { code: "RELAY_TRIPPED", message: "Relay overload simulated." },
      ]);

      await expect(main.api.relay.rpc.turnOn()).rejects.toBeInstanceOf(
        RemoteError,
      );
      await expect(monitor.api.relay.rpc.reset()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });

      const status = await firstValueFrom(monitor.api.relay.state.status);
      expect(status).toEqual({ energized: false, faulted: true });
    } finally {
      main.dispose();
      monitor.dispose();
      composition.dispose();
    }
  });
});
