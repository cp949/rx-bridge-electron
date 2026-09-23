import { afterEach, describe, expect, test, vi } from "vitest";

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
  ResourceLimits,
  StreamBridgeServer,
} from "../../src/main/index.js";
import { FakeTarget, sender } from "./fake-ipc.js";

const value: Schema<undefined> = { parse: () => undefined };
const domain = defineDomain("hardware", {
  rpc: { wait: rpc({ input: value, output: value }) },
});

const request = (overrides: Partial<WireRpcRequest> = {}): WireRpcRequest => ({
  protocolVersion: 1,
  clientId: "document-1",
  requestId: "request-1",
  key: "rpc:hardware/wait",
  input: undefined,
  ...overrides,
});

type Handler = (
  input: undefined,
  context: BridgeContext,
) => Promise<undefined> | undefined;

function pendingHandler() {
  const controls: Array<(value: undefined) => void> = [];
  const contexts: BridgeContext[] = [];
  const handler = vi.fn((_input: BridgeValue, context: BridgeContext) => {
    contexts.push(context);
    return new Promise<undefined>((resolve) => controls.push(resolve));
  });
  return {
    handler,
    contexts,
    resolve: (index: number) => controls[index]?.(undefined),
  };
}

function setup(
  options: {
    handler?: Handler;
    authorize?: Authorize;
    resourceLimits?: Partial<ResourceLimits>;
    diagnostics?: {
      record: ReturnType<typeof vi.fn<(event: BridgeDiagnostic) => void>>;
    };
  } = {},
) {
  const handler = options.handler ?? vi.fn(async () => undefined);
  const implementation = implementDomain(domain, { rpc: { wait: handler } });
  const server: StreamBridgeServer = createBridgeServer(
    composeContracts(domain),
    [implementation],
    {
      ...(options.authorize === undefined
        ? {}
        : { authorize: options.authorize }),
      ...(options.resourceLimits === undefined
        ? {}
        : { resourceLimits: options.resourceLimits }),
      ...(options.diagnostics === undefined
        ? {}
        : { diagnostics: options.diagnostics }),
    },
  );
  server.attach(new FakeTarget());
  return { handler, server };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("세션별 RPC 동시성 한도", () => {
  test("maxConcurrentRpc 도달 시 다음 RPC는 즉시 RESOURCE_EXHAUSTED다", async () => {
    const { handler, resolve } = pendingHandler();
    const authorize = vi.fn(() => true);
    const { server } = setup({
      handler,
      authorize,
      resourceLimits: { maxConcurrentRpc: 2 },
    });
    const p1 = server.dispatchRpc(sender(), request({ requestId: "r1" }));
    const p2 = server.dispatchRpc(sender(), request({ requestId: "r2" }));
    await expect(
      server.dispatchRpc(sender(), request({ requestId: "r3" })),
    ).resolves.toMatchObject({
      type: "error",
      error: {
        code: "RESOURCE_EXHAUSTED",
        message: "Too many concurrent bridge requests.",
      },
    });
    resolve(0);
    resolve(1);
    await expect(p1).resolves.toMatchObject({ type: "success" });
    await expect(p2).resolves.toMatchObject({ type: "success" });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  test("첫 handler가 끝나면 슬롯이 반환돼 다음 요청이 수락된다", async () => {
    const { handler, resolve } = pendingHandler();
    const { server } = setup({
      handler,
      resourceLimits: { maxConcurrentRpc: 2 },
    });
    const p1 = server.dispatchRpc(sender(), request({ requestId: "r1" }));
    server.dispatchRpc(sender(), request({ requestId: "r2" }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    await expect(
      server.dispatchRpc(sender(), request({ requestId: "r3" })),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "RESOURCE_EXHAUSTED" },
    });
    resolve(0);
    await expect(p1).resolves.toMatchObject({ type: "success" });
    const p4 = server.dispatchRpc(sender(), request({ requestId: "r4" }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(3));
    resolve(2);
    await expect(p4).resolves.toMatchObject({ type: "success" });
  });

  test("signal을 무시하는 handler는 취소 후에도 실제로 끝날 때까지 슬롯을 점유한다", async () => {
    const { handler, resolve } = pendingHandler();
    const { server } = setup({
      handler,
      resourceLimits: { maxConcurrentRpc: 2 },
    });
    const p1 = server.dispatchRpc(sender(), request({ requestId: "r1" }));
    const p2 = server.dispatchRpc(sender(), request({ requestId: "r2" }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    server.cancel(sender(), {
      protocolVersion: 1,
      clientId: "document-1",
      requestId: "r1",
    });
    server.cancel(sender(), {
      protocolVersion: 1,
      clientId: "document-1",
      requestId: "r2",
    });
    await expect(
      server.dispatchRpc(sender(), request({ requestId: "r3" })),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "RESOURCE_EXHAUSTED" },
    });
    resolve(0);
    resolve(1);
    await expect(p1).resolves.toMatchObject({
      type: "error",
      error: { code: "CANCELLED" },
    });
    await expect(p2).resolves.toMatchObject({
      type: "error",
      error: { code: "CANCELLED" },
    });
    const p4 = server.dispatchRpc(sender(), request({ requestId: "r4" }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(3));
    resolve(2);
    await expect(p4).resolves.toMatchObject({ type: "success" });
  });

  test("authorize가 pending인 동안에도 슬롯을 점유한다", async () => {
    let allow!: (value: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const authorize = vi.fn(() => authorization);
    const handler = vi.fn(async () => undefined);
    const { server } = setup({
      handler,
      authorize,
      resourceLimits: { maxConcurrentRpc: 1 },
    });
    const p1 = server.dispatchRpc(sender(), request({ requestId: "r1" }));
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    await expect(
      server.dispatchRpc(sender(), request({ requestId: "r2" })),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "RESOURCE_EXHAUSTED" },
    });
    allow(true);
    await expect(p1).resolves.toMatchObject({ type: "success" });
    expect(handler).toHaveBeenCalledOnce();
  });

  test("세션 격리: A가 동시성 한도를 소진해도 B는 정상 처리된다", async () => {
    const controls: Array<(value: undefined) => void> = [];
    const handler = vi.fn((_input: BridgeValue, context: BridgeContext) => {
      if (context.sender.webContentsId === 1)
        return new Promise<undefined>((resolve) => controls.push(resolve));
      return Promise.resolve(undefined);
    });
    const { server } = setup({
      handler,
      resourceLimits: { maxConcurrentRpc: 1 },
    });
    server.attach(new FakeTarget(2, "main"));
    const pA1 = server.dispatchRpc(sender(), request({ requestId: "a1" }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await expect(
      server.dispatchRpc(sender(), request({ requestId: "a2" })),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "RESOURCE_EXHAUSTED" },
    });
    await expect(
      server.dispatchRpc(
        sender({ webContentsId: 2 }),
        request({ requestId: "b1" }),
      ),
    ).resolves.toMatchObject({ type: "success" });
    controls[0]?.(undefined);
    await expect(pA1).resolves.toMatchObject({ type: "success" });
  });

  test("같은 requestId 재전송이 한도 초과로 거부돼도 기존 작업의 signal은 그대로다", async () => {
    const { handler, contexts } = pendingHandler();
    const { server } = setup({
      handler,
      resourceLimits: { maxConcurrentRpc: 1 },
    });
    server.dispatchRpc(sender(), request({ requestId: "r1" }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await expect(
      server.dispatchRpc(sender(), request({ requestId: "r1" })),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "RESOURCE_EXHAUSTED" },
    });
    expect(contexts[0]?.signal.aborted).toBe(false);
  });
});

describe("Main RPC deadline", () => {
  test("maxRpcDurationMs 경과 시 DEADLINE_EXCEEDED로 응답하고 handler signal을 abort한다", async () => {
    vi.useFakeTimers();
    const { handler, contexts, resolve } = pendingHandler();
    const { server } = setup({
      handler,
      resourceLimits: { maxConcurrentRpc: 1, maxRpcDurationMs: 1000 },
    });
    const p1 = server.dispatchRpc(sender(), request({ requestId: "r1" }));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p1).resolves.toMatchObject({
      type: "error",
      error: {
        code: "DEADLINE_EXCEEDED",
        message: "Request exceeded the server deadline.",
      },
    });
    expect(contexts[0]?.signal.aborted).toBe(true);
    await expect(
      server.dispatchRpc(sender(), request({ requestId: "r2" })),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "RESOURCE_EXHAUSTED" },
    });
    resolve(0);
    await vi.advanceTimersByTimeAsync(0);
    const p3 = server.dispatchRpc(sender(), request({ requestId: "r3" }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    resolve(1);
    await expect(p3).resolves.toMatchObject({ type: "success" });
  });

  test("authorize가 pending인 채로 deadline이 지나면 DEADLINE_EXCEEDED다", async () => {
    vi.useFakeTimers();
    const authorization = new Promise<boolean>(() => {});
    const authorize = vi.fn(() => authorization);
    const handler = vi.fn(async () => undefined);
    const { server } = setup({
      handler,
      authorize,
      resourceLimits: { maxRpcDurationMs: 1000 },
    });
    const p1 = server.dispatchRpc(sender(), request());
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p1).resolves.toMatchObject({
      type: "error",
      error: { code: "DEADLINE_EXCEEDED" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test("deadline 전에 handler가 끝나면 정상 결과이고 타이머가 남지 않는다", async () => {
    vi.useFakeTimers();
    const handler = vi.fn(async () => undefined);
    const { server } = setup({
      handler,
      resourceLimits: { maxRpcDurationMs: 1000 },
    });
    const p1 = server.dispatchRpc(sender(), request());
    await expect(p1).resolves.toMatchObject({ type: "success" });
    expect(vi.getTimerCount()).toBe(0);
  });

  test("maxRpcDurationMs: Infinity면 타이머를 걸지 않고 deadline도 없다", async () => {
    vi.useFakeTimers();
    const { handler, resolve } = pendingHandler();
    const { server } = setup({
      handler,
      resourceLimits: { maxRpcDurationMs: Number.POSITIVE_INFINITY },
    });
    const p1 = server.dispatchRpc(sender(), request());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(vi.getTimerCount()).toBe(0);
    resolve(0);
    await expect(p1).resolves.toMatchObject({ type: "success" });
  });

  test("rpc-finished 진단은 handler가 실제로 끝날 때 한 번만 기록된다", async () => {
    vi.useFakeTimers();
    const { handler, resolve } = pendingHandler();
    const diagnostics = { record: vi.fn<(event: BridgeDiagnostic) => void>() };
    const { server } = setup({
      handler,
      diagnostics,
      resourceLimits: { maxRpcDurationMs: 1000 },
    });
    const p1 = server.dispatchRpc(sender(), request());
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p1).resolves.toMatchObject({
      type: "error",
      error: { code: "DEADLINE_EXCEEDED" },
    });
    expect(diagnostics.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "rpc-finished" }),
    );
    resolve(0);
    await vi.advanceTimersByTimeAsync(0);
    const finished = diagnostics.record.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "rpc-finished");
    expect(finished).toEqual([
      {
        type: "rpc-finished",
        key: "rpc:hardware/wait",
        durationMs: expect.any(Number),
        outcome: "error",
      },
    ]);
  });
});

describe("RPC authorize 예외", () => {
  test("authorize가 동기로 던지면 INTERNAL로 응답하고 handler를 호출하지 않는다", async () => {
    const handler = vi.fn(async () => undefined);
    const { server } = setup({
      handler,
      authorize: () => {
        throw new Error("authorize boom");
      },
    });
    await expect(
      server.dispatchRpc(sender(), request()),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test("authorize가 reject하면 INTERNAL로 응답한다", async () => {
    const { server } = setup({
      authorize: () => Promise.reject(new Error("authorize boom")),
    });
    await expect(
      server.dispatchRpc(sender(), request()),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
  });

  test("취소된 뒤 authorize가 reject하면 CANCELLED가 우선한다", async () => {
    let fail!: (cause: unknown) => void;
    const authorize = vi.fn(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const { server } = setup({ authorize });
    const p1 = server.dispatchRpc(sender(), request());
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    server.cancel(sender(), {
      protocolVersion: 1,
      clientId: "document-1",
      requestId: "request-1",
    });
    fail(new Error("authorize boom"));
    await expect(p1).resolves.toMatchObject({
      type: "error",
      error: { code: "CANCELLED" },
    });
  });

  test("authorize 예외 뒤 RPC 슬롯이 반환된다", async () => {
    let calls = 0;
    const { server } = setup({
      resourceLimits: { maxConcurrentRpc: 1 },
      authorize: () => {
        if (calls++ === 0) throw new Error("authorize boom");
        return true;
      },
    });
    await expect(
      server.dispatchRpc(sender(), request({ requestId: "r1" })),
    ).resolves.toMatchObject({ type: "error", error: { code: "INTERNAL" } });
    await expect(
      server.dispatchRpc(sender(), request({ requestId: "r2" })),
    ).resolves.toMatchObject({ type: "success" });
  });

  test("Main deadline이 걸린 상태에서도 authorize 예외는 INTERNAL이다", async () => {
    const { server } = setup({
      resourceLimits: { maxRpcDurationMs: 1000 },
      authorize: () => {
        throw new Error("authorize boom");
      },
    });
    await expect(
      server.dispatchRpc(sender(), request()),
    ).resolves.toMatchObject({ type: "error", error: { code: "INTERNAL" } });
  });
});
