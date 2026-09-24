import type { Observable } from "rxjs";
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import {
  RemoteError,
  RpcClient,
  createRendererApi,
  createOpaqueId,
  type CallOptions,
  type RendererApi,
} from "../../src/renderer/index.js";
import { FakeTransport, deferred } from "./fake-transport.js";

interface AppBridge {
  readonly hardware: {
    readonly rpc: {
      connect(input: { readonly deviceId: string }): {
        readonly connected: boolean;
      };
    };
  };
}

interface InferredBridgeShape {
  readonly hardware: {
    readonly rpc: {
      connect(input: { readonly deviceId: string }): boolean;
      disconnect(): boolean;
    };
    readonly event: {
      readonly fault: string;
    };
  };
}

function success(
  requestId: string,
  result: { readonly connected: boolean } = { connected: true },
) {
  return {
    protocolVersion: 1 as const,
    clientId: "client-1",
    type: "success" as const,
    requestId,
    result,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("renderer handshake and API proxy", () => {
  test("adds CallOptions only to inferred RPC methods", () => {
    type Api = RendererApi<InferredBridgeShape>;

    expectTypeOf<Api["hardware"]["rpc"]["connect"]>().toEqualTypeOf<
      (
        input: { readonly deviceId: string },
        options?: CallOptions,
      ) => Promise<boolean>
    >();
    expectTypeOf<Api["hardware"]["rpc"]["disconnect"]>().toEqualTypeOf<
      (input?: undefined, options?: CallOptions) => Promise<boolean>
    >();
    expectTypeOf<Api["hardware"]["event"]["fault"]>().toEqualTypeOf<
      Observable<string>
    >();
  });

  test("waits for the handshake before exposing manifest paths", async () => {
    const transport = new FakeTransport();
    const handshake = deferred<unknown>();
    transport.handshake = handshake.promise;

    let settled = false;
    const apiPromise = createRendererApi<AppBridge>(transport).then((api) => {
      settled = true;
      return api;
    });

    await Promise.resolve();
    expect(transport.connectCalls).toBe(1);
    expect(settled).toBe(false);

    handshake.resolve({
      protocolVersion: 1,
      clientId: "client-1",
      manifest: { rpc: ["rpc:hardware/connect"], state: [], event: [] },
    });
    await expect(apiPromise).resolves.toHaveProperty("hardware.rpc.connect");
  });

  // 이름 규칙 자체는 `test/protocol/operation-key.test.ts`가 검증한다. 이름
  // 관련 2행(non-canonical entry, leaf namespace collision)은 Renderer가 코어를
  // 호출해 `INTERNAL`로 거부하는지만 본다.
  test.each([
    ["missing manifest", { protocolVersion: 1, clientId: "client-1" }],
    [
      "unsupported protocol",
      {
        protocolVersion: 2,
        clientId: "client-1",
        manifest: { rpc: [], state: [], event: [] },
      },
    ],
    [
      "unknown manifest field",
      {
        protocolVersion: 1,
        clientId: "client-1",
        manifest: { rpc: [], state: [], event: [], command: [] },
      },
    ],
    [
      "non-canonical entry",
      {
        protocolVersion: 1,
        clientId: "client-1",
        manifest: { rpc: ["hardware.connect"], state: [], event: [] },
      },
    ],
    [
      "leaf namespace collision",
      {
        protocolVersion: 1,
        clientId: "client-1",
        manifest: {
          rpc: ["rpc:hardware/status", "rpc:hardware/status/read"],
          state: [],
          event: [],
        },
      },
    ],
  ])(
    "rejects a malformed or unsupported handshake: %s",
    async (_label, value) => {
      const transport = new FakeTransport();
      transport.handshake = Promise.resolve(value);

      await expect(
        createRendererApi<AppBridge>(transport),
      ).rejects.toMatchObject({
        code: "INTERNAL",
      });
    },
  );

  test.each([
    [
      "malformed",
      { protocolVersion: 1, clientId: "client-1" },
      "Malformed bridge handshake.",
    ],
    [
      "unsupported version",
      {
        protocolVersion: 2,
        clientId: "client-1",
        manifest: { rpc: [], state: [], event: [] },
      },
      "Unsupported bridge handshake.",
    ],
  ])(
    "names the handshake failure in the INTERNAL message: %s",
    async (_label, value, message) => {
      const transport = new FakeTransport();
      transport.handshake = Promise.resolve(value);

      await expect(
        createRendererApi<AppBridge>(transport),
      ).rejects.toMatchObject({ code: "INTERNAL", message });
    },
  );

  test("maps a handshake transport failure to a safe INTERNAL error", async () => {
    const transport = new FakeTransport();
    transport.handshake = Promise.reject(
      new Error("secret absolute path from preload"),
    );

    await expect(createRendererApi<AppBridge>(transport)).rejects.toMatchObject(
      {
        code: "INTERNAL",
        message: "Bridge handshake failed.",
      },
    );
  });

  test("exposes only manifest entries and dispatches their canonical RPC keys", async () => {
    const transport = new FakeTransport();
    const api = await createRendererApi<AppBridge>(transport);

    expect("connect" in api.hardware.rpc).toBe(true);
    expect("missing" in api.hardware.rpc).toBe(false);
    expect(
      (api.hardware.rpc as unknown as { readonly then?: unknown }).then,
    ).toBeUndefined();

    const resultPromise = api.hardware.rpc.connect({ deviceId: "demo" });
    const invocation = transport.invocations[0];
    expect(invocation).toMatchObject({
      key: "rpc:hardware/connect",
      input: { deviceId: "demo" },
    });
    transport.resolveInvocation(0, success(invocation!.requestId));
    await expect(resultPromise).resolves.toEqual({ connected: true });
  });

  test("groups manifest entries by category under each domain path", async () => {
    const transport = new FakeTransport();
    transport.handshake = Promise.resolve({
      protocolVersion: 1,
      clientId: "client-1",
      manifest: {
        rpc: ["rpc:hardware/connect", "rpc:hardware/serial/open"],
        state: ["state:hardware/status"],
        event: [],
      },
    });
    const api = await createRendererApi<{
      readonly hardware: {
        readonly rpc: { connect(): string };
        readonly state: { readonly status: string };
        readonly serial: { readonly rpc: { open(): string } };
      };
    }>(transport);

    expect(Object.keys(api.hardware).sort()).toEqual([
      "rpc",
      "serial",
      "state",
    ]);
    expect(Object.keys(api.hardware.serial)).toEqual(["rpc"]);
    expect(
      (api.hardware as unknown as { readonly event?: unknown }).event,
    ).toBeUndefined();
    expect(
      (api.hardware as unknown as { readonly connect?: unknown }).connect,
    ).toBeUndefined();
    expect(typeof api.hardware.state.status.subscribe).toBe("function");

    void api.hardware.serial.rpc.open();
    expect(transport.invocations[0]).toMatchObject({
      key: "rpc:hardware/serial/open",
    });
  });

  test("exposes root dispose without listing it and keeps nested dispose operations", async () => {
    const transport = new FakeTransport();
    transport.handshake = Promise.resolve({
      protocolVersion: 1,
      clientId: "client-1",
      manifest: {
        rpc: ["rpc:hardware/connect", "rpc:hardware/dispose"],
        state: [],
        event: [],
      },
    });
    const api = await createRendererApi<{
      readonly hardware: { readonly rpc: { dispose(): string } };
    }>(transport);

    expect("dispose" in api).toBe(true);
    expect(Object.keys(api)).toEqual(["hardware"]);
    expect(api.hardware.rpc.dispose).not.toBe(api.dispose);

    const resultPromise = api.hardware.rpc.dispose();
    const invocation = transport.invocations[0];
    expect(invocation).toMatchObject({ key: "rpc:hardware/dispose" });
    transport.resolveInvocation(0, {
      ...success(invocation!.requestId),
      result: "disposed",
    });
    await expect(resultPromise).resolves.toBe("disposed");

    expect(() => {
      api.dispose();
      api.dispose();
    }).not.toThrow();

    const invocationCountAfterDispose = transport.invocations.length;
    await expect(api.hardware.rpc.dispose()).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(transport.invocations).toHaveLength(invocationCountAfterDispose);
  });

  test("keeps CallOptions separate from the one serializable RPC input", async () => {
    const transport = new FakeTransport();
    const api = await createRendererApi<AppBridge>(transport);
    const controller = new AbortController();

    const resultPromise = api.hardware.rpc.connect(
      { deviceId: "demo" },
      { signal: controller.signal, timeoutMs: Number.POSITIVE_INFINITY },
    );
    expect(transport.invocations[0]?.input).toEqual({ deviceId: "demo" });
    transport.resolveInvocation(
      0,
      success(transport.invocations[0]!.requestId),
    );
    await resultPromise;
  });
});

describe("renderer RPC races", () => {
  test("settles once when response and abort fire in the same turn in either order", async () => {
    for (const first of ["response", "abort"] as const) {
      const transport = new FakeTransport();
      const client = new RpcClient(transport, {
        protocolVersion: 1,
        clientId: "client-1",
      });
      const controller = new AbortController();
      const settlements: string[] = [];
      const resultPromise = client.call("rpc:hardware/connect", undefined, {
        signal: controller.signal,
        timeoutMs: Number.POSITIVE_INFINITY,
      });
      const requestId = transport.invocations[0]!.requestId;
      const observed = resultPromise.then(
        () => settlements.push("response"),
        (error: RemoteError) => settlements.push(error.code),
      );

      if (first === "response") {
        transport.resolveInvocation(0, success(requestId));
        await Promise.resolve();
        controller.abort();
      } else {
        controller.abort();
        transport.invocationResults[0]!.reject(
          new Error("losing transport response"),
        );
      }

      await observed;
      await Promise.resolve();

      expect(settlements).toEqual([
        first === "response" ? "response" : "CANCELLED",
      ]);
      expect(transport.cancellations).toEqual(
        first === "response" ? [] : [requestId],
      );
      expect(transport.cancellations.length).toBeLessThanOrEqual(1);
    }
  });

  test("settles once when response and timeout fire in the same turn in either order", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    for (const first of ["response", "timeout"] as const) {
      const transport = new FakeTransport();
      const client = new RpcClient(transport, {
        protocolVersion: 1,
        clientId: "client-1",
      });
      const settlements: string[] = [];

      const resultPromise = client.call("rpc:hardware/connect", undefined, {
        timeoutMs: 25,
      });
      const requestId = transport.invocations[0]!.requestId;
      const timeoutCallback = setTimeoutSpy.mock.calls.at(-1)?.[0];
      if (typeof timeoutCallback !== "function") {
        throw new Error("RPC timeout callback was not registered.");
      }
      const observed = resultPromise.then(
        () => settlements.push("response"),
        (error: RemoteError) => settlements.push(error.code),
      );

      if (first === "response") {
        transport.resolveInvocation(0, success(requestId));
        await Promise.resolve();
        timeoutCallback();
      } else {
        timeoutCallback();
        transport.invocationResults[0]!.reject(
          new Error("losing transport response"),
        );
      }

      await observed;
      await Promise.resolve();

      expect(settlements).toEqual([
        first === "response" ? "response" : "DEADLINE_EXCEEDED",
      ]);
      expect(transport.cancellations).toEqual(
        first === "response" ? [] : [requestId],
      );
      expect(transport.cancellations.length).toBeLessThanOrEqual(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  test("rejects an already-aborted call without sending or cancelling", async () => {
    const transport = new FakeTransport();
    const client = new RpcClient(transport, {
      protocolVersion: 1,
      clientId: "client-1",
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.call(
        "rpc:hardware/connect",
        { deviceId: "demo" },
        {
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(transport.invocations).toHaveLength(0);
    expect(transport.cancellations).toHaveLength(0);
  });

  test("keeps the response when it wins the response-abort race", async () => {
    const transport = new FakeTransport();
    const client = new RpcClient(transport, {
      protocolVersion: 1,
      clientId: "client-1",
    });
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    const resultPromise = client.call("rpc:hardware/connect", undefined, {
      signal: controller.signal,
    });
    transport.resolveInvocation(
      0,
      success(transport.invocations[0]!.requestId),
    );
    await expect(resultPromise).resolves.toEqual({ connected: true });
    controller.abort();

    expect(transport.cancellations).toHaveLength(0);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  test("cancels exactly once when abort wins and discards the late response", async () => {
    const transport = new FakeTransport();
    const client = new RpcClient(transport, {
      protocolVersion: 1,
      clientId: "client-1",
    });
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const resultPromise = client.call("rpc:hardware/connect", undefined, {
      signal: controller.signal,
    });
    const requestId = transport.invocations[0]!.requestId;
    controller.abort();
    controller.abort();

    await expect(resultPromise).rejects.toMatchObject({ code: "CANCELLED" });
    expect(transport.cancellations).toEqual([requestId]);
    expect(removeSpy).toHaveBeenCalledTimes(1);

    transport.invocationResults[0]!.reject(new Error("late transport failure"));
    await Promise.resolve();
    await Promise.resolve();
  });

  test("times out through the cancellation path and clears the timer", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const client = new RpcClient(transport, {
      protocolVersion: 1,
      clientId: "client-1",
    });

    const resultPromise = client.call("rpc:hardware/connect", undefined, {
      timeoutMs: 25,
    });
    const requestId = transport.invocations[0]!.requestId;
    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED",
    });
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(transport.cancellations).toEqual([requestId]);
    expect(vi.getTimerCount()).toBe(0);

    transport.resolveInvocation(0, success(requestId));
    await Promise.resolve();
  });

  test("converts validated remote errors and maps malformed responses to INTERNAL", async () => {
    const transport = new FakeTransport();
    const client = new RpcClient(transport, {
      protocolVersion: 1,
      clientId: "client-1",
    });
    const remotePromise = client.call("rpc:hardware/connect", undefined);
    const remoteRequestId = transport.invocations[0]!.requestId;
    transport.resolveInvocation(0, {
      protocolVersion: 1,
      clientId: "client-1",
      type: "error",
      error: {
        code: "DEVICE_BUSY",
        message: "Device is busy.",
        details: { retryable: true },
      },
    });
    await expect(remotePromise).rejects.toEqual(
      expect.objectContaining({
        name: "RemoteError",
        code: "DEVICE_BUSY",
        details: { retryable: true },
      }),
    );

    const malformedPromise = client.call("rpc:hardware/connect", undefined);
    transport.invocationResults[1]!.resolve({
      protocolVersion: 1,
      clientId: "client-1",
      type: "success",
      requestId: remoteRequestId,
      result: { connected: true },
    });
    await expect(malformedPromise).rejects.toMatchObject({ code: "INTERNAL" });
  });

  test("generates monotonically unique opaque IDs", () => {
    const first = createOpaqueId("request");
    const second = createOpaqueId("request");

    expect(first).not.toBe(second);
    expect(first).not.toMatch(/^request-?1$/);
  });

  test("RemoteError exposes only safe protocol fields", () => {
    const error = new RemoteError("FORBIDDEN", "Denied", { reason: "policy" });

    expect(error).toEqual(
      expect.objectContaining({
        name: "RemoteError",
        code: "FORBIDDEN",
        message: "Denied",
        details: { reason: "policy" },
      }),
    );
    expect("cause" in error).toBe(false);
  });
});

describe("RpcClient dispose", () => {
  test("settles an in-flight sent call as CANCELLED and cancels it once", async () => {
    const transport = new FakeTransport();
    const client = new RpcClient(transport, {
      protocolVersion: 1,
      clientId: "client-1",
    });

    const resultPromise = client.call("rpc:hardware/connect", undefined);
    const requestId = transport.invocations[0]!.requestId;

    client.dispose();

    await expect(resultPromise).rejects.toMatchObject({
      code: "CANCELLED",
      message: "Renderer API is disposed.",
    });
    expect(transport.cancellations).toEqual([requestId]);
  });

  test("resolves a permanently pending call (Infinity timeout) on dispose", async () => {
    const transport = new FakeTransport();
    const client = new RpcClient(transport, {
      protocolVersion: 1,
      clientId: "client-1",
    });

    const resultPromise = client.call("rpc:hardware/connect", undefined, {
      timeoutMs: Number.POSITIVE_INFINITY,
    });

    client.dispose();

    await expect(resultPromise).rejects.toMatchObject({ code: "CANCELLED" });
  });

  test("dispose settlement wins over a later deadline timeout", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const client = new RpcClient(transport, {
      protocolVersion: 1,
      clientId: "client-1",
    });

    const resultPromise = client.call("rpc:hardware/connect", undefined, {
      timeoutMs: 25,
    });
    const requestId = transport.invocations[0]!.requestId;
    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: "CANCELLED",
    });

    client.dispose();
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(transport.cancellations).toEqual([requestId]);
  });

  test("dispose settlement wins over a later abort signal", async () => {
    const transport = new FakeTransport();
    const client = new RpcClient(transport, {
      protocolVersion: 1,
      clientId: "client-1",
    });
    const controller = new AbortController();

    const resultPromise = client.call("rpc:hardware/connect", undefined, {
      signal: controller.signal,
    });
    const requestId = transport.invocations[0]!.requestId;

    client.dispose();
    controller.abort();

    await expect(resultPromise).rejects.toMatchObject({ code: "CANCELLED" });
    expect(transport.cancellations).toEqual([requestId]);
  });

  test("dispose is idempotent and cancels each in-flight call only once", async () => {
    const transport = new FakeTransport();
    const client = new RpcClient(transport, {
      protocolVersion: 1,
      clientId: "client-1",
    });

    const resultPromise = client.call("rpc:hardware/connect", undefined);
    const requestId = transport.invocations[0]!.requestId;

    client.dispose();
    client.dispose();

    await expect(resultPromise).rejects.toMatchObject({ code: "CANCELLED" });
    expect(transport.cancellations).toEqual([requestId]);
  });

  test("does not cancel a call already settled by a response", async () => {
    const transport = new FakeTransport();
    const client = new RpcClient(transport, {
      protocolVersion: 1,
      clientId: "client-1",
    });

    const resultPromise = client.call("rpc:hardware/connect", undefined);
    transport.resolveInvocation(
      0,
      success(transport.invocations[0]!.requestId),
    );
    await expect(resultPromise).resolves.toEqual({ connected: true });

    client.dispose();

    expect(transport.cancellations).toEqual([]);
  });

  test("rejects a call made after dispose without sending it", async () => {
    const transport = new FakeTransport();
    const client = new RpcClient(transport, {
      protocolVersion: 1,
      clientId: "client-1",
    });

    client.dispose();

    await expect(
      client.call("rpc:hardware/connect", undefined),
    ).rejects.toMatchObject({
      code: "CANCELLED",
      message: "Renderer API is disposed.",
    });
    expect(transport.invocations).toHaveLength(0);
  });

  test("ignores a late transport response after dispose settled the call", async () => {
    const transport = new FakeTransport();
    const client = new RpcClient(transport, {
      protocolVersion: 1,
      clientId: "client-1",
    });

    const resultPromise = client.call("rpc:hardware/connect", undefined);
    const requestId = transport.invocations[0]!.requestId;

    client.dispose();
    transport.resolveInvocation(0, success(requestId));

    await expect(resultPromise).rejects.toMatchObject({ code: "CANCELLED" });
  });

  test("settles as CANCELLED even when the transport cancel call throws", async () => {
    const transport = new FakeTransport();
    transport.cancel = () => {
      throw new Error("cancel channel is gone");
    };
    const client = new RpcClient(transport, {
      protocolVersion: 1,
      clientId: "client-1",
    });

    const resultPromise = client.call("rpc:hardware/connect", undefined);

    client.dispose();

    await expect(resultPromise).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
