import { describe, expect, test } from "vitest";

import {
  connectionState,
  relayStatus,
  sendCommandInput,
  serialLine,
  setRateInput,
  setSourceSamplingInput,
} from "../src/main/schemas.js";

describe("demo app contract", () => {
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
});
