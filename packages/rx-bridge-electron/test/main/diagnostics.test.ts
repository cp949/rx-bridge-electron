import { Subject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import type { BridgeImpl } from "../../src/contract/index.js";
import {
  createBridgeServer,
  type DiagnosticsSink,
  type WireRpcRequest,
} from "../../src/main/index.js";
import { broadcastEvent } from "../../src/main/sources.js";
import type {
  StreamMessage,
  WireStreamCommand,
} from "../../src/protocol/index.js";
import { FakeTarget, sender } from "./fake-ipc.js";
import { testSubscriptionId } from "./subscription-ids.js";

const throwingSink: DiagnosticsSink = {
  record() {
    throw new Error("sink boom");
  },
};

describe("recordDiagnostic exception isolation", () => {
  test("a throwing sink does not affect a successful RPC response", async () => {
    const handler = vi.fn(async () => undefined);
    const impl: BridgeImpl<{
      hardware: { rpc: { ping(): undefined } };
    }> = {
      hardware: { rpc: { ping: handler } },
    };
    const server = createBridgeServer(impl, { diagnostics: throwingSink });
    server.attach(new FakeTarget());
    const request: WireRpcRequest = {
      protocolVersion: 1,
      clientId: "document-1",
      requestId: "request-1",
      key: "rpc:hardware/ping",
      input: undefined,
    };
    await expect(server.dispatchRpc(sender(), request)).resolves.toMatchObject({
      type: "success",
    });
  });

  test("a throwing sink does not affect an RPC output validation failure", async () => {
    const handler = vi.fn(async () => undefined);
    const impl: BridgeImpl<{
      hardware: { rpc: { broken(): undefined } };
    }> = {
      hardware: { rpc: { broken: handler } },
    };
    const server = createBridgeServer(impl, {
      schemas: {
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
      },
      diagnostics: throwingSink,
    });
    server.attach(new FakeTarget());
    const request: WireRpcRequest = {
      protocolVersion: 1,
      clientId: "document-1",
      requestId: "request-1",
      key: "rpc:hardware/broken",
      input: undefined,
    };
    await expect(server.dispatchRpc(sender(), request)).resolves.toMatchObject({
      type: "error",
      error: { code: "INTERNAL" },
    });
  });

  test("a throwing sink does not affect a renderer cancel", async () => {
    const controls: Array<(input: undefined) => void> = [];
    const handler = vi.fn(
      () => new Promise<undefined>((resolve) => controls.push(resolve)),
    );
    const impl: BridgeImpl<{
      hardware: { rpc: { wait(): undefined } };
    }> = {
      hardware: { rpc: { wait: handler } },
    };
    const server = createBridgeServer(impl, { diagnostics: throwingSink });
    server.attach(new FakeTarget());
    const request: WireRpcRequest = {
      protocolVersion: 1,
      clientId: "document-1",
      requestId: "request-1",
      key: "rpc:hardware/wait",
      input: undefined,
    };
    const pending = server.dispatchRpc(sender(), request);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
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
  });

  test("a throwing sink does not affect an event drop-oldest overflow", async () => {
    const events = new Subject<number>();
    const impl: BridgeImpl<{
      hardware: { event: { change$: number } };
    }> = {
      hardware: {
        event: {
          change$: broadcastEvent(events, {
            buffer: { capacity: 2, overflow: "drop-oldest" },
          }),
        },
      },
    };
    const server = createBridgeServer(impl, { diagnostics: throwingSink });
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => messages.push(message);
    const command: Extract<WireStreamCommand, { type: "subscribe" }> = {
      protocolVersion: 1,
      clientId: "client-1",
      type: "subscribe",
      subscriptionId: testSubscriptionId(1),
      key: "event:hardware/change$",
    };
    await server.controlStream(sender(), command, send);
    events.next(1);
    events.next(2);
    events.next(3);
    expect(
      messages.some(
        (message) => message.type === "batch" && message.values[0] === 1,
      ),
    ).toBe(true);
  });
});
