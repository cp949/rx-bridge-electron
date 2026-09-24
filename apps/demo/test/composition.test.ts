import { describe, expect, test } from "vitest";
import type {
  AttachedTarget,
  SenderIdentity,
} from "@cp949/rx-bridge-electron/main";
import type { StreamMessage } from "@cp949/rx-bridge-electron/protocol";
import { createDemoComposition } from "../src/main/composition.js";

function attachTarget(id: number, role: string): AttachedTarget {
  return {
    webContentsId: id,
    role,
    isCurrentMainFrame: (sender) =>
      sender.webContentsId === id && sender.isMainFrame,
    isAllowedOrigin: (origin) => origin === "app://local",
    onLifecycle: () => () => undefined,
  };
}
function sender(id: number): SenderIdentity {
  return {
    webContentsId: id,
    frameId: id,
    isMainFrame: true,
    origin: "app://local",
  };
}

describe("demo composition", () => {
  test("publishes only declared device and relay operations", () => {
    const composition = createDemoComposition();
    try {
      composition.server.attach(attachTarget(1, "main"));
      const handshake = composition.server.handshake(sender(1), "client-1");
      expect(handshake?.manifest).toEqual({
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
      });
    } finally {
      composition.dispose();
    }
  });

  test("allows controller commands and denies monitor commands", async () => {
    const composition = createDemoComposition();
    try {
      composition.server.attach(attachTarget(1, "main"));
      composition.server.attach(attachTarget(2, "monitor"));
      const request = {
        protocolVersion: 1 as const,
        clientId: "client",
        requestId: "request",
        key: "rpc:device/triggerError",
        input: undefined,
      };
      expect(
        await composition.server.dispatchRpc(sender(1), request),
      ).toMatchObject({
        type: "success",
      });
      expect(
        await composition.server.dispatchRpc(sender(2), request),
      ).toMatchObject({
        type: "error",
        error: { code: "FORBIDDEN" },
      });
    } finally {
      composition.dispose();
    }
  });

  test("denies State and Event subscriptions for an unknown role", async () => {
    const composition = createDemoComposition();
    try {
      composition.server.attach(attachTarget(3, "unknown"));
      const keys = ["state:relay/status", "event:relay/fault"];
      for (const [index, key] of keys.entries()) {
        const messages: StreamMessage[] = [];
        await composition.server.controlStream(
          sender(3),
          {
            protocolVersion: 1,
            clientId: "unknown-client",
            type: "subscribe",
            subscriptionId: `test:subscription:${index + 1}`,
            key,
          },
          (message) => messages.push(message),
        );
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: "error",
            error: expect.objectContaining({ code: "FORBIDDEN" }),
          }),
        );
      }
    } finally {
      composition.dispose();
    }
  });

  test("routes relay commands, current State, and fault Event through the bridge", async () => {
    const composition = createDemoComposition();
    try {
      composition.server.attach(attachTarget(1, "main"));
      composition.server.attach(attachTarget(2, "monitor"));
      const messages: StreamMessage[] = [];
      await composition.server.controlStream(
        sender(2),
        {
          protocolVersion: 1,
          clientId: "monitor-client",
          type: "subscribe",
          subscriptionId: "test:subscription:1",
          key: "event:relay/fault",
        },
        (message) => messages.push(message),
      );
      const call = (requestId: string, operation: string, from = 1) =>
        composition.server.dispatchRpc(sender(from), {
          protocolVersion: 1,
          clientId: from === 1 ? "main-client" : "monitor-client",
          requestId,
          key: `rpc:relay/${operation}`,
          input: undefined,
        });
      expect(await call("on", "turnOn")).toMatchObject({
        type: "success",
        result: { energized: true, faulted: false },
      });
      expect(await call("fault", "simulateFault")).toMatchObject({
        type: "success",
        result: { energized: false, faulted: true },
      });
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: "batch",
          values: [
            { code: "RELAY_TRIPPED", message: "Relay overload simulated." },
          ],
        }),
      );
      expect(await call("blocked", "turnOn")).toMatchObject({ type: "error" });
      expect(await call("denied", "reset", 2)).toMatchObject({
        type: "error",
        error: { code: "FORBIDDEN" },
      });
      await composition.server.controlStream(
        sender(2),
        {
          protocolVersion: 1,
          clientId: "monitor-client",
          type: "subscribe",
          subscriptionId: "test:subscription:2",
          key: "state:relay/status",
        },
        (message) => messages.push(message),
      );
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: "batch",
          values: [{ energized: false, faulted: true }],
        }),
      );
    } finally {
      composition.dispose();
    }
  });
});
