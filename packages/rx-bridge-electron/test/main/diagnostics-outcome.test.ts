import { afterEach, describe, expect, test, vi } from "vitest";

import type {
  BridgeImpl,
  ErrorsFor,
  SchemasFor,
} from "../../src/contract/index.js";
import {
  createBridgeServer,
  type WireRpcRequest,
} from "../../src/main/index.js";
import type {
  Authorize,
  BridgeContext,
  BridgeDiagnostic,
  ResourceLimits,
  StreamBridgeServer,
} from "../../src/main/index.js";
import { FakeTarget, sender } from "./fake-ipc.js";

type HardwareBridge = {
  hardware: {
    rpc: {
      wait(): undefined;
      broken(): undefined;
      connect(): undefined;
    };
  };
};

const schemas: SchemasFor<HardwareBridge> = {
  hardware: {
    rpc: {
      broken: {
        output: {
          parse() {
            throw new Error("output invalid");
          },
        },
      },
    },
  },
};

const errors: ErrorsFor<HardwareBridge> = {
  hardware: { rpc: { connect: ["DEVICE_GONE"] } },
};

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

function setup(options: {
  handlers?: Partial<Record<"wait" | "broken" | "connect", Handler>>;
  authorize?: Authorize;
  resourceLimits?: Partial<ResourceLimits>;
}) {
  const diagnostics = { record: vi.fn<(event: BridgeDiagnostic) => void>() };
  const impl: BridgeImpl<HardwareBridge> = {
    hardware: {
      rpc: {
        wait: vi.fn(async () => undefined),
        broken: vi.fn(async () => undefined),
        connect: vi.fn(async () => undefined),
        ...options.handlers,
      },
    },
  };
  const server: StreamBridgeServer = createBridgeServer(impl, {
    schemas,
    errors,
    diagnostics,
    ...(options.authorize === undefined
      ? {}
      : { authorize: options.authorize }),
    ...(options.resourceLimits === undefined
      ? {}
      : { resourceLimits: options.resourceLimits }),
  });
  server.attach(new FakeTarget());
  return { server, diagnostics };
}

function finishedEvents(diagnostics: { record: ReturnType<typeof vi.fn> }) {
  return diagnostics.record.mock.calls
    .map(([event]) => event as BridgeDiagnostic)
    .filter(
      (event): event is Extract<BridgeDiagnostic, { type: "rpc-finished" }> =>
        event.type === "rpc-finished",
    );
}

function allEvents(diagnostics: { record: ReturnType<typeof vi.fn> }) {
  return diagnostics.record.mock.calls.map(
    ([event]) => event as BridgeDiagnostic,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("rpc-timed-out 기록", () => {
  test("deadline 만료 시 rpc-timed-out 1회, rpc-cancelled 0회, handler 종료 시 rpc-finished 1회를 순서대로 기록한다", async () => {
    vi.useFakeTimers();
    const controls: Array<(value: undefined) => void> = [];
    const { server, diagnostics } = setup({
      handlers: {
        wait: vi.fn(
          () => new Promise<undefined>((resolve) => controls.push(resolve)),
        ),
      },
      resourceLimits: { maxRpcDurationMs: 1000 },
    });
    const pending = server.dispatchRpc(sender(), request());
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({
      type: "error",
      error: { code: "DEADLINE_EXCEEDED" },
    });
    expect(allEvents(diagnostics)).toContainEqual({
      type: "rpc-timed-out",
      key: "rpc:hardware/wait",
    });
    expect(diagnostics.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "rpc-cancelled" }),
    );
    expect(finishedEvents(diagnostics)).toEqual([]);
    controls[0]?.(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(finishedEvents(diagnostics)).toEqual([
      {
        type: "rpc-finished",
        key: "rpc:hardware/wait",
        durationMs: expect.any(Number),
        outcome: "error",
      },
    ]);
    const timedOutIndex = allEvents(diagnostics).findIndex(
      (event) => event.type === "rpc-timed-out",
    );
    const finishedIndex = allEvents(diagnostics).findIndex(
      (event) => event.type === "rpc-finished",
    );
    expect(timedOutIndex).toBeGreaterThanOrEqual(0);
    expect(finishedIndex).toBeGreaterThan(timedOutIndex);
  });

  test("maxRpcDurationMs: Infinity면 rpc-timed-out을 기록하지 않는다", async () => {
    vi.useFakeTimers();
    const controls: Array<(value: undefined) => void> = [];
    const { server, diagnostics } = setup({
      handlers: {
        wait: vi.fn(
          () => new Promise<undefined>((resolve) => controls.push(resolve)),
        ),
      },
      resourceLimits: { maxRpcDurationMs: Number.POSITIVE_INFINITY },
    });
    const pending = server.dispatchRpc(sender(), request());
    await vi.advanceTimersByTimeAsync(10_000_000);
    controls[0]?.(undefined);
    await expect(pending).resolves.toMatchObject({ type: "success" });
    expect(diagnostics.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "rpc-timed-out" }),
    );
    expect(finishedEvents(diagnostics)).toEqual([
      {
        type: "rpc-finished",
        key: "rpc:hardware/wait",
        durationMs: expect.any(Number),
        outcome: "ok",
      },
    ]);
  });
});

describe("rpc-finished.outcome 판정", () => {
  test("성공 응답은 outcome: ok", async () => {
    const { server, diagnostics } = setup({});
    await expect(
      server.dispatchRpc(sender(), request()),
    ).resolves.toMatchObject({ type: "success" });
    expect(finishedEvents(diagnostics)).toEqual([
      expect.objectContaining({ outcome: "ok" }),
    ]);
  });

  test("선언된 도메인 에러는 outcome: error", async () => {
    const declared = Object.assign(new Error("device unavailable"), {
      code: "DEVICE_GONE",
    });
    const { server, diagnostics } = setup({
      handlers: {
        connect: vi.fn(async () => {
          throw declared;
        }),
      },
    });
    await expect(
      server.dispatchRpc(sender(), request({ key: "rpc:hardware/connect" })),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "DEVICE_GONE" },
    });
    expect(finishedEvents(diagnostics)).toEqual([
      expect.objectContaining({ outcome: "error" }),
    ]);
  });

  test("출력 검증 실패는 outcome: error", async () => {
    const { server, diagnostics } = setup({});
    await expect(
      server.dispatchRpc(sender(), request({ key: "rpc:hardware/broken" })),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "INTERNAL" },
    });
    expect(finishedEvents(diagnostics)).toEqual([
      expect.objectContaining({ outcome: "error" }),
    ]);
  });

  test("authorize가 false면 outcome: error", async () => {
    const { server, diagnostics } = setup({ authorize: () => false });
    await expect(
      server.dispatchRpc(sender(), request()),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "FORBIDDEN" },
    });
    expect(finishedEvents(diagnostics)).toEqual([
      expect.objectContaining({ outcome: "error" }),
    ]);
  });

  test("Renderer cancel은 outcome: error", async () => {
    const controls: Array<(value: undefined) => void> = [];
    const { server, diagnostics } = setup({
      handlers: {
        wait: vi.fn(
          () => new Promise<undefined>((resolve) => controls.push(resolve)),
        ),
      },
    });
    const pending = server.dispatchRpc(sender(), request());
    await vi.waitFor(() => expect(controls).toHaveLength(1));
    server.cancel(sender(), {
      protocolVersion: 1,
      clientId: "document-1",
      requestId: "request-1",
    });
    controls[0]?.(undefined);
    await expect(pending).resolves.toMatchObject({
      type: "error",
      error: { code: "CANCELLED" },
    });
    expect(finishedEvents(diagnostics)).toEqual([
      expect.objectContaining({ outcome: "error" }),
    ]);
  });

  test("authorize 예외는 INTERNAL 응답과 outcome: error이고 rejected는 기록하지 않는다", async () => {
    const { server, diagnostics } = setup({
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
    expect(finishedEvents(diagnostics)).toEqual([
      expect.objectContaining({ outcome: "error" }),
    ]);
    expect(diagnostics.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "rejected" }),
    );
  });
});
