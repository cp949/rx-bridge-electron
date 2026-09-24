import { describe, expect, test, vi } from "vitest";

import type { BridgeImpl, Schema } from "../../src/contract/index.js";
import {
  createBridgeServer,
  type Authorize,
  type BridgeContext,
  type BridgeDiagnostic,
  type StreamBridgeServer,
  type WireRpcRequest,
} from "../../src/main/index.js";
import type { BridgeValue } from "../../src/protocol/index.js";
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

type HardwareBridge = {
  hardware: {
    rpc: {
      connect(input: { readonly id: string }): string;
    };
  };
};

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
  const impl: BridgeImpl<HardwareBridge> = {
    hardware: { rpc: { connect: handler } },
  };
  const server = createBridgeServer(impl, {
    payloadLimits: limits,
    schemas: {
      hardware: { rpc: { connect: { input: object, output: string } } },
    },
    errors: { hardware: { rpc: { connect: ["DEVICE_GONE"] } } },
    ...(authorize === undefined ? {} : { authorize }),
  });
  server.attach(new FakeTarget());
  return { handler, server };
}

const transformRequest = (
  overrides: Partial<WireRpcRequest> = {},
): WireRpcRequest => request({ key: "rpc:boundary/transform", ...overrides });

type BoundaryBridge = {
  boundary: {
    rpc: {
      transform(input: { readonly id: string }): BridgeValue;
    };
  };
};

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
  const impl: BridgeImpl<BoundaryBridge> = {
    boundary: { rpc: { transform: handler } },
  };
  const server: StreamBridgeServer = createBridgeServer(impl, {
    payloadLimits: limits,
    schemas: { boundary: { rpc: { transform: { input: object, output } } } },
    errors: { boundary: { rpc: { transform: ["DEVICE_GONE"] } } },
    diagnostics,
  });
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

  test("does not call authorize for an unregistered operation", async () => {
    const authorize = vi.fn(() => true);
    const { handler, server } = setup(vi.fn(), authorize);
    await expect(
      server.dispatchRpc(sender(), request({ key: "rpc:hardware/missing" })),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "NOT_FOUND", message: "Unknown bridge operation." },
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(server.getDiagnosticsSnapshot().rpcInFlight).toBe(0);
  });

  test("authorizes after operation lookup and before schema parsing or handler invocation", async () => {
    // input은 server의 envelope parse(관대한 한도)는 통과하지만 이 파일의
    // 좁은 contract 한도(maxDepth: 3)에서는 걸리는 깊이다. authorize가 먼저
    // FORBIDDEN을 내면 스키마 단계(payload 한도 포함)에 닿지 않는다는 걸
    // 증명한다 — 순서가 바뀌면 이 값이 INVALID_ARGUMENT를 냈을 것이다(F1).
    const authorize = vi.fn(() => false);
    const { handler, server } = setup(vi.fn(), authorize);
    await expect(
      server.dispatchRpc(
        sender(),
        request({
          input: { id: "x", a: { b: { c: { d: true } } } } as BridgeValue,
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

describe("Duplicate requestId handling", () => {
  function setupDuplicate() {
    const diagnostics = { record: vi.fn<(event: BridgeDiagnostic) => void>() };
    const pending: Array<{
      resolve: (value: string) => void;
      signal: AbortSignal;
    }> = [];
    const handler = vi.fn(
      (_input: unknown, context: BridgeContext) =>
        new Promise<string>((resolve) => {
          pending.push({ resolve, signal: context.signal });
        }),
    );
    const impl: BridgeImpl<HardwareBridge> = {
      hardware: { rpc: { connect: handler } },
    };
    const server: StreamBridgeServer = createBridgeServer(impl, {
      payloadLimits: limits,
      schemas: {
        hardware: { rpc: { connect: { input: object, output: string } } },
      },
      errors: { hardware: { rpc: { connect: ["DEVICE_GONE"] } } },
      diagnostics,
    });
    server.attach(new FakeTarget());
    return { server, diagnostics, pending };
  }

  const cancelledEvents = (diagnostics: {
    record: ReturnType<typeof vi.fn<(event: BridgeDiagnostic) => void>>;
  }) =>
    diagnostics.record.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "rpc-cancelled");

  test("a second request with the same session and requestId cancels the first and proceeds normally", async () => {
    const { server, diagnostics, pending } = setupDuplicate();
    const first = server.dispatchRpc(sender(), request());
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(server.getDiagnosticsSnapshot().rpcInFlight).toBe(1);

    const second = server.dispatchRpc(sender(), request());
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0]?.signal.aborted).toBe(true);
    expect(pending[1]?.signal.aborted).toBe(false);
    expect(cancelledEvents(diagnostics)).toEqual([
      { type: "rpc-cancelled", key: "rpc:hardware/connect" },
    ]);
    expect(server.getDiagnosticsSnapshot().rpcInFlight).toBe(2);

    pending[1]?.resolve("second-connected");
    await expect(second).resolves.toMatchObject({
      type: "success",
      result: "second-connected",
    });
    expect(server.getDiagnosticsSnapshot().rpcInFlight).toBe(1);

    pending[0]?.resolve("first-connected");
    await expect(first).resolves.toMatchObject({
      type: "error",
      error: { code: "CANCELLED", message: "Request cancelled." },
    });
    expect(server.getDiagnosticsSnapshot().rpcInFlight).toBe(0);
  });

  test("cancel with a reused requestId only cancels the currently active request", async () => {
    const { server, diagnostics, pending } = setupDuplicate();
    const first = server.dispatchRpc(sender(), request());
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    const second = server.dispatchRpc(sender(), request());
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(cancelledEvents(diagnostics)).toHaveLength(1);

    server.cancel(sender(), {
      protocolVersion: 1,
      clientId: "document-1",
      requestId: "request-1",
    });
    expect(cancelledEvents(diagnostics)).toHaveLength(2);

    pending[1]?.resolve("second-connected");
    await expect(second).resolves.toMatchObject({
      type: "error",
      error: { code: "CANCELLED", message: "Request cancelled." },
    });

    pending[0]?.resolve("first-connected");
    await expect(first).resolves.toMatchObject({
      type: "error",
      error: { code: "CANCELLED", message: "Request cancelled." },
    });
    expect(server.getDiagnosticsSnapshot().rpcInFlight).toBe(0);
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
      bad.server.dispatchRpc(sender(), transformRequest({ input: { id: 42 } })),
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

  test("returns declared error details unaffected by later mutation of the thrown object", async () => {
    const details: { retry: boolean; extra?: string } = { retry: true };
    const handler = vi.fn(async () => {
      throw Object.assign(new Error("device unavailable"), {
        code: "DEVICE_GONE",
        details,
      });
    });
    const { server } = setupOutput(object, handler);
    const response = await server.dispatchRpc(sender(), transformRequest());
    if (response.type !== "error") throw new Error("expected error");
    const returned = response.error.details;
    details.extra = "mutated";
    expect(returned).toEqual({ retry: true });
    expect(returned).not.toBe(details);
  });

  test("reads a declared error code only once", async () => {
    const codes = ["DEVICE_GONE", "DEVICE_GONE", "UNDECLARED"];
    const thrown = { message: "device unavailable" };
    Object.defineProperty(thrown, "code", {
      enumerable: true,
      get: () => codes.shift(),
    });
    const handler = vi.fn(async () => {
      throw thrown;
    });
    const { server } = setupOutput(object, handler);
    const response = await server.dispatchRpc(sender(), transformRequest());
    expect(response).toMatchObject({
      type: "error",
      error: { code: "DEVICE_GONE", message: "device unavailable" },
    });
  });

  test("sanitizes a thrown object whose error fields throw on access", async () => {
    const thrown = {};
    Object.defineProperty(thrown, "code", {
      enumerable: true,
      get: () => {
        throw new Error("/private/token: secret");
      },
    });
    const handler = vi.fn(async () => {
      throw thrown;
    });
    const { server } = setupOutput(object, handler);
    await expect(
      server.dispatchRpc(sender(), transformRequest()),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
  });
});
