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
import type {
  Authorize,
  BridgeContext,
  BridgeDiagnostic,
  StreamBridgeServer,
} from "../../src/main/index.js";
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

const transformRequest = (
  overrides: Partial<WireRpcRequest> = {},
): WireRpcRequest => request({ key: "rpc:boundary/transform", ...overrides });

function setupOutput(
  output: Schema<BridgeValue>,
  handler: (
    input: BridgeValue,
    context: BridgeContext,
  ) => Promise<BridgeValue> | BridgeValue = vi.fn(async () => ({
    id: "device-1",
  })),
  diagnostics: {
    record: ReturnType<typeof vi.fn<(event: BridgeDiagnostic) => void>>;
  } = { record: vi.fn<(event: BridgeDiagnostic) => void>() },
) {
  const transformDomain = defineDomain("boundary", {
    rpc: {
      transform: rpc({
        input: object,
        output,
        errors: ["DEVICE_GONE"] as const,
      }),
    },
  });
  const implementation = implementDomain(transformDomain, {
    rpc: { transform: handler },
  });
  const server: StreamBridgeServer = createBridgeServer(
    composeContracts({ payloadLimits: limits }, transformDomain),
    [implementation],
    { diagnostics },
  );
  server.attach(new FakeTarget());
  return { handler, server, diagnostics };
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

describe("RPC output boundary revalidation", () => {
  test("rejects an output schema that produces a function", async () => {
    const output: Schema<BridgeValue> = {
      parse: () => (() => undefined) as unknown as BridgeValue,
    };
    const { server } = setupOutput(output);
    const response = await server.dispatchRpc(sender(), transformRequest());
    expect(response).toMatchObject({
      type: "error",
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    expect(response).not.toHaveProperty("result");
  });

  test("rejects an output schema that produces a Date", async () => {
    const output: Schema<BridgeValue> = {
      parse: () => new Date() as unknown as BridgeValue,
    };
    const { server } = setupOutput(output);
    const response = await server.dispatchRpc(sender(), transformRequest());
    expect(response).toMatchObject({
      type: "error",
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    expect(response).not.toHaveProperty("result");
  });

  test("rejects an output schema that produces a Map", async () => {
    const output: Schema<BridgeValue> = {
      parse: () => new Map() as unknown as BridgeValue,
    };
    const { server } = setupOutput(output);
    const response = await server.dispatchRpc(sender(), transformRequest());
    expect(response).toMatchObject({
      type: "error",
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    expect(response).not.toHaveProperty("result");
  });

  test("rejects an output schema that produces a cyclic object", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const output: Schema<BridgeValue> = {
      parse: () => circular as unknown as BridgeValue,
    };
    const { server } = setupOutput(output);
    const response = await server.dispatchRpc(sender(), transformRequest());
    expect(response).toMatchObject({
      type: "error",
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    expect(response).not.toHaveProperty("result");
  });

  test("rejects an output schema that produces an accessor property without invoking it", async () => {
    const getter = vi.fn(() => "secret");
    const withAccessor: Record<string, unknown> = {};
    Object.defineProperty(withAccessor, "value", {
      enumerable: true,
      get: getter,
    });
    const output: Schema<BridgeValue> = {
      parse: () => withAccessor as unknown as BridgeValue,
    };
    const { server } = setupOutput(output);
    const response = await server.dispatchRpc(sender(), transformRequest());
    expect(response).toMatchObject({
      type: "error",
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    expect(response).not.toHaveProperty("result");
    expect(getter).not.toHaveBeenCalled();
  });

  test("rejects an output schema result beyond the configured depth", async () => {
    const output: Schema<BridgeValue> = {
      parse: () => ({ a: { b: { c: { d: 1 } } } }),
    };
    const { server } = setupOutput(output);
    const response = await server.dispatchRpc(sender(), transformRequest());
    expect(response).toMatchObject({
      type: "error",
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    expect(response).not.toHaveProperty("result");
  });

  test("rejects an output schema result beyond the configured entry count", async () => {
    const nineEntries = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`k${index}`, index]),
    );
    const output: Schema<BridgeValue> = {
      parse: () => nineEntries as unknown as BridgeValue,
    };
    const { server } = setupOutput(output);
    const response = await server.dispatchRpc(sender(), transformRequest());
    expect(response).toMatchObject({
      type: "error",
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    expect(response).not.toHaveProperty("result");
  });

  test("rejects an output schema result beyond the configured string byte count", async () => {
    const output: Schema<BridgeValue> = {
      parse: () => "x".repeat(33),
    };
    const { server } = setupOutput(output);
    const response = await server.dispatchRpc(sender(), transformRequest());
    expect(response).toMatchObject({
      type: "error",
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    expect(response).not.toHaveProperty("result");
  });

  test("does not leak a declared error code thrown by the output schema", async () => {
    const output: Schema<BridgeValue> = {
      parse: () => {
        throw Object.assign(new Error("device unavailable"), {
          code: "DEVICE_GONE",
        });
      },
    };
    const { server } = setupOutput(output);
    const response = await server.dispatchRpc(sender(), transformRequest());
    expect(response).toMatchObject({
      type: "error",
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    expect(response).not.toHaveProperty("result");
  });

  test("returns a response result unaffected by later mutation of the handler's object", async () => {
    const source: { id: string; extra?: string } = { id: "device-1" };
    const handler = vi.fn(async () => source);
    const { server } = setupOutput(object, handler);
    const response = await server.dispatchRpc(sender(), transformRequest());
    if (response.type !== "success") throw new Error("expected success");
    const result = response.result;
    source.extra = "mutated";
    expect(result).toEqual({ id: "device-1" });
    expect(result).not.toBe(source);
  });

  test("keeps a within-limits schema transformation in the success response", async () => {
    const normalizing: Schema<BridgeValue> = {
      parse(value) {
        const parsed = object.parse(value);
        return { id: parsed.id, normalized: true };
      },
    };
    const { server } = setupOutput(normalizing);
    const response = await server.dispatchRpc(sender(), transformRequest());
    expect(response).toMatchObject({ type: "success" });
    if (response.type !== "success") throw new Error("expected success");
    expect(response.result).toEqual({ id: "device-1", normalized: true });
  });

  test("rejects a declared domain error whose message exceeds the byte limit", async () => {
    const handler = vi.fn(async () => {
      throw Object.assign(new Error("x".repeat(33)), { code: "DEVICE_GONE" });
    });
    const { server } = setupOutput(object, handler);
    const response = await server.dispatchRpc(sender(), transformRequest());
    expect(response).toMatchObject({
      type: "error",
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    expect(response).not.toHaveProperty("result");
  });

  test("prefers CANCELLED when the request is aborted before the output schema throws", async () => {
    const box: { server?: StreamBridgeServer } = {};
    const output: Schema<BridgeValue> = {
      parse: () => {
        box.server?.cancel(sender(), {
          protocolVersion: 1,
          clientId: "document-1",
          requestId: "request-1",
        });
        throw new Error("boom");
      },
    };
    const { server } = setupOutput(output);
    box.server = server;
    const response = await server.dispatchRpc(sender(), transformRequest());
    expect(response).toMatchObject({
      type: "error",
      error: { code: "CANCELLED", message: "Request cancelled." },
    });
    expect(response).not.toHaveProperty("result");
  });

  test("records a single validation-failed diagnostic only for output failures", async () => {
    const diagnostics = { record: vi.fn<(event: BridgeDiagnostic) => void>() };
    const badOutput: Schema<BridgeValue> = {
      parse: () => (() => undefined) as unknown as BridgeValue,
    };
    const bad = setupOutput(badOutput, undefined, diagnostics);
    const good = setupOutput(object, undefined, diagnostics);
    await expect(
      bad.server.dispatchRpc(
        sender(),
        transformRequest({ input: { id: 42 } }),
      ),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
    await expect(
      good.server.dispatchRpc(sender(), transformRequest()),
    ).resolves.toMatchObject({ type: "success" });
    await expect(
      bad.server.dispatchRpc(sender(), transformRequest()),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "INTERNAL" },
    });
    const validationFailed = diagnostics.record.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "validation-failed");
    expect(validationFailed).toEqual([
      { type: "validation-failed", key: "rpc:boundary/transform" },
    ]);
  });
});
