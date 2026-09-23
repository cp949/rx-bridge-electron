import { Subject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import {
  composeContracts,
  defineDomain,
  event,
  rpc,
  type Schema,
} from "../../src/contract/index.js";
import {
  createBridgeServer,
  implementDomain,
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

const value: Schema<undefined> = { parse: () => undefined };
const badOutput: Schema<undefined> = {
  parse: () => {
    throw new Error("output invalid");
  },
};
const number: Schema<number> = {
  parse(input) {
    if (typeof input !== "number") throw new TypeError("number required");
    return input;
  },
};

describe("recordDiagnostic exception isolation", () => {
  test("a throwing sink does not affect a successful RPC response", async () => {
    const domain = defineDomain("hardware", {
      rpc: { ping: rpc({ input: value, output: value }) },
    });
    const handler = vi.fn(async () => undefined);
    const server = createBridgeServer(
      composeContracts(domain),
      [implementDomain(domain, { rpc: { ping: handler } })],
      { diagnostics: throwingSink },
    );
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
    const domain = defineDomain("hardware", {
      rpc: {
        broken: rpc({ input: value, output: badOutput, errors: [] as const }),
      },
    });
    const handler = vi.fn(async () => undefined);
    const server = createBridgeServer(
      composeContracts(domain),
      [implementDomain(domain, { rpc: { broken: handler } })],
      { diagnostics: throwingSink },
    );
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
    const domain = defineDomain("hardware", {
      rpc: { wait: rpc({ input: value, output: value }) },
    });
    const controls: Array<(input: undefined) => void> = [];
    const handler = vi.fn(
      () => new Promise<undefined>((resolve) => controls.push(resolve)),
    );
    const server = createBridgeServer(
      composeContracts(domain),
      [implementDomain(domain, { rpc: { wait: handler } })],
      { diagnostics: throwingSink },
    );
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
    const domain = defineDomain("hardware", {
      event: {
        change$: event(number, {
          buffer: { capacity: 2, overflow: "drop-oldest" },
        }),
      },
    });
    const server = createBridgeServer(
      composeContracts(domain),
      [implementDomain(domain, { event: { change$: broadcastEvent(events) } })],
      { diagnostics: throwingSink },
    );
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
