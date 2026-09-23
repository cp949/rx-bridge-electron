import { describe, expect, test } from "vitest";
import { createVirtualRelay } from "../src/main/virtual-relay.js";

describe("VirtualRelay", () => {
  test("a fault opens the relay and blocks power until reset", () => {
    const relay = createVirtualRelay();
    const faults: unknown[] = [];
    const subscription = relay.fault$.subscribe((fault) => faults.push(fault));
    try {
      expect(relay.status$.value).toEqual({ energized: false, faulted: false });
      expect(relay.turnOn()).toEqual({ energized: true, faulted: false });
      expect(relay.simulateFault()).toEqual({
        energized: false,
        faulted: true,
      });
      expect(faults).toEqual([
        { code: "RELAY_TRIPPED", message: "Relay overload simulated." },
      ]);
      expect(() => relay.turnOn()).toThrow(/fault/i);
      expect(relay.reset()).toEqual({ energized: false, faulted: false });
      expect(relay.turnOn()).toEqual({ energized: true, faulted: false });
      expect(relay.turnOff()).toEqual({ energized: false, faulted: false });
    } finally {
      subscription.unsubscribe();
      relay.dispose();
    }
  });
});
