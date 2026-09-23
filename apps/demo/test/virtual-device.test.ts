import { afterEach, describe, expect, test, vi } from "vitest";
import { createVirtualDevice } from "../src/main/virtual-device.js";
import type { SerialLine } from "../src/bridge/device-contract.js";

describe("VirtualDevice", () => {
  afterEach(() => vi.useRealTimers());

  test("generates only while connected and stops after cable disconnect", async () => {
    vi.useFakeTimers();
    const device = createVirtualDevice();
    await vi.advanceTimersByTimeAsync(100);
    expect(device.packetCount$.value).toBe(0);
    const connecting = device.connect(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(100);
    await connecting;
    await vi.advanceTimersByTimeAsync(200);
    expect(device.packetCount$.value).toBeGreaterThan(0);
    const before = device.packetCount$.value;
    await device.simulateCableDisconnect();
    await vi.advanceTimersByTimeAsync(200);
    expect(device.connection$.value).toEqual({
      connected: false,
      phase: "disconnected",
      reason: "cable-disconnected",
    });
    expect(device.packetCount$.value).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
    device.dispose();
  });

  test("samples RX before data Event, while send emits TX and response", async () => {
    vi.useFakeTimers();
    const device = createVirtualDevice();
    const lines: SerialLine[] = [];
    device.data$.subscribe((line) => lines.push(line));
    const connecting = device.connect(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(100);
    await connecting;
    await device.setRate({ messagesPerSecond: 10000 });
    await device.setSourceSampling({ milliseconds: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(device.packetCount$.value).toBeGreaterThan(1);
    expect(lines.filter((line) => line.kind === "rx")).toHaveLength(1);
    await device.send({ command: "AT+STATUS" }, new AbortController().signal);
    expect(lines).toContainEqual(
      expect.objectContaining({ kind: "tx", text: "AT+STATUS" }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ kind: "system", text: "OK AT+STATUS" }),
    );
    device.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("cancelled connect leaves disconnected with no generator", async () => {
    vi.useFakeTimers();
    const device = createVirtualDevice();
    const controller = new AbortController();
    const connecting = device.connect(controller.signal);
    controller.abort();
    await expect(connecting).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(200);
    expect(device.connection$.value).toEqual({
      connected: false,
      phase: "disconnected",
    });
    expect(device.packetCount$.value).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    device.dispose();
  });

  test("emits typed error without changing connection State", () => {
    const device = createVirtualDevice();
    const errors: unknown[] = [];
    device.error$.subscribe((error) => errors.push(error));
    device.triggerError();
    expect(errors).toEqual([
      { code: "DEVICE_TIMEOUT", message: "Device response timeout" },
    ]);
    expect(device.connection$.value.phase).toBe("disconnected");
    device.dispose();
  });

  test("reports a measured source rate and zeroes it after disconnect", async () => {
    vi.useFakeTimers();
    const device = createVirtualDevice();
    const connecting = device.connect(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(100);
    await connecting;
    await vi.advanceTimersByTimeAsync(1000);
    expect(device.packetCount$.value).toBe(10);
    expect(device.metrics$.value.generatedPerSecond).toBe(10);
    await device.disconnect(new AbortController().signal);
    expect(device.metrics$.value.generatedPerSecond).toBe(0);
    device.dispose();
  });

  test("defaults to bounded source sampling when stress generation is selected", async () => {
    vi.useFakeTimers();
    const device = createVirtualDevice();
    let forwarded = 0;
    device.data$.subscribe((line) => {
      if (line.kind === "rx") forwarded += 1;
    });
    const connecting = device.connect(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(100);
    await connecting;
    await device.setRate({ messagesPerSecond: 10000 });
    await vi.advanceTimersByTimeAsync(100);
    expect(device.packetCount$.value).toBe(1000);
    expect(forwarded).toBeLessThan(10);
    device.dispose();
  });

  test("dispose cancels a pending connection timer", async () => {
    vi.useFakeTimers();
    const device = createVirtualDevice();
    const connecting = device.connect(new AbortController().signal);
    device.dispose();
    await expect(connecting).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  test("measured rate follows a changed source target without old history", async () => {
    vi.useFakeTimers();
    const device = createVirtualDevice();
    const connecting = device.connect(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(100);
    await connecting;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(device.metrics$.value.generatedPerSecond).toBe(10);
    await device.setRate({ messagesPerSecond: 1000 });
    await vi.advanceTimersByTimeAsync(100);
    expect(device.metrics$.value.generatedPerSecond).toBeGreaterThan(900);
    device.dispose();
  });
});
