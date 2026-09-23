import { describe, expect, test, vi } from "vitest";

import {
  composeContracts,
  defineDomain,
  rpc,
  type Schema,
} from "../../src/contract/index.js";
import {
  createBridgeServer,
  implementDomain,
  type WireRpcRequest,
} from "../../src/main/index.js";
import type { BridgeValue } from "../../src/protocol/index.js";
import type { Authorize } from "../../src/main/index.js";
import { FakeTarget, sender } from "./fake-ipc.js";

const limits = { maxDepth: 3, maxEntries: 8, maxStringBytes: 32 };
const string: Schema<string> = {
  parse(value) {
    if (typeof value !== "string") throw new Error("string required");
    return value;
  },
};
const object: Schema<{ readonly id: string }> = {
  parse(value) {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof (value as { id?: unknown }).id !== "string"
    )
      throw new Error("id required");
    return value as { readonly id: string };
  },
};
const domain = defineDomain("hardware", {
  rpc: {
    connect: rpc({
      input: object,
      output: string,
      errors: ["DEVICE_GONE"] as const,
    }),
  },
});
const request = (overrides: Partial<WireRpcRequest> = {}): WireRpcRequest => ({
  protocolVersion: 1,
  clientId: "document-1",
  requestId: "request-1",
  key: "rpc:hardware/connect",
  input: { id: "device-1" },
  ...overrides,
});

function setup(
  handler = vi.fn(async () => "connected"),
  authorize?: Authorize,
) {
  const implementation = implementDomain(domain, { rpc: { connect: handler } });
  const server = createBridgeServer(
    composeContracts({ payloadLimits: limits }, domain),
    [implementation],
    authorize === undefined ? {} : { authorize },
  );
  server.attach(new FakeTarget());
  return { handler, server };
}

describe("Main RPC dispatch", () => {
  test("calls an attached current main frame after authorization", async () => {
    const { handler, server } = setup();
    await expect(
      server.dispatchRpc(sender(), request()),
    ).resolves.toMatchObject({ type: "success", result: "connected" });
    expect(handler).toHaveBeenCalledWith(
      { id: "device-1" },
      expect.objectContaining({ requestId: "request-1", windowRole: "main" }),
    );
  });

  test.each([
    [
      "unknown webContents",
      sender({ webContentsId: 2 }),
      request(),
      "FORBIDDEN",
    ],
    ["child frame", sender({ isMainFrame: false }), request(), "FORBIDDEN"],
    [
      "wrong origin",
      sender({ origin: "https://evil.example" }),
      request(),
      "FORBIDDEN",
    ],
    [
      "wrong protocol",
      sender(),
      request({ protocolVersion: 2 as 1 }),
      "VERSION_MISMATCH",
    ],
    [
      "unknown operation",
      sender(),
      request({ key: "rpc:hardware/missing" }),
      "NOT_FOUND",
    ],
  ])(
    "rejects %s before invoking handlers",
    async (_name, identity, envelope, code) => {
      const { handler, server } = setup();
      await expect(
        server.dispatchRpc(identity, envelope),
      ).resolves.toMatchObject({ type: "error", error: { code } });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  test("enforces role authorization before schema parsing or handler lookup", async () => {
    const authorize = vi.fn(() => false);
    const { handler, server } = setup(vi.fn(), authorize);
    await expect(
      server.dispatchRpc(
        sender(),
        request({
          input: { id: "x", extra: Symbol("unsafe") } as unknown as BridgeValue,
        }),
      ),
    ).resolves.toMatchObject({ type: "error", error: { code: "FORBIDDEN" } });
    expect(authorize).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });

  test("rejects malformed payloads before the handler and validates results", async () => {
    const { handler, server } = setup(
      vi.fn(async () => 42 as unknown as string),
    );
    await expect(
      server.dispatchRpc(
        sender(),
        request({
          input: { id: "x", nested: { too: { deep: { now: true } } } },
        }),
      ),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(handler).not.toHaveBeenCalled();
    await expect(
      server.dispatchRpc(sender(), request({ requestId: "request-2" })),
    ).resolves.toMatchObject({ type: "error", error: { code: "INTERNAL" } });
  });

  test("reports a domain input validation failure as INVALID_ARGUMENT", async () => {
    const { handler, server } = setup();
    await expect(
      server.dispatchRpc(sender(), request({ input: { id: 42 } })),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "INVALID_ARGUMENT", message: "Invalid bridge argument." },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test("preserves only declared safe domain errors and sanitizes unexpected exceptions", async () => {
    const declared = Object.assign(new Error("device unavailable"), {
      code: "DEVICE_GONE",
      details: { retry: true },
    });
    const { server } = setup(
      vi.fn(async () => {
        throw declared;
      }),
    );
    await expect(
      server.dispatchRpc(sender(), request()),
    ).resolves.toMatchObject({
      type: "error",
      error: {
        code: "DEVICE_GONE",
        message: "device unavailable",
        details: { retry: true },
      },
    });
    const unexpected = setup(
      vi.fn(async () => {
        throw new Error("/private/token: secret");
      }),
    );
    await expect(
      unexpected.server.dispatchRpc(sender(), request()),
    ).resolves.toEqual(
      expect.objectContaining({
        type: "error",
        error: { code: "INTERNAL", message: "Internal bridge error." },
      }),
    );
  });
});
