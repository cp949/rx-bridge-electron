import { BehaviorSubject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import type { BridgeImpl, Schema, SchemasFor } from "../../src/contract/index.js";
import {
  createBridgeServer,
  type Authorize,
  type BridgeDiagnostic,
  type ResourceLimits,
  type WireRpcRequest,
} from "../../src/main/index.js";
import { currentValueSource } from "../../src/main/sources.js";
import type { WireStreamCommand } from "../../src/protocol/index.js";
import { FakeTarget, sender } from "./fake-ipc.js";
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
    ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
    diagnostics,
    ...(options.resourceLimits === undefined
      ? {}
      : { resourceLimits: options.resourceLimits }),
  });
  server.attach(new FakeTarget());
  return { server, diagnostics };
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

  test("stream authorize-denied omits the key for an unregistered stream", async () => {
    const { server, diagnostics } = setup({ authorize: () => false });
    await server.controlStream(
      sender(),
      subscribeCommand({ key: "state:hardware/missing$" }),
      () => {},
    );
    expect(rejections(diagnostics)).toEqual([
      { type: "rejected", reason: "authorize-denied" },
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

  test("RPC invalid-input for a structural error, not payload-too-large", async () => {
    const { server, diagnostics } = setup({});
    await server.dispatchRpc(
      sender(),
      rpcRequest({ input: { id: Symbol("bad") } as never }),
    );
    expect(rejections(diagnostics)).toEqual([
      {
        type: "rejected",
        reason: "invalid-input",
        key: "rpc:hardware/connect",
      },
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

  test("stream subscription-limit omits the key", async () => {
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
      { type: "rejected", reason: "subscription-limit" },
    ]);
  });

  test("duplicate subscribe below the watermark records no rejection", async () => {
    const { server, diagnostics } = setup({});
    const send = vi.fn();
    await server.controlStream(sender(), subscribeCommand(), send);
    await server.controlStream(sender(), subscribeCommand(), send);
    expect(rejections(diagnostics)).toEqual([]);
  });
});
