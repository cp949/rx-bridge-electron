import { BehaviorSubject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import type {
  BridgeImpl,
  Schema,
  SchemasFor,
} from "../../src/contract/index.js";
import {
  createBridgeServer,
  type Authorize,
  type BridgeDiagnostic,
  type ResourceLimits,
  type WireRpcRequest,
} from "../../src/main/index.js";
import { currentValueSource } from "../../src/main/sources.js";
import type { WireStreamCommand } from "../../src/protocol/index.js";
import { FakeTarget, handshakeRequest, sender } from "./fake-ipc.js";
import { testSubscriptionId } from "./subscription-ids.js";

type HardwareBridge = {
  hardware: {
    rpc: { connect(input: { readonly id: string }): { readonly id: string } };
    state: { current$: number };
  };
};

const objectSchema: Schema<{ readonly id: string }> = {
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

const schemas: SchemasFor<HardwareBridge> = {
  hardware: { rpc: { connect: { input: objectSchema } } },
};

function setup(options: {
  readonly authorize?: Authorize;
  readonly resourceLimits?: Partial<ResourceLimits>;
  readonly payloadLimits?: {
    readonly maxDepth: number;
    readonly maxEntries: number;
    readonly maxStringBytes: number;
    readonly maxTotalBytes?: number;
  };
  readonly handler?: (input: {
    readonly id: string;
  }) => Promise<{ readonly id: string }>;
}) {
  const diagnostics = { record: vi.fn<(event: BridgeDiagnostic) => void>() };
  const handler = options.handler ?? (async (input) => input);
  const impl: BridgeImpl<HardwareBridge> = {
    hardware: {
      rpc: { connect: handler },
      state: { current$: currentValueSource(new BehaviorSubject(1)) },
    },
  };
  const server = createBridgeServer(impl, {
    schemas,
    ...(options.payloadLimits === undefined
      ? {}
      : { payloadLimits: options.payloadLimits }),
    ...(options.authorize === undefined
      ? {}
      : { authorize: options.authorize }),
    diagnostics,
    ...(options.resourceLimits === undefined
      ? {}
      : { resourceLimits: options.resourceLimits }),
  });
  const target = new FakeTarget();
  server.attach(target);
  return { server, diagnostics, target };
}

const rpcRequest = (
  overrides: Partial<WireRpcRequest> = {},
): WireRpcRequest => ({
  protocolVersion: 1,
  clientId: "document-1",
  requestId: "request-1",
  key: "rpc:hardware/connect",
  input: { id: "device-1" },
  ...overrides,
});

const subscribeCommand = (
  overrides: Partial<Extract<WireStreamCommand, { type: "subscribe" }>> = {},
): Extract<WireStreamCommand, { type: "subscribe" }> => ({
  protocolVersion: 1,
  clientId: "client-1",
  type: "subscribe",
  subscriptionId: testSubscriptionId(1),
  key: "state:hardware/current$",
  ...overrides,
});

const rejections = (diagnostics: {
  record: ReturnType<typeof vi.fn<(event: BridgeDiagnostic) => void>>;
}) =>
  diagnostics.record.mock.calls
    .map(([event]) => event)
    .filter(
      (event): event is Extract<BridgeDiagnostic, { type: "rejected" }> =>
        event.type === "rejected",
    );

describe("rejected diagnostic reasons", () => {
  test("RPC sender-unauthorized: unattached webContents", async () => {
    const { server, diagnostics } = setup({});
    await server.dispatchRpc(sender({ webContentsId: 99 }), rpcRequest());
    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "sender-unauthorized" },
    ]);
  });

  test("stream sender-unauthorized: unsubscribe with no session", async () => {
    const { server, diagnostics } = setup({});
    await server.controlStream(
      sender({ webContentsId: 99 }),
      {
        protocolVersion: 1,
        clientId: "client-1",
        type: "unsubscribe",
        subscriptionId: testSubscriptionId(1),
      },
      () => {},
    );
    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "sender-unauthorized" },
    ]);
  });

  test("RPC authorize-denied includes the registered key", async () => {
    const { server, diagnostics } = setup({ authorize: () => false });
    await server.dispatchRpc(sender(), rpcRequest());
    expect(rejections(diagnostics)).toEqual([
      {
        type: "rejected",
        reason: "authorize-denied",
        key: "rpc:hardware/connect",
      },
    ]);
  });

  test("stream authorize-denied includes the registered key", async () => {
    const { server, diagnostics } = setup({ authorize: () => false });
    await server.controlStream(sender(), subscribeCommand(), () => {});
    expect(rejections(diagnostics)).toEqual([
      {
        type: "rejected",
        reason: "authorize-denied",
        key: "state:hardware/current$",
      },
    ]);
  });

  test("stream unknown-operation NOT_FOUND regardless of authorize decision (deny)", async () => {
    const authorize = vi.fn(() => false);
    const { server, diagnostics } = setup({ authorize });
    const messages: unknown[] = [];
    await server.controlStream(
      sender(),
      subscribeCommand({ key: "state:hardware/missing$" }),
      (message) => messages.push(message),
    );
    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "unknown-operation" },
    ]);
    expect(authorize).not.toHaveBeenCalled();
    expect(messages).toEqual([
      expect.objectContaining({ type: "subscribed" }),
      expect.objectContaining({
        type: "error",
        error: { code: "NOT_FOUND", message: "Unknown bridge stream." },
      }),
    ]);
  });

  test("stream unknown-operation NOT_FOUND regardless of authorize decision (allow)", async () => {
    const authorize = vi.fn(() => true);
    const { server, diagnostics } = setup({ authorize });
    const messages: unknown[] = [];
    await server.controlStream(
      sender(),
      subscribeCommand({ key: "state:hardware/missing$" }),
      (message) => messages.push(message),
    );
    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "unknown-operation" },
    ]);
    expect(authorize).not.toHaveBeenCalled();
    expect(messages).toEqual([
      expect.objectContaining({ type: "subscribed" }),
      expect.objectContaining({
        type: "error",
        error: { code: "NOT_FOUND", message: "Unknown bridge stream." },
      }),
    ]);
  });

  test("stream authorize() exception is not recorded and returns INTERNAL", async () => {
    const { server, diagnostics } = setup({
      authorize: () => {
        throw new Error("authorize boom");
      },
    });
    const messages: unknown[] = [];
    await server.controlStream(sender(), subscribeCommand(), (message) =>
      messages.push(message),
    );
    expect(rejections(diagnostics)).toEqual([]);
    expect(messages).toEqual([
      expect.objectContaining({ type: "subscribed" }),
      expect.objectContaining({
        type: "error",
        error: { code: "INTERNAL", message: "Internal bridge error." },
      }),
    ]);
  });

  test("RPC version-mismatch", async () => {
    const { server, diagnostics } = setup({});
    await server.dispatchRpc(sender(), rpcRequest({ protocolVersion: 2 as 1 }));
    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "version-mismatch" },
    ]);
  });

  test("stream version-mismatch", async () => {
    const { server, diagnostics } = setup({});
    await server.controlStream(
      sender(),
      subscribeCommand({ protocolVersion: 2 as 1 }),
      () => {},
    );
    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "version-mismatch" },
    ]);
  });

  test("RPC unknown-operation", async () => {
    const { server, diagnostics } = setup({});
    await server.dispatchRpc(
      sender(),
      rpcRequest({ key: "rpc:hardware/missing" }),
    );
    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "unknown-operation" },
    ]);
  });

  test("stream unknown-operation", async () => {
    const { server, diagnostics } = setup({});
    await server.controlStream(
      sender(),
      subscribeCommand({ key: "state:hardware/missing$" }),
      () => {},
    );
    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "unknown-operation" },
    ]);
  });

  test("stream invalid-input: malformed subscriptionId", async () => {
    const { server, diagnostics } = setup({});
    await server.controlStream(
      sender(),
      subscribeCommand({ subscriptionId: "not-a-valid-id" }),
      () => {},
    );
    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "invalid-input" },
    ]);
  });

  test("RPC invalid-input: schema rejects the parsed value", async () => {
    const { server, diagnostics } = setup({});
    await server.dispatchRpc(sender(), rpcRequest({ input: { id: 42 } }));
    expect(rejections(diagnostics)).toEqual([
      {
        type: "rejected",
        reason: "invalid-input",
        key: "rpc:hardware/connect",
      },
    ]);
  });

  test("RPC payload-too-large: maxTotalBytes exceeded", async () => {
    const { server, diagnostics } = setup({
      payloadLimits: {
        maxDepth: 8,
        maxEntries: 100,
        maxStringBytes: 2048,
        maxTotalBytes: 64,
      },
    });
    await server.dispatchRpc(
      sender(),
      rpcRequest({ input: { id: "x".repeat(200) } }),
    );
    expect(rejections(diagnostics)).toEqual([
      {
        type: "rejected",
        reason: "payload-too-large",
        key: "rpc:hardware/connect",
      },
    ]);
  });

  test("RPC payload-too-large: maxStringBytes exceeded", async () => {
    const { server, diagnostics } = setup({
      payloadLimits: { maxDepth: 8, maxEntries: 100, maxStringBytes: 8 },
    });
    await server.dispatchRpc(
      sender(),
      rpcRequest({ input: { id: "x".repeat(200) } }),
    );
    expect(rejections(diagnostics)).toEqual([
      {
        type: "rejected",
        reason: "payload-too-large",
        key: "rpc:hardware/connect",
      },
    ]);
  });

  test("RPC payload-too-large: maxDepth exceeded", async () => {
    const { server, diagnostics } = setup({
      payloadLimits: { maxDepth: 1, maxEntries: 100, maxStringBytes: 2048 },
    });
    await server.dispatchRpc(
      sender(),
      rpcRequest({ input: { id: { nested: "device-1" } } as never }),
    );
    expect(rejections(diagnostics)).toEqual([
      {
        type: "rejected",
        reason: "payload-too-large",
        key: "rpc:hardware/connect",
      },
    ]);
  });

  test("RPC payload-too-large: maxEntries exceeded", async () => {
    const { server, diagnostics } = setup({
      payloadLimits: { maxDepth: 8, maxEntries: 1, maxStringBytes: 2048 },
    });
    await server.dispatchRpc(
      sender(),
      rpcRequest({ input: { id: "device-1", extra: "x" } as never }),
    );
    expect(rejections(diagnostics)).toEqual([
      {
        type: "rejected",
        reason: "payload-too-large",
        key: "rpc:hardware/connect",
      },
    ]);
  });

  test("RPC malformed-envelope for a structural error, not payload-too-large", async () => {
    // server가 envelope parse(input 포함)를 admission보다 먼저 하므로(결정 7),
    // 구조 오류 input은 등록 조회 전에 malformed-envelope로 거부된다(key 없음,
    // checklist F1).
    const { server, diagnostics } = setup({});
    await server.dispatchRpc(
      sender(),
      rpcRequest({ input: { id: Symbol("bad") } as never }),
    );
    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "malformed-envelope" },
    ]);
  });

  test("RPC rpc-limit includes the registered key", async () => {
    const controls: Array<() => void> = [];
    const { server, diagnostics } = setup({
      resourceLimits: { maxConcurrentRpc: 1 },
      handler: () =>
        new Promise((resolve) =>
          controls.push(() => resolve({ id: "device-1" })),
        ),
    });
    const first = server.dispatchRpc(sender(), rpcRequest({ requestId: "r1" }));
    await vi.waitFor(() => expect(controls).toHaveLength(1));
    await server.dispatchRpc(sender(), rpcRequest({ requestId: "r2" }));
    controls[0]?.();
    await first;
    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "rpc-limit", key: "rpc:hardware/connect" },
    ]);
  });

  test("stream subscription-limit includes the key", async () => {
    const { server, diagnostics } = setup({
      resourceLimits: { maxSubscriptions: 1 },
    });
    await server.controlStream(
      sender(),
      subscribeCommand({ subscriptionId: testSubscriptionId(1) }),
      () => {},
    );
    await server.controlStream(
      sender(),
      subscribeCommand({ subscriptionId: testSubscriptionId(2) }),
      () => {},
    );
    expect(rejections(diagnostics)).toEqual([
      {
        type: "rejected",
        reason: "subscription-limit",
        key: "state:hardware/current$",
      },
    ]);
  });

  test("unregistered stream key rejection does not occupy a slot", async () => {
    const { server, diagnostics } = setup({
      resourceLimits: { maxSubscriptions: 1 },
    });
    await server.controlStream(
      sender(),
      subscribeCommand({
        subscriptionId: testSubscriptionId(1),
        key: "state:hardware/missing$",
      }),
      () => {},
    );
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
    const send = vi.fn();
    await server.controlStream(
      sender(),
      subscribeCommand({ subscriptionId: testSubscriptionId(2) }),
      send,
    );
    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "unknown-operation" },
    ]);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "subscribed" }),
    );
  });

  test("unregistered stream key still advances the watermark", async () => {
    const { server, diagnostics } = setup({});
    const first = vi.fn();
    await server.controlStream(
      sender(),
      subscribeCommand({
        subscriptionId: testSubscriptionId(1),
        key: "state:hardware/missing$",
      }),
      first,
    );
    const second = vi.fn();
    await server.controlStream(
      sender(),
      subscribeCommand({ subscriptionId: testSubscriptionId(1) }),
      second,
    );
    expect(second).not.toHaveBeenCalled();
    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "unknown-operation" },
    ]);
  });

  test("duplicate subscribe below the watermark records no rejection", async () => {
    const { server, diagnostics } = setup({});
    const send = vi.fn();
    await server.controlStream(sender(), subscribeCommand(), send);
    await server.controlStream(sender(), subscribeCommand(), send);
    expect(rejections(diagnostics)).toEqual([]);
  });

  test("RPC sender-unauthorized: retired clientId", async () => {
    const { server, diagnostics } = setup({});
    await server.dispatchRpc(sender(), rpcRequest({ clientId: "document-1" }));
    await server.dispatchRpc(sender(), rpcRequest({ clientId: "document-2" }));
    const response = await server.dispatchRpc(
      sender(),
      rpcRequest({ clientId: "document-1", requestId: "request-3" }),
    );
    expect(response).toMatchObject({
      type: "error",
      error: { code: "FORBIDDEN" },
    });
    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "sender-unauthorized" },
    ]);
  });

  test("RPC sender-unauthorized: server disposed", async () => {
    const { server, diagnostics } = setup({});
    server.dispose();
    await server.dispatchRpc(sender(), rpcRequest());
    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "sender-unauthorized" },
    ]);
  });

  test("cancel sender-unauthorized: no session established", () => {
    const { server, diagnostics } = setup({});
    server.cancel(sender(), {
      protocolVersion: 1,
      clientId: "document-1",
      requestId: "request-1",
    });
    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "sender-unauthorized" },
    ]);
  });
});

// frame·origin 불일치는 채널과 무관하게 같은 사유를 낸다(DocumentSessions#admit이
// 하나의 판정을 모든 채널에 공급한다). cancel도 다른 채널과 같은 verdict로 거부를
// 기록한다(전에는 조용히 무시했다) — 위 "cancel sender-unauthorized" test와 별개로,
// frame·origin 불일치가 cancel에서도 기록되는지 여기서 함께 검증한다.
describe.each([
  ["frame-not-main" as const, sender({ isMainFrame: false })],
  ["origin-not-allowed" as const, sender({ origin: "https://evil.example" })],
])("channel-independent reason: %s", (reason, badSender) => {
  test("RPC", async () => {
    const { server, diagnostics } = setup({});
    const response = await server.dispatchRpc(badSender, rpcRequest());
    expect(response).toEqual({
      protocolVersion: 1,
      clientId: rpcRequest().clientId,
      requestId: rpcRequest().requestId,
      type: "error",
      error: { code: "FORBIDDEN", message: "Bridge sender is not authorized." },
    });
    expect(rejections(diagnostics)).toEqual([{ type: "rejected", reason }]);
  });

  test("subscribe", async () => {
    const { server, diagnostics } = setup({});
    await server.controlStream(badSender, subscribeCommand(), () => {});
    expect(rejections(diagnostics)).toEqual([{ type: "rejected", reason }]);
  });

  test("unsubscribe", async () => {
    const { server, diagnostics } = setup({});
    await server.controlStream(sender(), subscribeCommand(), () => {});
    await server.controlStream(
      badSender,
      {
        protocolVersion: 1,
        clientId: "client-1",
        type: "unsubscribe",
        subscriptionId: testSubscriptionId(1),
      },
      () => {},
    );
    expect(rejections(diagnostics)).toEqual([{ type: "rejected", reason }]);
  });

  test("acknowledge", async () => {
    const { server, diagnostics } = setup({});
    await server.controlStream(sender(), subscribeCommand(), () => {});
    await server.controlStream(
      badSender,
      {
        protocolVersion: 1,
        clientId: "client-1",
        type: "acknowledge",
        subscriptionId: testSubscriptionId(1),
        sequence: 0,
      },
      () => {},
    );
    expect(rejections(diagnostics)).toEqual([{ type: "rejected", reason }]);
  });

  test("cancel", async () => {
    const { server, diagnostics } = setup({});
    await server.dispatchRpc(sender(), rpcRequest());
    server.cancel(badSender, {
      protocolVersion: 1,
      clientId: "document-1",
      requestId: "request-1",
    });
    expect(rejections(diagnostics)).toEqual([{ type: "rejected", reason }]);
  });

  test("server handshake", () => {
    const { server, diagnostics } = setup({});
    expect(
      server.handshake(badSender, handshakeRequest("client-1")),
    ).toMatchObject({ type: "error" });
    expect(rejections(diagnostics)).toEqual([{ type: "rejected", reason }]);
  });
});

// frame 교체(같은 webContentsId, 다른 frameId — 예: 페이지 탐색)를
// characterization으로 고정한다. 옛 clientId는 탐색으로 즉시 retire되어
// 그 자체로 거부되므로, frame 검사만 관측하려면 새 clientId를 써야 한다.
// DELTA-02에서 frame 불일치가 `frame-not-main`으로 분리됐다(DELTA-01
// 시점에는 `sender-unauthorized`였다).
describe("frame replacement (characterization)", () => {
  test("frame 교체 뒤 옛 frameId로 새 clientId를 보내면 거부된다", async () => {
    const handler = vi.fn(async (input: { readonly id: string }) => input);
    const { server, diagnostics, target } = setup({ handler });
    const first = await server.dispatchRpc(sender(), rpcRequest());
    expect(first).toMatchObject({ type: "success" });

    target.replaceMainFrame(11);

    const second = await server.dispatchRpc(
      sender({ frameId: 10 }),
      rpcRequest({ clientId: "document-2", requestId: "request-2" }),
    );
    expect(second).toEqual({
      protocolVersion: 1,
      clientId: "document-2",
      requestId: "request-2",
      type: "error",
      error: { code: "FORBIDDEN", message: "Bridge sender is not authorized." },
    });
    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "frame-not-main" },
    ]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("frame 교체 뒤 새 frameId의 새 clientId는 세션을 연다", async () => {
    const handler = vi.fn(async (input: { readonly id: string }) => input);
    const { server, diagnostics, target } = setup({ handler });
    await server.dispatchRpc(sender(), rpcRequest());

    target.replaceMainFrame(11);

    const second = await server.dispatchRpc(
      sender({ frameId: 11 }),
      rpcRequest({ clientId: "document-2", requestId: "request-2" }),
    );
    expect(second).toMatchObject({ type: "success" });
    expect(rejections(diagnostics)).toEqual([]);
    expect(handler).toHaveBeenCalledTimes(2);
    const sessionOpenedCount = diagnostics.record.mock.calls.filter(
      ([event]) => event.type === "session-opened",
    ).length;
    expect(sessionOpenedCount).toBe(2);
  });
});
