import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createRendererApi,
  type RendererDiagnostic,
  type RendererDiagnosticsSink,
} from "../../src/renderer/index.js";
import type {
  RendererStreamCommand,
  StreamMessage,
} from "../../src/protocol/index.js";
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

interface StreamBridge {
  readonly hardware: {
    readonly state: {
      readonly connection$: string | undefined;
    };
    readonly event: {
      readonly fault$: string;
    };
  };
}

function streamTransport(): FakeTransport {
  const transport = new FakeTransport();
  transport.handshake = Promise.resolve({
    protocolVersion: 1,
    clientId: "client-1",
    manifest: {
      rpc: [],
      state: ["state:hardware/connection$"],
      event: ["event:hardware/fault$"],
    },
  });
  return transport;
}

type StreamMessageBody = StreamMessage extends infer Message
  ? Message extends StreamMessage
    ? Omit<Message, "protocolVersion" | "clientId" | "subscriptionId">
    : never
  : never;

function streamMessage(
  subscriptionId: string,
  value: StreamMessageBody,
): StreamMessage {
  return {
    protocolVersion: 1,
    clientId: "client-1",
    subscriptionId,
    ...value,
  } as StreamMessage;
}

function subscriptions(transport: FakeTransport) {
  return transport.controls.filter(
    (
      command,
    ): command is Extract<
      RendererStreamCommand,
      { readonly type: "subscribe" }
    > => command.type === "subscribe",
  );
}

/**
 * `record` 호출을 그대로 쌓아 두는 sink. 이벤트 자체(순서·개수·페이로드)를
 * 검증하는 test에서 쓴다.
 */
function recordingSink(): {
  readonly sink: RendererDiagnosticsSink;
  readonly events: RendererDiagnostic[];
} {
  const events: RendererDiagnostic[] = [];
  return {
    events,
    sink: {
      record(event) {
        events.push(event);
      },
    },
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
  delete (globalThis as { rxBridge?: unknown }).rxBridge;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("handshake-failed diagnostics (ADR 0022 결정 9)", () => {
  test.each([
    [
      "transport",
      () => Promise.reject(new Error("secret absolute path from preload")),
      "transport" as const,
      { code: "INTERNAL", message: "Bridge handshake failed." },
    ],
    [
      "malformed",
      () => Promise.resolve({ protocolVersion: 1, clientId: "client-1" }),
      "malformed" as const,
      { code: "INTERNAL", message: "Malformed bridge handshake." },
    ],
    [
      "version-mismatch",
      () =>
        Promise.resolve({
          protocolVersion: 2,
          clientId: "client-1",
          manifest: { rpc: [], state: [], event: [] },
        }),
      "version-mismatch" as const,
      { code: "INTERNAL", message: "Unsupported bridge handshake." },
    ],
    [
      "invalid-manifest",
      () =>
        Promise.resolve({
          protocolVersion: 1,
          clientId: "client-1",
          manifest: { rpc: ["hardware.connect"], state: [], event: [] },
        }),
      "invalid-manifest" as const,
      { code: "INTERNAL" },
    ],
  ])(
    "records handshake-failed with reason %s and leaves the rejection unchanged",
    async (_label, buildHandshake, reason, rejection) => {
      const transport = new FakeTransport();
      transport.handshake = buildHandshake();
      const { sink, events } = recordingSink();

      await expect(
        createRendererApi<AppBridge>({ transport, diagnostics: sink }),
      ).rejects.toMatchObject(rejection);

      expect(events).toEqual([{ type: "handshake-failed", reason }]);
    },
  );

  test("does not record when the global transport is missing (wiring error, not a handshake failure)", async () => {
    const { sink, events } = recordingSink();

    await expect(
      createRendererApi<AppBridge>({ diagnostics: sink }),
    ).rejects.toThrow(/rxBridge/);

    expect(events).toEqual([]);
  });
});

describe("sink exception isolation (ADR 0022 결정 11)", () => {
  test("a throwing sink does not change the rejected value", async () => {
    const transport = new FakeTransport();
    transport.handshake = Promise.reject(new Error("boom"));
    const throwingSink: RendererDiagnosticsSink = {
      record() {
        throw new Error("sink boom");
      },
    };

    await expect(
      createRendererApi<AppBridge>({ transport, diagnostics: throwingSink }),
    ).rejects.toMatchObject({
      code: "INTERNAL",
      message: "Bridge handshake failed.",
    });
  });

  test("a throwing sink does not change RPC results", async () => {
    const transport = new FakeTransport();
    const api = await createRendererApi<AppBridge>({
      transport,
      diagnostics: {
        record() {
          throw new Error("sink boom");
        },
      },
    });

    const okPromise = api.hardware.rpc.connect({ deviceId: "d1" });
    transport.resolveInvocation(
      0,
      success(transport.invocations[0]!.requestId),
    );
    await expect(okPromise).resolves.toEqual({ connected: true });

    await expect(
      api.hardware.rpc.connect({ deviceId: "d1" }, { timeoutMs: -1 }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  test("a throwing sink does not change subscription delivery or cleanup", async () => {
    const transport = streamTransport();
    const api = await createRendererApi<StreamBridge>({
      transport,
      diagnostics: {
        record() {
          throw new Error("sink boom");
        },
      },
    });

    const values: string[] = [];
    const subscription = api.hardware.event.fault$.subscribe((value) => {
      values.push(value);
    });
    const id = subscriptions(transport)[0]!.subscriptionId;
    transport.emitStream(
      streamMessage(id, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(id, { type: "batch", sequence: 1, values: ["overheat"] }),
    );
    subscription.unsubscribe();

    expect(values).toEqual(["overheat"]);
    expect(transport.controls.map((command) => command.type)).toEqual([
      "subscribe",
      "acknowledge",
      "unsubscribe",
    ]);
  });

  test("without a sink, createRendererApi stays silent on the console", async () => {
    const transport = new FakeTransport();
    transport.handshake = Promise.reject(new Error("boom"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      createRendererApi<AppBridge>({ transport }),
    ).rejects.toMatchObject({ code: "INTERNAL" });

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("rpc-settled diagnostics (ADR 0022 결정 5)", () => {
  test("records ok with the call key and a non-negative duration", async () => {
    const transport = new FakeTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<AppBridge>({
      transport,
      diagnostics: sink,
    });

    const resultPromise = api.hardware.rpc.connect({ deviceId: "d1" });
    transport.resolveInvocation(
      0,
      success(transport.invocations[0]!.requestId),
    );
    await expect(resultPromise).resolves.toEqual({ connected: true });

    expect(events).toEqual([
      {
        type: "rpc-settled",
        key: "rpc:hardware/connect",
        durationMs: expect.any(Number),
        cause: "ok",
      },
    ]);
    const [event] = events;
    if (event?.type !== "rpc-settled") {
      throw new Error("expected an rpc-settled event");
    }
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("records remote-error with the protocol code and no other identifiers", async () => {
    const transport = new FakeTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<AppBridge>({
      transport,
      diagnostics: sink,
    });

    const resultPromise = api.hardware.rpc.connect({ deviceId: "d1" });
    transport.resolveInvocation(0, {
      protocolVersion: 1,
      clientId: "client-1",
      type: "error",
      requestId: transport.invocations[0]!.requestId,
      error: { code: "DEVICE_BUSY", message: "Device is busy." },
    });
    await expect(resultPromise).rejects.toMatchObject({ code: "DEVICE_BUSY" });

    expect(events).toEqual([
      {
        type: "rpc-settled",
        key: "rpc:hardware/connect",
        durationMs: expect.any(Number),
        cause: "remote-error",
        code: "DEVICE_BUSY",
      },
    ]);
  });

  test("records deadline when the timeout fires and cancels once", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<AppBridge>({
      transport,
      diagnostics: sink,
    });

    const resultPromise = api.hardware.rpc.connect(
      { deviceId: "d1" },
      { timeoutMs: 25 },
    );
    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED",
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    expect(events).toEqual([
      {
        type: "rpc-settled",
        key: "rpc:hardware/connect",
        durationMs: expect.any(Number),
        cause: "deadline",
      },
    ]);
  });

  test("records aborted when the signal fires before or during the call", async () => {
    const transport = new FakeTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<AppBridge>({
      transport,
      diagnostics: sink,
    });
    const controller = new AbortController();

    const resultPromise = api.hardware.rpc.connect(
      { deviceId: "d1" },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(resultPromise).rejects.toMatchObject({ code: "CANCELLED" });

    expect(events).toEqual([
      {
        type: "rpc-settled",
        key: "rpc:hardware/connect",
        durationMs: expect.any(Number),
        cause: "aborted",
      },
    ]);
  });

  test("records aborted for an already-aborted signal without sending", async () => {
    const transport = new FakeTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<AppBridge>({
      transport,
      diagnostics: sink,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      api.hardware.rpc.connect(
        { deviceId: "d1" },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });

    expect(events).toEqual([
      {
        type: "rpc-settled",
        key: "rpc:hardware/connect",
        durationMs: expect.any(Number),
        cause: "aborted",
      },
    ]);
    expect(transport.invocations).toHaveLength(0);
  });

  test("records disposed for an in-flight call settled by dispose", async () => {
    const transport = new FakeTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<AppBridge>({
      transport,
      diagnostics: sink,
    });

    const resultPromise = api.hardware.rpc.connect({ deviceId: "d1" });
    api.dispose();
    await expect(resultPromise).rejects.toMatchObject({ code: "CANCELLED" });

    expect(events).toEqual([
      {
        type: "rpc-settled",
        key: "rpc:hardware/connect",
        durationMs: expect.any(Number),
        cause: "disposed",
      },
    ]);
  });

  test("records disposed for a call made after dispose without sending it", async () => {
    const transport = new FakeTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<AppBridge>({
      transport,
      diagnostics: sink,
    });
    api.dispose();

    await expect(
      api.hardware.rpc.connect({ deviceId: "d1" }),
    ).rejects.toMatchObject({ code: "CANCELLED" });

    expect(events).toEqual([
      {
        type: "rpc-settled",
        key: "rpc:hardware/connect",
        durationMs: expect.any(Number),
        cause: "disposed",
      },
    ]);
  });

  test("records invalid-options for a rejected timeoutMs without sending", async () => {
    const transport = new FakeTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<AppBridge>({
      transport,
      diagnostics: sink,
    });

    await expect(
      api.hardware.rpc.connect({ deviceId: "d1" }, { timeoutMs: -1 }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    expect(events).toEqual([
      {
        type: "rpc-settled",
        key: "rpc:hardware/connect",
        durationMs: expect.any(Number),
        cause: "invalid-options",
      },
    ]);
    expect(transport.invocations).toHaveLength(0);
  });

  test("records transport-failed when invoke throws synchronously, with no separate transport-failed event", async () => {
    const transport = new FakeTransport();
    transport.invoke = () => {
      throw new Error("invoke channel is gone");
    };
    const { sink, events } = recordingSink();
    const api = await createRendererApi<AppBridge>({
      transport,
      diagnostics: sink,
    });

    await expect(
      api.hardware.rpc.connect({ deviceId: "d1" }),
    ).rejects.toMatchObject({ code: "INTERNAL" });

    expect(events).toEqual([
      {
        type: "rpc-settled",
        key: "rpc:hardware/connect",
        durationMs: expect.any(Number),
        cause: "transport-failed",
      },
    ]);
  });

  test("records transport-failed when the invoke promise rejects", async () => {
    const transport = new FakeTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<AppBridge>({
      transport,
      diagnostics: sink,
    });

    const resultPromise = api.hardware.rpc.connect({ deviceId: "d1" });
    transport.invocationResults[0]!.reject(new Error("transport dropped"));
    await expect(resultPromise).rejects.toMatchObject({ code: "INTERNAL" });

    expect(events).toEqual([
      {
        type: "rpc-settled",
        key: "rpc:hardware/connect",
        durationMs: expect.any(Number),
        cause: "transport-failed",
      },
    ]);
  });

  test("records malformed-response when the response does not match the active request", async () => {
    const transport = new FakeTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<AppBridge>({
      transport,
      diagnostics: sink,
    });

    const resultPromise = api.hardware.rpc.connect({ deviceId: "d1" });
    transport.invocationResults[0]!.resolve(success("mismatched-request-id"));
    await expect(resultPromise).rejects.toMatchObject({ code: "INTERNAL" });

    expect(events).toEqual([
      {
        type: "rpc-settled",
        key: "rpc:hardware/connect",
        durationMs: expect.any(Number),
        cause: "malformed-response",
      },
    ]);
  });

  test("records exactly once when the deadline wins a race against a late response", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<AppBridge>({
      transport,
      diagnostics: sink,
    });

    const resultPromise = api.hardware.rpc.connect(
      { deviceId: "d1" },
      { timeoutMs: 25 },
    );
    const requestId = transport.invocations[0]!.requestId;
    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED",
    });
    await vi.advanceTimersByTimeAsync(25);
    transport.resolveInvocation(0, success(requestId));
    await rejection;
    await Promise.resolve();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "rpc-settled", cause: "deadline" });
  });

  test("records exactly once when transport.cancel re-enters the call's abort", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const controller = new AbortController();
    const recordCancel = transport.cancel.bind(transport);
    transport.cancel = (requestId) => {
      recordCancel(requestId);
      controller.abort();
    };
    const { sink, events } = recordingSink();
    const api = await createRendererApi<AppBridge>({
      transport,
      diagnostics: sink,
    });

    const resultPromise = api.hardware.rpc.connect(
      { deviceId: "d1" },
      { signal: controller.signal, timeoutMs: 25 },
    );
    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED",
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    const rpcSettledEvents = events.filter(
      (event) => event.type === "rpc-settled",
    );
    expect(rpcSettledEvents).toHaveLength(1);
    expect(rpcSettledEvents[0]).toMatchObject({ cause: "deadline" });
  });

  test("records transport-failed(cancel) without changing the CANCELLED settlement", async () => {
    const transport = new FakeTransport();
    transport.cancel = () => {
      throw new Error("cancel channel is gone");
    };
    const { sink, events } = recordingSink();
    const api = await createRendererApi<AppBridge>({
      transport,
      diagnostics: sink,
    });

    const resultPromise = api.hardware.rpc.connect({ deviceId: "d1" });
    api.dispose();
    await expect(resultPromise).rejects.toMatchObject({ code: "CANCELLED" });

    expect(events).toEqual([
      {
        type: "rpc-settled",
        key: "rpc:hardware/connect",
        durationMs: expect.any(Number),
        cause: "disposed",
      },
      { type: "transport-failed", channel: "cancel" },
    ]);
  });

  test("calls the sink before the caller's catch callback", async () => {
    const transport = new FakeTransport();
    const order: string[] = [];
    const sink: RendererDiagnosticsSink = {
      record() {
        order.push("sink");
      },
    };
    const api = await createRendererApi<AppBridge>({
      transport,
      diagnostics: sink,
    });

    const resultPromise = api.hardware.rpc.connect({ deviceId: "d1" });
    api.dispose();
    await resultPromise.catch(() => {
      order.push("catch");
    });

    expect(order).toEqual(["sink", "catch"]);
  });
});

describe("subscription-opened/closed diagnostics (ADR 0022 결정 6)", () => {
  test("records one opened/closed pair per generation even with two local subscribers, cause unsubscribed", async () => {
    const transport = streamTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<StreamBridge>({
      transport,
      diagnostics: sink,
    });

    const first = api.hardware.event.fault$.subscribe(() => {});
    const second = api.hardware.event.fault$.subscribe(() => {});
    expect(events).toEqual([
      { type: "subscription-opened", key: "event:hardware/fault$" },
    ]);

    first.unsubscribe();
    expect(events).toEqual([
      { type: "subscription-opened", key: "event:hardware/fault$" },
    ]);

    second.unsubscribe();
    expect(events).toEqual([
      { type: "subscription-opened", key: "event:hardware/fault$" },
      {
        type: "subscription-closed",
        key: "event:hardware/fault$",
        cause: "unsubscribed",
      },
    ]);
  });

  test("records subscription-closed(disposed) for a generation still open at dispose", async () => {
    const transport = streamTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<StreamBridge>({
      transport,
      diagnostics: sink,
    });

    api.hardware.event.fault$.subscribe(() => {});
    api.dispose();

    expect(events).toEqual([
      { type: "subscription-opened", key: "event:hardware/fault$" },
      {
        type: "subscription-closed",
        key: "event:hardware/fault$",
        cause: "disposed",
      },
    ]);
  });

  test("does not send subscribe when the sink disposes the API inside subscription-opened", async () => {
    const transport = streamTransport();
    const events: RendererDiagnostic[] = [];
    let api: Awaited<ReturnType<typeof createRendererApi<StreamBridge>>>;
    api = await createRendererApi<StreamBridge>({
      transport,
      diagnostics: {
        record(event) {
          events.push(event);
          if (event.type === "subscription-opened") {
            api.dispose();
          }
        },
      },
    });

    let completed = false;
    api.hardware.event.fault$.subscribe({
      complete: () => {
        completed = true;
      },
    });

    expect(transport.controls.map((command) => command.type)).toEqual([
      "unsubscribe",
    ]);
    expect(completed).toBe(true);
    expect(events).toEqual([
      { type: "subscription-opened", key: "event:hardware/fault$" },
      {
        type: "subscription-closed",
        key: "event:hardware/fault$",
        cause: "disposed",
      },
    ]);
  });

  test("records subscription-closed(completed) on a complete message", async () => {
    const transport = streamTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<StreamBridge>({
      transport,
      diagnostics: sink,
    });

    api.hardware.event.fault$.subscribe(() => {});
    const id = subscriptions(transport)[0]!.subscriptionId;
    transport.emitStream(
      streamMessage(id, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(streamMessage(id, { type: "complete", sequence: 1 }));

    expect(events).toEqual([
      { type: "subscription-opened", key: "event:hardware/fault$" },
      {
        type: "subscription-closed",
        key: "event:hardware/fault$",
        cause: "completed",
      },
    ]);
  });

  test("records subscription-closed(remote-error) with the protocol code, including ADR 0020 retire (CANCELLED)", async () => {
    const transport = streamTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<StreamBridge>({
      transport,
      diagnostics: sink,
    });

    api.hardware.event.fault$.subscribe({ error: () => {} });
    const id = subscriptions(transport)[0]!.subscriptionId;
    transport.emitStream(
      streamMessage(id, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(id, {
        type: "error",
        sequence: 1,
        error: { code: "CANCELLED", message: "subscription was retired" },
      }),
    );

    expect(events).toEqual([
      { type: "subscription-opened", key: "event:hardware/fault$" },
      {
        type: "subscription-closed",
        key: "event:hardware/fault$",
        cause: "remote-error",
        code: "CANCELLED",
      },
    ]);
  });

  test("records subscription-closed(transport-failed) with no separate transport-failed event when the subscribe control throws", async () => {
    const transport = streamTransport();
    transport.control = () => {
      throw new Error("control channel is gone");
    };
    const { sink, events } = recordingSink();
    const api = await createRendererApi<StreamBridge>({
      transport,
      diagnostics: sink,
    });

    expect(() =>
      api.hardware.event.fault$.subscribe({ error: () => {} }),
    ).not.toThrow();

    expect(events).toEqual([
      { type: "subscription-opened", key: "event:hardware/fault$" },
      {
        type: "subscription-closed",
        key: "event:hardware/fault$",
        cause: "transport-failed",
      },
    ]);
  });
});

describe("message-dropped diagnostics (ADR 0022 결정 7)", () => {
  test("records malformed when a raw stream message fails to parse", async () => {
    const transport = streamTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<StreamBridge>({
      transport,
      diagnostics: sink,
    });

    api.hardware.event.fault$.subscribe(() => {});
    transport.emitStream({ type: "subscribed" } as unknown as StreamMessage);

    expect(events).toEqual([
      { type: "subscription-opened", key: "event:hardware/fault$" },
      { type: "message-dropped", reason: "malformed" },
    ]);
  });

  test("records envelope-mismatch when clientId does not match the session", async () => {
    const transport = streamTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<StreamBridge>({
      transport,
      diagnostics: sink,
    });

    api.hardware.event.fault$.subscribe(() => {});
    const id = subscriptions(transport)[0]!.subscriptionId;
    transport.emitStream({
      protocolVersion: 1,
      clientId: "other-client",
      subscriptionId: id,
      type: "subscribed",
      sequence: 0,
    } as StreamMessage);

    expect(events).toEqual([
      { type: "subscription-opened", key: "event:hardware/fault$" },
      { type: "message-dropped", reason: "envelope-mismatch" },
    ]);
  });

  test("records out-of-order for pre-subscribed data, a duplicate subscribed, and a non-increasing sequence", async () => {
    const transport = streamTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<StreamBridge>({
      transport,
      diagnostics: sink,
    });

    api.hardware.event.fault$.subscribe(() => {});
    const id = subscriptions(transport)[0]!.subscriptionId;

    transport.emitStream(
      streamMessage(id, { type: "batch", sequence: 1, values: ["too-early"] }),
    );
    transport.emitStream(
      streamMessage(id, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(id, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(id, { type: "batch", sequence: 1, values: ["first"] }),
    );
    transport.emitStream(
      streamMessage(id, {
        type: "batch",
        sequence: 1,
        values: ["duplicate"],
      }),
    );

    expect(events).toEqual([
      { type: "subscription-opened", key: "event:hardware/fault$" },
      { type: "message-dropped", reason: "out-of-order" },
      { type: "message-dropped", reason: "out-of-order" },
      { type: "message-dropped", reason: "out-of-order" },
    ]);
  });

  test("does not record for an unknown subscriptionId", async () => {
    const transport = streamTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<StreamBridge>({
      transport,
      diagnostics: sink,
    });

    api.hardware.event.fault$.subscribe(() => {});
    transport.emitStream(
      streamMessage("unknown-subscription", {
        type: "subscribed",
        sequence: 0,
      }),
    );

    expect(events).toEqual([
      { type: "subscription-opened", key: "event:hardware/fault$" },
    ]);
  });

  test("does not record after dispose", async () => {
    const transport = streamTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<StreamBridge>({
      transport,
      diagnostics: sink,
    });

    api.hardware.event.fault$.subscribe(() => {});
    const id = subscriptions(transport)[0]!.subscriptionId;
    api.dispose();
    events.length = 0;
    transport.emitStream(
      streamMessage(id, { type: "batch", sequence: 1, values: ["late"] }),
    );

    expect(events).toEqual([]);
  });
});

describe("transport-failed(control) diagnostics (ADR 0022 결정 8)", () => {
  test("records transport-failed(control) when unsubscribe throws on close, and the generation still closes locally", async () => {
    const transport = streamTransport();
    transport.control = (command) => {
      if (command.type === "unsubscribe") {
        throw new Error("control channel is gone");
      }
    };
    const { sink, events } = recordingSink();
    const api = await createRendererApi<StreamBridge>({
      transport,
      diagnostics: sink,
    });

    const subscription = api.hardware.event.fault$.subscribe(() => {});
    subscription.unsubscribe();

    expect(events).toEqual([
      { type: "subscription-opened", key: "event:hardware/fault$" },
      {
        type: "subscription-closed",
        key: "event:hardware/fault$",
        cause: "unsubscribed",
      },
      { type: "transport-failed", channel: "control" },
    ]);
  });

  test("records transport-failed(control) when unsubscribe throws during dispose", async () => {
    const transport = streamTransport();
    transport.control = (command) => {
      if (command.type === "unsubscribe") {
        throw new Error("control channel is gone");
      }
    };
    const { sink, events } = recordingSink();
    const api = await createRendererApi<StreamBridge>({
      transport,
      diagnostics: sink,
    });

    api.hardware.event.fault$.subscribe(() => {});
    api.dispose();

    expect(events).toEqual([
      { type: "subscription-opened", key: "event:hardware/fault$" },
      {
        type: "subscription-closed",
        key: "event:hardware/fault$",
        cause: "disposed",
      },
      { type: "transport-failed", channel: "control" },
    ]);
  });

  test("records transport-failed(control) when acknowledge throws", async () => {
    const transport = streamTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<StreamBridge>({
      transport,
      diagnostics: sink,
    });

    api.hardware.event.fault$.subscribe(() => {});
    const id = subscriptions(transport)[0]!.subscriptionId;
    transport.controlHook = (command) => {
      if (command.type === "acknowledge") {
        throw new Error("control channel is gone");
      }
    };
    transport.emitStream(
      streamMessage(id, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(id, { type: "batch", sequence: 1, values: ["v"] }),
    );

    expect(events).toEqual([
      { type: "subscription-opened", key: "event:hardware/fault$" },
      { type: "transport-failed", channel: "control" },
    ]);
  });

  test("never includes subscriptionId in a recorded field", async () => {
    const transport = streamTransport();
    const { sink, events } = recordingSink();
    const api = await createRendererApi<StreamBridge>({
      transport,
      diagnostics: sink,
    });

    api.hardware.event.fault$.subscribe(() => {});
    api.dispose();

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event).not.toHaveProperty("subscriptionId");
    }
  });
});
