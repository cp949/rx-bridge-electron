import { BehaviorSubject } from "rxjs";
import { describe, expect, test, vi } from "vitest";
import type { BridgeImpl } from "../../src/contract/index.js";
import type {
  BridgeValue,
  StreamMessage,
  WireStreamCommand,
} from "../../src/protocol/index.js";
import { createBridgeServer } from "../../src/main/index.js";
import { DocumentSessions } from "../../src/main/document-sessions.js";
import { resolveResourceLimits } from "../../src/main/resource-limits.js";
import { currentValueSource } from "../../src/main/sources.js";
import { FakeTarget, handshakeRequest, sender } from "./fake-ipc.js";
import { testSubscriptionId } from "./subscription-ids.js";

type HardwareBridge = { hardware: { rpc: { wait(): undefined } } };

const request = (clientId = "document-1", requestId = "request-1") => ({
  protocolVersion: 1 as const,
  clientId,
  requestId,
  key: "rpc:hardware/wait",
  input: undefined,
});

describe("Main session lifecycle", () => {
  test("navigation during pending authorization never starts the RPC handler", async () => {
    let allow!: (value: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const handler = vi.fn(async () => undefined);
    const impl: BridgeImpl<HardwareBridge> = {
      hardware: { rpc: { wait: handler } },
    };
    const server = createBridgeServer(impl, {
      authorize: () => authorization,
    });
    const target = new FakeTarget();
    server.attach(target);
    const pending = server.dispatchRpc(sender(), request());
    target.endDocument();
    allow(true);
    await expect(pending).resolves.toMatchObject({
      type: "error",
      error: { code: "CANCELLED" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test("authorization rejection after navigation returns cancellation", async () => {
    let reject!: (reason: Error) => void;
    const authorization = new Promise<boolean>((_resolve, fail) => {
      reject = fail;
    });
    const handler = vi.fn(async () => undefined);
    const impl: BridgeImpl<HardwareBridge> = {
      hardware: { rpc: { wait: handler } },
    };
    const server = createBridgeServer(impl, {
      authorize: () => authorization,
    });
    const target = new FakeTarget();
    server.attach(target);
    const pending = server.dispatchRpc(sender(), request());
    target.endDocument();
    reject(new Error("late authorization failure"));
    await expect(pending).resolves.toMatchObject({
      type: "error",
      error: { code: "CANCELLED" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test("a retired handler rejection returns cancellation without exposing its error", async () => {
    let reject!: (reason: Error) => void;
    const handler = vi.fn(
      () =>
        new Promise<undefined>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const impl: BridgeImpl<HardwareBridge> = {
      hardware: { rpc: { wait: handler } },
    };
    const server = createBridgeServer(impl);
    const target = new FakeTarget();
    server.attach(target);
    const pending = server.dispatchRpc(sender(), request());
    target.endDocument();
    reject(new Error("late private failure"));
    await expect(pending).resolves.toMatchObject({
      type: "error",
      error: { code: "CANCELLED" },
    });
  });

  test("a stale detach cannot remove a replacement attachment", async () => {
    const handler = vi.fn(async () => undefined);
    const impl: BridgeImpl<HardwareBridge> = {
      hardware: { rpc: { wait: handler } },
    };
    const server = createBridgeServer(impl);
    const oldDetach = server.attach(new FakeTarget());
    await server.dispatchRpc(sender(), request());
    server.attach(new FakeTarget());
    oldDetach();
    await expect(
      server.dispatchRpc(sender(), request("document-2", "request-2")),
    ).resolves.toMatchObject({ type: "success" });
    await expect(
      server.dispatchRpc(sender(), request()),
    ).resolves.toMatchObject({ type: "error", error: { code: "FORBIDDEN" } });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  test("a client established during cancellation is not overwritten by the outer replacement", async () => {
    let server!: ReturnType<typeof createBridgeServer>;
    const handler = vi.fn(
      (_input: BridgeValue, context: { signal: AbortSignal }) =>
        new Promise<undefined>(() => {
          context.signal.addEventListener("abort", () => {
            expect(
              server.handshake(sender(), handshakeRequest("document-3")),
            ).toHaveProperty("manifest");
          });
        }),
    );
    const impl: BridgeImpl<HardwareBridge> = {
      hardware: { rpc: { wait: handler } },
    };
    server = createBridgeServer(impl);
    server.attach(new FakeTarget());
    void server.dispatchRpc(sender(), request());
    await Promise.resolve();
    expect(
      server.handshake(sender(), handshakeRequest("document-2")),
    ).toMatchObject({ type: "error" });
  });

  test("a reentrant attachment keeps the replacement target", async () => {
    let server!: ReturnType<typeof createBridgeServer>;
    const roles: string[] = [];
    const handler = vi.fn(
      (
        _input: BridgeValue,
        context: { signal: AbortSignal; clientId: string },
      ) =>
        context.clientId === "document-1"
          ? new Promise<undefined>(() => {
              context.signal.addEventListener("abort", () => {
                server.attach(new FakeTarget(1, "nested"));
              });
            })
          : Promise.resolve(undefined),
    );
    const impl: BridgeImpl<HardwareBridge> = {
      hardware: { rpc: { wait: handler } },
    };
    server = createBridgeServer(impl, {
      authorize: (context) => {
        roles.push(context.windowRole);
        return true;
      },
    });
    server.attach(new FakeTarget(1, "old"));
    void server.dispatchRpc(sender(), request());
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    const staleDetach = server.attach(new FakeTarget(1, "outer"));
    staleDetach();
    await server.dispatchRpc(sender(), request("document-2", "later"));
    expect(roles.at(-1)).toBe("nested");
  });
  test("replacing a document client aborts each outstanding handler exactly once", async () => {
    const signals: AbortSignal[] = [];
    const handler = vi.fn(
      (_input: BridgeValue, context: { signal: AbortSignal }) =>
        new Promise<undefined>((_resolve) => {
          signals.push(context.signal);
        }),
    );
    const impl: BridgeImpl<HardwareBridge> = {
      hardware: { rpc: { wait: handler } },
    };
    const server = createBridgeServer(impl);
    server.attach(new FakeTarget());
    void server.dispatchRpc(sender(), request());
    await Promise.resolve();
    void server.dispatchRpc(sender(), request("document-2", "request-2"));
    await Promise.resolve();
    expect(signals[0]?.aborted).toBe(true);
  });

  test("cancellation, lifecycle, detach, and disposal abort work idempotently", async () => {
    const signals: AbortSignal[] = [];
    const handler = vi.fn(
      (_input: BridgeValue, context: { signal: AbortSignal }) =>
        new Promise<undefined>((_resolve) => signals.push(context.signal)),
    );
    const impl: BridgeImpl<HardwareBridge> = {
      hardware: { rpc: { wait: handler } },
    };
    const server = createBridgeServer(impl);
    const target = new FakeTarget();
    const detach = server.attach(target);
    void server.dispatchRpc(sender(), request());
    await Promise.resolve();
    server.cancel(sender(), {
      protocolVersion: 1,
      clientId: "document-1",
      requestId: "request-1",
    });
    server.cancel(sender(), {
      protocolVersion: 1,
      clientId: "document-1",
      requestId: "request-1",
    });
    expect(signals[0]?.aborted).toBe(true);
    void server.dispatchRpc(sender(), request("document-2", "request-2"));
    await Promise.resolve();
    target.endDocument();
    detach();
    server.dispose();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  test("disposal rejects synchronous reentrant attachment and RPC attempts", async () => {
    let server!: ReturnType<typeof createBridgeServer>;
    const signals: AbortSignal[] = [];
    const reentrantDispatches: Promise<unknown>[] = [];
    const attachErrors: unknown[] = [];
    let reentrantAttempts = 0;
    const handler = vi.fn(
      (
        _input: BridgeValue,
        context: { signal: AbortSignal; clientId: string },
      ) => {
        signals.push(context.signal);
        return new Promise<undefined>(() => {
          context.signal.addEventListener("abort", () => {
            if (reentrantAttempts >= 2) return;
            reentrantAttempts += 1;
            try {
              server.attach(new FakeTarget());
            } catch (error) {
              attachErrors.push(error);
            }
            reentrantDispatches.push(
              server.dispatchRpc(
                sender(),
                request(
                  `document-${reentrantAttempts + 1}`,
                  `request-${reentrantAttempts + 1}`,
                ),
              ),
            );
            server.dispose();
          });
        });
      },
    );
    const impl: BridgeImpl<HardwareBridge> = {
      hardware: { rpc: { wait: handler } },
    };
    server = createBridgeServer(impl);
    server.attach(new FakeTarget());
    void server.dispatchRpc(sender(), request());
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());

    server.dispose();

    await Promise.resolve();
    expect(handler).toHaveBeenCalledOnce();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(attachErrors).toHaveLength(1);
    expect(attachErrors[0]).toMatchObject({
      name: "BridgeProtocolError",
      code: "FORBIDDEN",
      message: "Bridge server is disposed.",
    });
    expect(reentrantDispatches).toHaveLength(1);
    await expect(Promise.all(reentrantDispatches)).resolves.toMatchObject([
      { type: "error", error: { code: "FORBIDDEN" } },
    ]);
    expect(
      server.handshake(sender(), handshakeRequest("document-3")),
    ).toMatchObject({ type: "error" });
    await expect(
      server.dispatchRpc(sender(), request("document-3", "request-3")),
    ).resolves.toMatchObject({ type: "error", error: { code: "FORBIDDEN" } });
  });

  test("server.dispose() finalizes the server: attach throws, requests are rejected", async () => {
    const impl: BridgeImpl<HardwareBridge> = {
      hardware: { rpc: { wait: vi.fn(async () => undefined) } },
    };
    const server = createBridgeServer(impl);
    server.attach(new FakeTarget());
    server.dispose();

    expect(() => server.attach(new FakeTarget())).toThrowError(
      expect.objectContaining({
        name: "BridgeProtocolError",
        code: "FORBIDDEN",
        message: "Bridge server is disposed.",
      }),
    );
    expect(
      server.handshake(sender(), handshakeRequest("document-9")),
    ).toMatchObject({ type: "error" });
    await expect(
      server.dispatchRpc(sender(), request("document-9", "request-9")),
    ).resolves.toMatchObject({ type: "error", error: { code: "FORBIDDEN" } });

    const send = vi.fn();
    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "document-9",
        type: "subscribe",
        subscriptionId: "sub-9",
        key: "state:hardware/current$",
      },
      send,
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "subscribed", sequence: 0 }),
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "error",
        sequence: 1,
        error: {
          code: "FORBIDDEN",
          message: "Bridge sender is not authorized.",
        },
      }),
    );
  });

  test("repeated server.dispose() calls are no-ops", async () => {
    const handler = vi.fn(
      (_input: BridgeValue, context: { signal: AbortSignal }) =>
        new Promise<undefined>(() => {
          context.signal.addEventListener("abort", () => {
            recordCount += 1;
          });
        }),
    );
    let recordCount = 0;
    const records: unknown[] = [];
    const impl: BridgeImpl<HardwareBridge> = {
      hardware: { rpc: { wait: handler } },
    };
    const server = createBridgeServer(impl, {
      diagnostics: { record: (event) => records.push(event) },
    });
    server.attach(new FakeTarget());
    void server.dispatchRpc(sender(), request());
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());

    server.dispose();
    expect(recordCount).toBe(1);
    const diagnosticsAfterFirstDispose = records.length;

    expect(() => server.dispose()).not.toThrow();
    expect(() => server.dispose()).not.toThrow();
    expect(recordCount).toBe(1);
    expect(records).toHaveLength(diagnosticsAfterFirstDispose);
  });

  test("server.dispose() cancels an in-flight RPC handler", async () => {
    const handler = vi.fn(
      (_input: BridgeValue, context: { signal: AbortSignal }) =>
        new Promise<undefined>((_resolve, reject) => {
          context.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const impl: BridgeImpl<HardwareBridge> = {
      hardware: { rpc: { wait: handler } },
    };
    const server = createBridgeServer(impl);
    server.attach(new FakeTarget());
    const pending = server.dispatchRpc(sender(), request());
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());

    server.dispose();

    await expect(pending).resolves.toMatchObject({
      type: "error",
      error: { code: "CANCELLED" },
    });
  });

  test("a retired clientId is rejected while the server is alive", async () => {
    const impl: BridgeImpl<HardwareBridge> = {
      hardware: { rpc: { wait: vi.fn(async () => undefined) } },
    };
    const server = createBridgeServer(impl);
    server.attach(new FakeTarget());
    expect(
      server.handshake(sender(), handshakeRequest("document-1")),
    ).toHaveProperty("manifest");
    server.attach(new FakeTarget());

    expect(
      server.handshake(sender(), handshakeRequest("document-1")),
    ).toMatchObject({ type: "error" });
    await expect(
      server.dispatchRpc(sender(), request("document-1", "request-1")),
    ).resolves.toMatchObject({ type: "error", error: { code: "FORBIDDEN" } });
  });
});

describe("Main retired client retention", () => {
  const limits = resolveResourceLimits({
    maxRetiredClientsPerWebContents: 3,
  });
  // retired id의 재사용은 `establish`가 이 사유로 거부한다. 거부는 상태를 바꾸지 않는다.
  const retired = { reason: "sender-unauthorized" };

  test("eviction keeps only the most recent N retired client ids", () => {
    const sessions = new DocumentSessions(limits);
    const target = new FakeTarget();
    sessions.attach(target);
    for (const clientId of ["c1", "c2", "c3", "c4", "c5"])
      expect(sessions.establish(sender(), clientId)).toHaveProperty("session");

    expect(sessions.establish(sender(), "c2")).toEqual(retired);
    expect(sessions.establish(sender(), "c3")).toEqual(retired);
    expect(sessions.establish(sender(), "c4")).toEqual(retired);
    // 가장 오래된 c1은 밀려나 더는 거부 대상이 아니다.
    expect(sessions.establish(sender(), "c1")).toHaveProperty("session");
  });

  test("an evicted retired id still fails the frame check for a non-current sender", () => {
    const sessions = new DocumentSessions(limits);
    const target = new FakeTarget();
    sessions.attach(target);
    for (const clientId of ["c1", "c2", "c3", "c4", "c5"])
      sessions.establish(sender(), clientId);

    expect(sessions.establish(sender({ isMainFrame: false }), "c1")).toEqual({
      reason: "frame-not-main",
    });
  });

  test("a destroyed lifecycle event clears retired ids for that webContents", () => {
    const sessions = new DocumentSessions(limits);
    const target = new FakeTarget();
    sessions.attach(target);
    sessions.establish(sender(), "c1");
    sessions.establish(sender(), "c2");
    expect(sessions.establish(sender(), "c1")).toEqual(retired);

    target.fireLifecycle("destroyed");
    expect(sessions.establish(sender(), "c1")).toHaveProperty("session");
  });

  test("main-frame-navigation and render-process-gone never clear retired ids", () => {
    const sessions = new DocumentSessions(limits);
    const target = new FakeTarget();
    sessions.attach(target);
    sessions.establish(sender(), "c1");
    sessions.establish(sender(), "c2");

    target.fireLifecycle("main-frame-navigation");
    expect(sessions.establish(sender(), "c1")).toEqual(retired);
    expect(sessions.establish(sender(), "c2")).toEqual(retired);
    target.fireLifecycle("render-process-gone");
    expect(sessions.establish(sender(), "c1")).toEqual(retired);
    expect(sessions.establish(sender(), "c2")).toEqual(retired);
  });

  test("eviction and destroyed events only affect their own webContents", () => {
    const sessions = new DocumentSessions(limits);
    const targetA = new FakeTarget(1, "a");
    const targetB = new FakeTarget(2, "b");
    sessions.attach(targetA);
    sessions.attach(targetB);
    const senderA = sender({ webContentsId: 1 });
    const senderB = sender({ webContentsId: 2 });
    for (const clientId of ["c1", "c2", "c3", "c4"])
      sessions.establish(senderA, clientId);
    sessions.establish(senderB, "d1");
    sessions.establish(senderB, "d2");

    expect(sessions.establish(senderA, "c3")).toEqual(retired);
    expect(sessions.establish(senderB, "d1")).toEqual(retired);

    // destroyed는 현재 c4를 retire하며 c1을 밀어내므로, 비워졌는지는 c3로 본다.
    targetA.fireLifecycle("destroyed");
    expect(sessions.establish(senderA, "c3")).toHaveProperty("session");
    expect(sessions.establish(senderB, "d1")).toEqual(retired);
  });
});

describe("Main retire reason drives stream terminal notify", () => {
  const subscribeCommand = (
    subscriptionId: string,
    clientId = "c1",
  ): Extract<WireStreamCommand, { type: "subscribe" }> => ({
    protocolVersion: 1,
    clientId,
    type: "subscribe",
    subscriptionId,
    key: "state:hardware/current$",
  });

  function harness() {
    const server = createBridgeServer({
      hardware: {
        state: { current$: currentValueSource(new BehaviorSubject(1)) },
      },
    });
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => messages.push(message);
    return { server, messages, send };
  }

  /** 활성 구독 하나를 세운다. `subscribed`+초기값 `batch` 프레임까지 확인한다. */
  async function subscribeActive(
    server: ReturnType<typeof harness>["server"],
    messages: StreamMessage[],
    send: (message: StreamMessage) => void,
    clientId = "c1",
  ): Promise<void> {
    await server.controlStream(
      sender(),
      subscribeCommand(testSubscriptionId(1), clientId),
      send,
    );
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
    ]);
  }

  test("a main-frame navigation retire closes the subscription without notifying", async () => {
    const { server, messages, send } = harness();
    const target = new FakeTarget();
    server.attach(target);
    await subscribeActive(server, messages, send);
    target.fireLifecycle("main-frame-navigation");
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
    ]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("a destroyed lifecycle retire never notifies", async () => {
    const { server, messages, send } = harness();
    const target = new FakeTarget();
    server.attach(target);
    await subscribeActive(server, messages, send);
    target.fireLifecycle("destroyed");
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
    ]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("a replacing clientId retires the previous session with 'replaced' and never notifies", async () => {
    const { server, messages, send } = harness();
    server.attach(new FakeTarget());
    await subscribeActive(server, messages, send, "c1");
    const replacement: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      subscribeCommand(testSubscriptionId(1), "c2"),
      (message) => replacement.push(message),
    );
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
    ]);
    expect(replacement.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
    ]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(1);
  });

  test("the detach function retires the session with 'detach' and notifies", async () => {
    const { server, messages, send } = harness();
    const target = new FakeTarget();
    const detach = server.attach(target);
    await subscribeActive(server, messages, send);
    detach();
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
      "error",
    ]);
    expect(messages.at(-1)).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
  });

  test("a reentrant attach() on the same webContents retires with 'detach' and notifies", async () => {
    const { server, messages, send } = harness();
    server.attach(new FakeTarget());
    await subscribeActive(server, messages, send);
    server.attach(new FakeTarget());
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
      "error",
    ]);
    expect(messages.at(-1)).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
  });

  test("dispose() retires every live session with 'dispose' and notifies", async () => {
    const { server, messages, send } = harness();
    server.attach(new FakeTarget());
    await subscribeActive(server, messages, send);
    server.dispose();
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
      "error",
    ]);
    expect(messages.at(-1)).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
  });
});
