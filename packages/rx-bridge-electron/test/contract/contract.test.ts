import { describe, expect, test } from "vitest";

import {
  composeContracts,
  defineDomain,
  event,
  publicManifest,
  rpc,
  state,
  type Schema,
} from "../../src/contract/index.js";

const stringSchema: Schema<string> = { parse: (value) => String(value) };
const connectInput: Schema<{ readonly deviceId: string }> = {
  parse: (value) => value as { readonly deviceId: string },
};

const hardware = defineDomain("hardware", {
  rpc: {
    connect: rpc({
      input: connectInput,
      output: stringSchema,
      errors: ["DEVICE_NOT_FOUND"] as const,
    }),
  },
  state: { connection: state(stringSchema) },
  event: { error: event(stringSchema) },
});

describe("contract composition", () => {
  test("preserves the configured v1 payload limits in Main metadata", () => {
    const payloadLimits = {
      maxDepth: 4,
      maxEntries: 16,
      maxStringBytes: 128,
    };

    const appContract = composeContracts({ payloadLimits }, hardware);

    expect(appContract.payloadLimits).toEqual(payloadLimits);
    expect(Object.isFrozen(appContract.payloadLimits)).toBe(true);
  });

  test("retains schemas for Main while exposing sorted canonical manifest IDs", () => {
    const appContract = composeContracts(hardware);

    expect(appContract.domains.hardware?.definitions.rpc.connect.input).toBe(
      connectInput,
    );
    expect(publicManifest(appContract)).toEqual({
      rpc: ["rpc:hardware/connect"],
      state: ["state:hardware/connection"],
      event: ["event:hardware/error"],
    });
  });

  test("orders each manifest category deterministically", () => {
    const appContract = composeContracts(
      defineDomain("zebra", {
        rpc: { ping: rpc({ input: stringSchema, output: stringSchema }) },
      }),
      defineDomain("alpha", {
        rpc: { pong: rpc({ input: stringSchema, output: stringSchema }) },
      }),
    );

    expect(publicManifest(appContract).rpc).toEqual([
      "rpc:alpha/pong",
      "rpc:zebra/ping",
    ]);
  });

  test.each([
    ["duplicate domain names", () => composeContracts(hardware, hardware)],
    [
      "duplicate paths",
      () =>
        defineDomain("hardware", {
          rpc: {
            duplicate: rpc({ input: stringSchema, output: stringSchema }),
          },
          state: { duplicate: state(stringSchema) },
        }),
    ],
    [
      "leaf namespace collision",
      () =>
        composeContracts(
          defineDomain("hardware", {
            rpc: { status: rpc({ input: stringSchema, output: stringSchema }) },
          }),
          defineDomain("hardware/status", {
            rpc: { read: rpc({ input: stringSchema, output: stringSchema }) },
          }),
        ),
    ],
    ["empty domain segment", () => defineDomain("", {})],
    ["dotted domain segment", () => defineDomain("hardware.device", {})],
    [
      "empty operation segment",
      () =>
        defineDomain("hardware", {
          rpc: { "": rpc({ input: stringSchema, output: stringSchema }) },
        }),
    ],
    [
      "dotted operation segment",
      () =>
        defineDomain("hardware", {
          rpc: {
            "device.connect": rpc({
              input: stringSchema,
              output: stringSchema,
            }),
          },
        }),
    ],
    ["reserved domain segment", () => defineDomain("then", {})],
    [
      "reserved operation segment",
      () =>
        defineDomain("hardware", {
          rpc: {
            constructor: rpc({ input: stringSchema, output: stringSchema }),
          },
        }),
    ],
    ["reserved __proto__ segment", () => defineDomain("__proto__", {})],
    ["reserved prototype segment", () => defineDomain("prototype", {})],
    ["reserved constructor segment", () => defineDomain("constructor", {})],
  ])("rejects %s", (_label, create) => {
    expect(create).toThrow(/duplicate|collision|empty|dot|reserved/i);
  });
});
