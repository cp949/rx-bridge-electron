import { afterEach, describe, expect, test, vi } from "vitest";

import {
  RemoteError,
  createRendererApi,
  createOpaqueId,
} from "../../src/renderer/index.js";
import { FakeTransport } from "./fake-transport.js";

interface AppBridge {
  readonly hardware: {
    readonly rpc: {
      connect(input: { readonly deviceId: string }): {
        readonly connected: boolean;
      };
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

describe("renderer RPC races", () => {
  test("settles once when response and abort fire in the same turn in either order", async () => {
    for (const first of ["response", "abort"] as const) {
      const transport = new FakeTransport();
      const api = await createRendererApi<AppBridge>(transport);
      const controller = new AbortController();
      const settlements: string[] = [];
      const resultPromise = api.hardware.rpc.connect(
        { deviceId: "d1" },
        {
          signal: controller.signal,
          timeoutMs: Number.POSITIVE_INFINITY,
        },
      );
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
      const api = await createRendererApi<AppBridge>(transport);
      const settlements: string[] = [];

      const resultPromise = api.hardware.rpc.connect(
        { deviceId: "d1" },
        { timeoutMs: 25 },
      );
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
    const api = await createRendererApi<AppBridge>(transport);
    const controller = new AbortController();
    controller.abort();

    await expect(
      api.hardware.rpc.connect(
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
    const api = await createRendererApi<AppBridge>(transport);
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    const resultPromise = api.hardware.rpc.connect(
      { deviceId: "d1" },
      { signal: controller.signal },
    );
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
    const api = await createRendererApi<AppBridge>(transport);
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const resultPromise = api.hardware.rpc.connect(
      { deviceId: "d1" },
      { signal: controller.signal },
    );
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

  test("sends cancel once when transport.cancel re-enters the call's abort", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const controller = new AbortController();
    const recordCancel = transport.cancel.bind(transport);
    transport.cancel = (requestId) => {
      recordCancel(requestId);
      controller.abort();
    };
    const api = await createRendererApi<AppBridge>(transport);
    const settlements: string[] = [];

    const resultPromise = api.hardware.rpc.connect(
      { deviceId: "d1" },
      { signal: controller.signal, timeoutMs: 25 },
    );
    const requestId = transport.invocations[0]!.requestId;
    const observed = resultPromise.then(
      () => settlements.push("response"),
      (error: RemoteError) => settlements.push(error.code),
    );
    await vi.advanceTimersByTimeAsync(25);
    await observed;

    expect(settlements).toHaveLength(1);
    expect(transport.cancellations).toEqual([requestId]);
  });

  test("times out through the cancellation path and clears the timer", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const api = await createRendererApi<AppBridge>(transport);

    const resultPromise = api.hardware.rpc.connect(
      { deviceId: "d1" },
      { timeoutMs: 25 },
    );
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

  test("defaults an omitted timeoutMs to 30s: undecided at 29,999ms, DEADLINE_EXCEEDED at 30,000ms, cancelled once", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const api = await createRendererApi<AppBridge>(transport);

    const resultPromise = api.hardware.rpc.connect({ deviceId: "d1" });
    const requestId = transport.invocations[0]!.requestId;
    const settlements: string[] = [];
    const observed = resultPromise.then(
      () => settlements.push("response"),
      (error: RemoteError) => settlements.push(error.code),
    );

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settlements).toEqual([]);
    expect(transport.cancellations).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await observed;

    expect(settlements).toEqual(["DEADLINE_EXCEEDED"]);
    expect(transport.cancellations).toEqual([requestId]);
    expect(transport.cancellations.length).toBeLessThanOrEqual(1);
  });

  test("converts validated remote errors and maps malformed responses to INTERNAL", async () => {
    const transport = new FakeTransport();
    const api = await createRendererApi<AppBridge>(transport);
    const remotePromise = api.hardware.rpc.connect({ deviceId: "d1" });
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

    const malformedPromise = api.hardware.rpc.connect({ deviceId: "d1" });
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

describe("renderer RPC dispose", () => {
  test("settles an in-flight sent call as CANCELLED and cancels it once", async () => {
    const transport = new FakeTransport();
    const api = await createRendererApi<AppBridge>(transport);

    const resultPromise = api.hardware.rpc.connect({ deviceId: "d1" });
    const requestId = transport.invocations[0]!.requestId;

    api.dispose();

    await expect(resultPromise).rejects.toMatchObject({
      code: "CANCELLED",
      message: "Renderer API is disposed.",
    });
    expect(transport.cancellations).toEqual([requestId]);
  });

  test("resolves a permanently pending call (Infinity timeout) on dispose", async () => {
    const transport = new FakeTransport();
    const api = await createRendererApi<AppBridge>(transport);

    const resultPromise = api.hardware.rpc.connect(
      { deviceId: "d1" },
      { timeoutMs: Number.POSITIVE_INFINITY },
    );

    api.dispose();

    await expect(resultPromise).rejects.toMatchObject({ code: "CANCELLED" });
  });

  test("dispose settlement wins over a later deadline timeout", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const api = await createRendererApi<AppBridge>(transport);

    const resultPromise = api.hardware.rpc.connect(
      { deviceId: "d1" },
      { timeoutMs: 25 },
    );
    const requestId = transport.invocations[0]!.requestId;
    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: "CANCELLED",
    });

    api.dispose();
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(transport.cancellations).toEqual([requestId]);
  });

  test("dispose settlement wins over a later abort signal", async () => {
    const transport = new FakeTransport();
    const api = await createRendererApi<AppBridge>(transport);
    const controller = new AbortController();

    const resultPromise = api.hardware.rpc.connect(
      { deviceId: "d1" },
      { signal: controller.signal },
    );
    const requestId = transport.invocations[0]!.requestId;

    api.dispose();
    controller.abort();

    await expect(resultPromise).rejects.toMatchObject({ code: "CANCELLED" });
    expect(transport.cancellations).toEqual([requestId]);
  });

  test("dispose is idempotent and cancels each in-flight call only once", async () => {
    const transport = new FakeTransport();
    const api = await createRendererApi<AppBridge>(transport);

    const resultPromise = api.hardware.rpc.connect({ deviceId: "d1" });
    const requestId = transport.invocations[0]!.requestId;

    api.dispose();
    api.dispose();

    await expect(resultPromise).rejects.toMatchObject({ code: "CANCELLED" });
    expect(transport.cancellations).toEqual([requestId]);
  });

  test("does not cancel a call already settled by a response", async () => {
    const transport = new FakeTransport();
    const api = await createRendererApi<AppBridge>(transport);

    const resultPromise = api.hardware.rpc.connect({ deviceId: "d1" });
    transport.resolveInvocation(
      0,
      success(transport.invocations[0]!.requestId),
    );
    await expect(resultPromise).resolves.toEqual({ connected: true });

    api.dispose();

    expect(transport.cancellations).toEqual([]);
  });

  test("rejects a call made after dispose without sending it", async () => {
    const transport = new FakeTransport();
    const api = await createRendererApi<AppBridge>(transport);

    api.dispose();

    await expect(
      api.hardware.rpc.connect({ deviceId: "d1" }),
    ).rejects.toMatchObject({
      code: "CANCELLED",
      message: "Renderer API is disposed.",
    });
    expect(transport.invocations).toHaveLength(0);
  });

  test("ignores a late transport response after dispose settled the call", async () => {
    const transport = new FakeTransport();
    const api = await createRendererApi<AppBridge>(transport);

    const resultPromise = api.hardware.rpc.connect({ deviceId: "d1" });
    const requestId = transport.invocations[0]!.requestId;

    api.dispose();
    transport.resolveInvocation(0, success(requestId));

    await expect(resultPromise).rejects.toMatchObject({ code: "CANCELLED" });
  });

  test("settles as CANCELLED even when the transport cancel call throws", async () => {
    const transport = new FakeTransport();
    transport.cancel = () => {
      throw new Error("cancel channel is gone");
    };
    const api = await createRendererApi<AppBridge>(transport);

    const resultPromise = api.hardware.rpc.connect({ deviceId: "d1" });

    api.dispose();

    await expect(resultPromise).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
