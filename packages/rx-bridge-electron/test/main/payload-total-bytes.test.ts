import { describe, expect, test, vi } from "vitest";

import type { BridgeImpl } from "../../src/contract/index.js";
import {
  createBridgeServer,
  type BridgeContext,
  type BridgeDiagnostic,
  type WireRpcRequest,
} from "../../src/main/index.js";
import type { PayloadLimits } from "../../src/protocol/index.js";
import { FakeTarget, sender } from "./fake-ipc.js";

type AppBridge = {
  boundary: {
    rpc: {
      transform(input: { readonly id: string }): { readonly id: string };
    };
  };
};

const request = (overrides: Partial<WireRpcRequest> = {}): WireRpcRequest => ({
  protocolVersion: 1,
  clientId: "document-1",
  requestId: "request-1",
  key: "rpc:boundary/transform",
  input: { id: "device-1" },
  ...overrides,
});

function setup(
  handler: (
    input: { readonly id: string },
    context: BridgeContext,
  ) => Promise<{ readonly id: string }> = async () => ({ id: "device-1" }),
  payloadLimits?: Partial<PayloadLimits>,
  diagnostics: {
    record: ReturnType<typeof vi.fn<(event: BridgeDiagnostic) => void>>;
  } = { record: vi.fn<(event: BridgeDiagnostic) => void>() },
) {
  const impl: BridgeImpl<AppBridge> = {
    boundary: { rpc: { transform: handler } },
  };
  const server = createBridgeServer(impl, {
    errors: { boundary: { rpc: { transform: ["DEVICE_GONE"] } } },
    ...(payloadLimits === undefined ? {} : { payloadLimits }),
    diagnostics,
  });
  server.attach(new FakeTarget());
  return { server, diagnostics };
}

describe("RPC maxTotalBytes enforcement", () => {
  test("rejects an oversized input without calling the handler", async () => {
    const handler = vi.fn(async () => ({ id: "device-1" }));
    const { server } = setup(handler, {
      maxDepth: 8,
      maxEntries: 100,
      maxStringBytes: 2048,
      maxTotalBytes: 1024,
    });
    const response = await server.dispatchRpc(
      sender(),
      request({ input: { id: "x".repeat(1200) } }),
    );
    expect(response).toMatchObject({
      type: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test("rejects an oversized output as INTERNAL with a validation-failed diagnostic", async () => {
    const diagnostics = { record: vi.fn<(event: BridgeDiagnostic) => void>() };
    const { server } = setup(
      async () => ({ id: "x".repeat(1200) }),
      {
        maxDepth: 8,
        maxEntries: 100,
        maxStringBytes: 2048,
        maxTotalBytes: 1024,
      },
      diagnostics,
    );
    const response = await server.dispatchRpc(sender(), request());
    expect(response).toMatchObject({
      type: "error",
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    const validationFailed = diagnostics.record.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "validation-failed");
    expect(validationFailed).toEqual([
      { type: "validation-failed", key: "rpc:boundary/transform" },
    ]);
  });

  test("rejects an oversized declared error details as INTERNAL", async () => {
    const handler = vi.fn(async () => {
      throw Object.assign(new Error("device unavailable"), {
        code: "DEVICE_GONE",
        details: { big: "x".repeat(1200) },
      });
    });
    const { server } = setup(handler, {
      maxDepth: 8,
      maxEntries: 100,
      maxStringBytes: 2048,
      maxTotalBytes: 1024,
    });
    const response = await server.dispatchRpc(sender(), request());
    expect(response).toMatchObject({
      type: "error",
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    expect(response).not.toHaveProperty("result");
  });

  test("applies the default 16 MiB total when the contract does not specify payloadLimits", async () => {
    const handler = vi.fn(async () => ({ id: "device-1" }));
    const { server } = setup(handler, undefined);
    const oversized = Array.from({ length: 17 }, () => "a".repeat(1_000_000));
    const response = await server.dispatchRpc(
      sender(),
      request({ input: { id: "device-1", oversized } as never }),
    );
    expect(response).toMatchObject({
      type: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
