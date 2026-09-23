import { describe, expect, test, vi } from "vitest";
import {
  composeContracts,
  defineDomain,
  rpc,
  type Schema,
} from "../../src/contract/index.js";
import type { BridgeValue } from "../../src/protocol/index.js";
import { createBridgeServer, implementDomain } from "../../src/main/index.js";
import { FakeTarget, sender } from "./fake-ipc.js";

const value: Schema<undefined> = { parse: () => undefined };
const domain = defineDomain("hardware", {
  rpc: { wait: rpc({ input: value, output: value }) },
});
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
    const server = createBridgeServer(
      composeContracts(domain),
      [implementDomain(domain, { rpc: { wait: handler } })],
      { authorize: () => authorization },
    );
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
    const server = createBridgeServer(
      composeContracts(domain),
      [implementDomain(domain, { rpc: { wait: handler } })],
      { authorize: () => authorization },
    );
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
    const server = createBridgeServer(composeContracts(domain), [
      implementDomain(domain, { rpc: { wait: handler } }),
    ]);
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
    const server = createBridgeServer(composeContracts(domain), [
      implementDomain(domain, { rpc: { wait: handler } }),
    ]);
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
            expect(server.handshake(sender(), "document-3")).toBeDefined();
          });
        }),
    );
    server = createBridgeServer(composeContracts(domain), [
      implementDomain(domain, { rpc: { wait: handler } }),
    ]);
    server.attach(new FakeTarget());
    void server.dispatchRpc(sender(), request());
    await Promise.resolve();
    expect(server.handshake(sender(), "document-2")).toBeUndefined();
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
    server = createBridgeServer(
      composeContracts(domain),
      [implementDomain(domain, { rpc: { wait: handler } })],
      {
        authorize: (context) => {
          roles.push(context.windowRole);
          return true;
        },
      },
    );
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
    const server = createBridgeServer(composeContracts(domain), [
      implementDomain(domain, { rpc: { wait: handler } }),
    ]);
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
    const server = createBridgeServer(composeContracts(domain), [
      implementDomain(domain, { rpc: { wait: handler } }),
    ]);
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
    server = createBridgeServer(composeContracts(domain), [
      implementDomain(domain, { rpc: { wait: handler } }),
    ]);
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
    expect(server.handshake(sender(), "document-3")).toBeUndefined();
    await expect(
      server.dispatchRpc(sender(), request("document-3", "request-3")),
    ).resolves.toMatchObject({ type: "error", error: { code: "FORBIDDEN" } });
  });

  test("server.dispose() finalizes the server: attach throws, requests are rejected", async () => {
    const server = createBridgeServer(composeContracts(domain), [
      implementDomain(domain, { rpc: { wait: vi.fn(async () => undefined) } }),
    ]);
    server.attach(new FakeTarget());
    server.dispose();

    expect(() => server.attach(new FakeTarget())).toThrowError(
      expect.objectContaining({
        name: "BridgeProtocolError",
        code: "FORBIDDEN",
        message: "Bridge server is disposed.",
      }),
    );
    expect(server.handshake(sender(), "document-9")).toBeUndefined();
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
    expect(send).not.toHaveBeenCalled();
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
    const server = createBridgeServer(
      composeContracts(domain),
      [implementDomain(domain, { rpc: { wait: handler } })],
      { diagnostics: { record: (event) => records.push(event) } },
    );
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
    const server = createBridgeServer(composeContracts(domain), [
      implementDomain(domain, { rpc: { wait: handler } }),
    ]);
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
    const server = createBridgeServer(composeContracts(domain), [
      implementDomain(domain, { rpc: { wait: vi.fn(async () => undefined) } }),
    ]);
    server.attach(new FakeTarget());
    expect(server.handshake(sender(), "document-1")).toBeDefined();
    server.attach(new FakeTarget());

    expect(server.handshake(sender(), "document-1")).toBeUndefined();
    await expect(
      server.dispatchRpc(sender(), request("document-1", "request-1")),
    ).resolves.toMatchObject({ type: "error", error: { code: "FORBIDDEN" } });
  });
});
