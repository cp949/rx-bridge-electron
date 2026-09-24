import { describe, expect, test } from "vitest";

import {
  formatOpaqueId,
  parseOpaqueIdSequence,
} from "../../src/protocol/opaque-id.js";
import { createOpaqueId } from "../../src/renderer/index.js";

describe("parseOpaqueIdSequence", () => {
  test("round-trips createOpaqueId output with an increasing sequence", () => {
    const first = parseOpaqueIdSequence(createOpaqueId("subscription"));
    const second = parseOpaqueIdSequence(createOpaqueId("subscription"));
    expect(first).toBeTypeOf("number");
    expect(second).toBeTypeOf("number");
    expect(second).toBeGreaterThan(first as number);
  });

  test.each([
    ["too few segments", "a:1"],
    ["too many segments", "a:b:c:1"],
    ["empty nonce", ":b:1"],
    ["empty scope", "a::1"],
    ["empty sequence", "a:b:"],
    ["leading zero", "a:b:01"],
    ["bare zero", "a:b:0"],
    ["uppercase digit", "a:b:A"],
    ["negative sequence", "a:b:-1"],
    ["safe-integer overflow", "a:b:2gosa7pa2gw"],
    ["empty string", ""],
  ])("rejects %s", (_label, id) => {
    expect(parseOpaqueIdSequence(id)).toBeUndefined();
  });

  test("accepts a well-formed ID and parses its base36 sequence", () => {
    expect(parseOpaqueIdSequence("nonce:subscription:1")).toBe(1);
    expect(parseOpaqueIdSequence("nonce:subscription:a")).toBe(10);
  });
});

describe("formatOpaqueId", () => {
  test.each([1, 36, Number.MAX_SAFE_INTEGER])(
    "round-trips through parseOpaqueIdSequence for sequence=%d",
    (sequence) => {
      const id = formatOpaqueId("nonce", "subscription", sequence);
      expect(parseOpaqueIdSequence(id)).toBe(sequence);
    },
  );
});
