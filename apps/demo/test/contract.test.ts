import { describe, expect, expectTypeOf, test } from "vitest";
import { publicManifest } from "@cp949/rx-bridge-electron/contract";

import { appContract } from "../src/bridge/contract.js";
import {
  type ConnectionState,
  connectionState,
  serialLine,
  sendCommandInput,
  setRateInput,
  setSourceSamplingInput,
} from "../src/bridge/schemas.js";
import { relayStatus } from "../src/bridge/relay-contract.js";

type IsReadonly<T, K extends keyof T> =
  (<U>() => U extends Pick<T, K> ? 1 : 2) extends <U>() => U extends Readonly<
    Pick<T, K>
  >
    ? 1
    : 2
    ? true
    : false;

describe("demo app contract", () => {
  test("keeps parsed connection state read-only in TypeScript", () => {
    expectTypeOf<
      IsReadonly<ConnectionState, "connected">
    >().toEqualTypeOf<true>();
  });
  test("does not freeze parsed payloads at runtime", () => {
    expect(
      Object.isFrozen(
        connectionState.parse({ connected: false, phase: "disconnected" }),
      ),
    ).toBe(false);
  });
  test("rejects unsafe command and unsupported source policies", () => {
    expect(sendCommandInput.parse({ command: "AT+STATUS" })).toEqual({
      command: "AT+STATUS",
    });
    expect(() => sendCommandInput.parse({ command: "" })).toThrow(/command/i);
    expect(() => sendCommandInput.parse({ command: "AT\nRESET" })).toThrow(
      /command/i,
    );
    expect(setRateInput.parse({ messagesPerSecond: 1000 })).toEqual({
      messagesPerSecond: 1000,
    });
    expect(() => setRateInput.parse({ messagesPerSecond: 999 })).toThrow(
      /10, 100, 1000, or 10000/,
    );
    expect(() => setSourceSamplingInput.parse({ milliseconds: 5 })).toThrow(
      /0, 10, or 100/,
    );
  });

  test("keeps state relationships and strips undeclared fields", () => {
    expect(
      connectionState.parse({
        connected: false,
        phase: "disconnected",
        reason: "cable-disconnected",
        ignored: true,
      }),
    ).toEqual({
      connected: false,
      phase: "disconnected",
      reason: "cable-disconnected",
    });
    expect(() =>
      connectionState.parse({ connected: true, phase: "connecting" }),
    ).toThrow();
    expect(() =>
      relayStatus.parse({ energized: true, faulted: true }),
    ).toThrow();
    expect(() =>
      serialLine.parse({ kind: "other", text: "x", at: 1 }),
    ).toThrow();
  });

  test("keeps the serial line's 256 UTF-16 code unit limit", () => {
    expect(() =>
      serialLine.parse({ kind: "rx", text: "😀".repeat(129), at: 1 }),
    ).toThrow();
  });

  test("publishes only declared device and relay operations", () => {
    expect(publicManifest(appContract)).toEqual({
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
  });
});
