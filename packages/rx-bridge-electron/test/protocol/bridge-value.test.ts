import { describe, expect, test } from "vitest";

import {
  parseBridgeValue,
  type PayloadLimits,
} from "../../src/protocol/bridge-value.js";

const limits: PayloadLimits = {
  maxDepth: 3,
  maxEntries: 8,
  maxStringBytes: 8,
};

function expectInvalidArgument(
  value: unknown,
  configuredLimits: PayloadLimits = limits,
): void {
  expect(() => parseBridgeValue(value, configuredLimits)).toThrowError(
    expect.objectContaining({ code: "INVALID_ARGUMENT" }),
  );
}

describe("parseBridgeValue", () => {
  test("preserves accepted nested plain data without mutating it", () => {
    const value = { nested: [1, undefined, null, "ok"] };

    expect(parseBridgeValue(value, limits)).toEqual({
      nested: [1, undefined, null, "ok"],
    });
    expect(value).toEqual({ nested: [1, undefined, null, "ok"] });
  });

  test.each([
    ["function", () => undefined],
    ["symbol", Symbol("value")],
    ["typed array", new Uint8Array([1])],
    ["transferable buffer", new ArrayBuffer(1)],
    ["date", new Date()],
    ["custom prototype", Object.create({ inherited: true })],
  ])("rejects a %s value", (_label, value) => {
    expectInvalidArgument(value);
  });

  test("rejects an array subclass with a custom prototype", () => {
    class CustomArray extends Array<number> {}

    expectInvalidArgument(new CustomArray(1, 2));
  });

  test("rejects an array with a mutated prototype", () => {
    const value = [1, 2];
    Object.setPrototypeOf(value, { mutated: true });

    expectInvalidArgument(value);
  });

  test("enforces the UTF-8 byte limit for object keys", () => {
    expect(parseBridgeValue({ ["x".repeat(8)]: null }, limits)).toEqual({
      ["x".repeat(8)]: null,
    });
    expectInvalidArgument({ ["x".repeat(9)]: null });
  });

  test("accepts shared plain-data references that are not cycles", () => {
    const shared = { value: 1 };

    expect(parseBridgeValue({ a: shared, b: shared }, limits)).toEqual({
      a: { value: 1 },
      b: { value: 1 },
    });
  });

  test("rejects a cycle", () => {
    const value: { self?: unknown } = {};
    value.self = value;

    expectInvalidArgument(value);
  });

  test("rejects a value beyond the configured depth", () => {
    expectInvalidArgument([[[["deep"]]]]);
  });

  test("rejects a value beyond the configured entry count", () => {
    expectInvalidArgument(
      { one: 1, two: 2, three: 3 },
      { ...limits, maxEntries: 2 },
    );
  });

  test("rejects a string beyond the configured UTF-8 byte count", () => {
    expectInvalidArgument("한글", { ...limits, maxStringBytes: 5 });
  });

  describe("maxTotalBytes", () => {
    test("does not enforce a total when maxTotalBytes is omitted", () => {
      expect(parseBridgeValue(2n ** 80000n, limits)).toBe(2n ** 80000n);
    });

    test("accepts an array at the exact byte budget and rejects one byte under it", () => {
      // array node(8) + keys "0","1"(1+1) + "ab" node(8)+bytes(2) + "cd" node(8)+bytes(2) = 30
      const value = ["ab", "cd"];

      expect(parseBridgeValue(value, { ...limits, maxTotalBytes: 30 })).toEqual(
        value,
      );
      expectInvalidArgument(value, { ...limits, maxTotalBytes: 29 });
    });

    test("counts object key bytes toward the total", () => {
      // object node(8) + keys "kkkkk","jjjjj"(5+5) + two number nodes(8+8) = 34
      const value = { kkkkk: 1, jjjjj: 2 };

      expect(parseBridgeValue(value, { ...limits, maxTotalBytes: 34 })).toEqual(
        value,
      );
      expectInvalidArgument(value, { ...limits, maxTotalBytes: 33 });
    });

    test("computes string bytes using UTF-8, not UTF-16 code units", () => {
      // node(8) + UTF-8 byte length of "한글"(6) = 14, not the 2 UTF-16 code units
      expect(parseBridgeValue("한글", { ...limits, maxTotalBytes: 14 })).toBe(
        "한글",
      );
      expectInvalidArgument("한글", { ...limits, maxTotalBytes: 13 });
    });

    test("counts large bigints toward the total", () => {
      expectInvalidArgument(2n ** 80000n, { ...limits, maxTotalBytes: 1000 });
    });

    test("rejects a negative maxTotalBytes", () => {
      expectInvalidArgument(1, { ...limits, maxTotalBytes: -1 });
    });
  });
});
