import { BehaviorSubject, Observable, Subject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import {
  composeContracts,
  defineDomain,
  event,
  state,
  type Schema,
} from "../../src/contract/index.js";
import { createBridgeServer, implementDomain } from "../../src/main/index.js";
import {
  broadcastEvent,
  currentValueSource,
  scopedEvent,
} from "../../src/main/sources.js";
import type {
  StreamMessage,
  WireStreamCommand,
} from "../../src/protocol/index.js";
import { parseBridgeValue } from "../../src/protocol/index.js";
import { FakeTarget, sender } from "./fake-ipc.js";

const number: Schema<number> = {
  parse(value) {
    if (typeof value !== "number") throw new TypeError("number required");
    return value;
  },
};
const nested: Schema<{ readonly nested: { readonly count: number } }> = {
  parse(value) {
    if (
      value === null ||
      typeof value !== "object" ||
      !("nested" in value) ||
      value.nested === null ||
      typeof value.nested !== "object" ||
      !("count" in value.nested) ||
      typeof value.nested.count !== "number"
    )
      throw new TypeError("nested count required");
    return value as { readonly nested: { readonly count: number } };
  },
};
function command(
  type: "subscribe",
  subscriptionId: string,
  clientId?: string,
  key?: string,
): Extract<WireStreamCommand, { type: "subscribe" }>;
function command(
  type: "unsubscribe",
  subscriptionId: string,
  clientId?: string,
  key?: string,
): Extract<WireStreamCommand, { type: "unsubscribe" }>;
function command(
  type: "subscribe" | "unsubscribe",
  subscriptionId: string,
  clientId = "client-1",
  key = "state:hardware/current$",
): WireStreamCommand {
  return type === "subscribe"
    ? { protocolVersion: 1, clientId, type, subscriptionId, key }
    : { protocolVersion: 1, clientId, type, subscriptionId };
}
const ack = (
  subscriptionId: string,
  sequence: number,
  clientId = "client-1",
) => ({
  protocolVersion: 1 as const,
  clientId,
  type: "acknowledge" as const,
  subscriptionId,
  sequence,
});

function harness(
  options: {
    capacity?: number;
    overflow?: "error" | "drop-oldest" | "drop-newest";
  } = {},
) {
  const source = new BehaviorSubject(1);
  const events = new Subject<number>();
  const domain = defineDomain("hardware", {
    state: { current$: state(number) },
    event: {
      change$: event(number, {
        buffer: {
          capacity: options.capacity ?? 2,
          overflow: options.overflow ?? "error",
        },
      }),
    },
  });
  const diagnostics = { record: vi.fn() };
  const server = createBridgeServer(
    composeContracts(domain),
    [
      implementDomain(domain, {
        state: { current$: currentValueSource(source) },
        event: { change$: broadcastEvent(events) },
      }),
    ],
    { diagnostics },
  );
  server.attach(new FakeTarget(1));
  server.attach(new FakeTarget(2));
  const messages: StreamMessage[] = [];
  const send = (message: StreamMessage) => messages.push(message);
  return { server, source, events, diagnostics, messages, send };
}

describe("Main stream sources and sharing", () => {
  test("terminal ACK from an old consumer cannot evict a newer shared upstream", async () => {
    let subscriptions = 0;
    let live = 0;
    const source = new Observable<number>((subscriber) => {
      subscriptions += 1;
      live += 1;
      if (subscriptions === 1) {
        subscriber.next(1);
        subscriber.complete();
      }
      return () => {
        live -= 1;
      };
    });
    const domain = defineDomain("hardware", {
      event: { change$: event(number) },
    });
    const server = createBridgeServer(composeContracts(domain), [
      implementDomain(domain, { event: { change$: broadcastEvent(source) } }),
    ]);
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => {
      messages.push(message);
    };
    await server.controlStream(
      sender(),
      command("subscribe", "a", "client-1", "event:hardware/change$"),
      send,
    );
    await server.controlStream(
      sender(),
      command("subscribe", "b", "client-1", "event:hardware/change$"),
      send,
    );
    expect(subscriptions).toBe(2);
    expect(live).toBe(1);
    await server.controlStream(sender(), ack("a", 1), send);
    await server.controlStream(
      sender(),
      command("subscribe", "c", "client-1", "event:hardware/change$"),
      send,
    );
    expect(subscriptions).toBe(2);
    expect(live).toBe(1);
    expect(
      messages.filter((message) => message.type === "subscribed"),
    ).toHaveLength(3);
  });
  test("rejects a plain Subject as State source", () => {
    expect(() => currentValueSource(new Subject<number>() as never)).toThrow(
      TypeError,
    );
  });

  test("delivers current State first and shares one upstream between windows", async () => {
    const source = new BehaviorSubject(7);
    const subscribe = vi.spyOn(source, "subscribe");
    const domain = defineDomain("hardware", {
      state: { current$: state(number) },
    });
    const server = createBridgeServer(composeContracts(domain), [
      implementDomain(domain, {
        state: { current$: currentValueSource(source) },
      }),
    ]);
    server.attach(new FakeTarget(1));
    server.attach(new FakeTarget(2));
    const first: StreamMessage[] = [];
    const second: StreamMessage[] = [];
    await server.controlStream(sender(), command("subscribe", "a"), (message) =>
      first.push(message),
    );
    await server.controlStream(
      sender({ webContentsId: 2 }),
      command("subscribe", "b", "client-2"),
      (message) => second.push(message),
    );
    expect(first.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
    ]);
    expect(second.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
    ]);
    expect(first[1]).toMatchObject({ values: [7] });
    expect(second[1]).toMatchObject({ values: [7] });
    expect(subscribe).toHaveBeenCalledTimes(1);
    await server.controlStream(sender(), command("unsubscribe", "a"), () => {});
    await server.controlStream(
      sender({ webContentsId: 2 }),
      command("unsubscribe", "b", "client-2"),
      () => {},
    );
    expect(source.observed).toBe(false);
    source.next(9);
    const later: StreamMessage[] = [];
    await server.controlStream(sender(), command("subscribe", "c"), (message) =>
      later.push(message),
    );
    expect(later[1]).toMatchObject({ values: [9] });
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  test("scoped factory receives trusted role and sender only after attached subscribe", async () => {
    const contexts: unknown[] = [];
    const domain = defineDomain("hardware", {
      event: { change$: event(number) },
    });
    const server = createBridgeServer(composeContracts(domain), [
      implementDomain(domain, {
        event: {
          change$: scopedEvent((context) => {
            contexts.push(context);
            return new Subject<number>();
          }),
        },
      }),
    ]);
    server.attach(new FakeTarget(1, "dashboard"));
    await server.controlStream(
      sender({ origin: "https://evil.example" }),
      command("subscribe", "bad", "client-1", "event:hardware/change$"),
      () => {},
    );
    expect(contexts).toHaveLength(0);
    await server.controlStream(
      sender(),
      command("subscribe", "good", "client-1", "event:hardware/change$"),
      () => {},
    );
    expect(contexts).toEqual([
      expect.objectContaining({
        windowRole: "dashboard",
        clientId: "client-1",
        sender: sender(),
      }),
    ]);
  });
});

describe("Main stream flow control", () => {
  test("queued State is an immutable snapshot of the accepted schema value", async () => {
    const source = new BehaviorSubject({ nested: { count: 1 } });
    const domain = defineDomain("hardware", {
      state: { current$: state(nested) },
    });
    const server = createBridgeServer(composeContracts(domain), [
      implementDomain(domain, {
        state: { current$: currentValueSource(source) },
      }),
    ]);
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => {
      messages.push(message);
    };
    await server.controlStream(sender(), command("subscribe", "s"), send);
    const pending: { nested: { count: number } } = { nested: { count: 2 } };
    source.next(pending);
    Object.assign(pending.nested, { count: "invalid" });
    await server.controlStream(sender(), ack("s", 1), send);
    expect(messages.at(-1)).toMatchObject({
      type: "batch",
      values: [{ nested: { count: 2 } }],
    });
  });

  test("queued Event cannot be mutated into a non-BridgeValue before ACK", async () => {
    const source = new Subject<{ nested: { count: number } }>();
    const domain = defineDomain("hardware", {
      event: { change$: event(nested) },
    });
    const server = createBridgeServer(composeContracts(domain), [
      implementDomain(domain, { event: { change$: broadcastEvent(source) } }),
    ]);
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => {
      messages.push(message);
    };
    await server.controlStream(
      sender(),
      command("subscribe", "e", "client-1", "event:hardware/change$"),
      send,
    );
    source.next({ nested: { count: 1 } });
    const pending: { nested: { count: number } } = { nested: { count: 2 } };
    source.next(pending);
    Object.assign(pending.nested, { raw: new Uint8Array([3]) });
    await server.controlStream(sender(), ack("e", 1), send);
    const latest = messages.at(-1);
    expect(latest).toMatchObject({
      type: "batch",
      values: [{ nested: { count: 2 } }],
    });
    if (latest?.type !== "batch") throw new Error("expected batch");
    expect(
      parseBridgeValue(latest.values[0], {
        maxDepth: 4,
        maxEntries: 10,
        maxStringBytes: 100,
      }),
    ).toEqual({ nested: { count: 2 } });
  });
  test("holds one State batch and replaces pending State with latest value until ACK", async () => {
    const { server, source, messages, send } = harness();
    await server.controlStream(sender(), command("subscribe", "s"), send);
    source.next(2);
    source.next(3);
    expect(messages.filter((message) => message.type === "batch")).toHaveLength(
      1,
    );
    await server.controlStream(sender(), ack("s", 1), send);
    expect(messages.at(-1)).toMatchObject({
      type: "batch",
      sequence: 2,
      values: [3],
    });
  });

  test.each([
    ["drop-oldest", [3, 4], false],
    ["drop-newest", [2, 3], false],
    ["error", [2, 3], true],
  ] as const)(
    "Event %s keeps accepted values and counts drops",
    async (overflow, expected, ends) => {
      const { server, events, messages, send, diagnostics } = harness({
        capacity: 2,
        overflow,
      });
      await server.controlStream(
        sender(),
        command("subscribe", "e", "client-1", "event:hardware/change$"),
        send,
      );
      events.next(1);
      events.next(2);
      events.next(3);
      events.next(4);
      expect(
        messages.filter((message) => message.type === "batch"),
      ).toHaveLength(1);
      expect(messages[1]).toMatchObject({ values: [1] });
      expect(diagnostics.record).toHaveBeenCalledWith(
        expect.objectContaining({ type: "stream-dropped", count: 1 }),
      );
      await server.controlStream(sender(), ack("e", 1), send);
      await server.controlStream(sender(), ack("e", 2), send);
      expect(
        messages
          .filter((message) => message.type === "batch")
          .slice(1)
          .map((message) =>
            message.type === "batch" ? message.values[0] : undefined,
          ),
      ).toEqual(expected);
      await server.controlStream(sender(), ack("e", 3), send);
      expect(messages.some((message) => message.type === "error")).toBe(ends);
      expect(
        diagnostics.record.mock.calls
          .filter(([entry]) => entry.type === "stream-queue")
          .every(([entry]) => entry.depth <= 2),
      ).toBe(true);
    },
  );
});

describe("Main stream lifecycle and ordering", () => {
  test("scoped factory cannot start a source after ending its document", async () => {
    let starts = 0;
    const target = new FakeTarget();
    const domain = defineDomain("hardware", {
      event: { change$: event(number) },
    });
    const server = createBridgeServer(composeContracts(domain), [
      implementDomain(domain, {
        event: {
          change$: scopedEvent(() => {
            target.endDocument();
            return new Observable<number>(() => {
              starts += 1;
            });
          }),
        },
      }),
    ]);
    server.attach(target);
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command("subscribe", "s", "client-1", "event:hardware/change$"),
      (message) => messages.push(message),
    );
    expect(messages.map((message) => message.type)).toEqual(["subscribed"]);
    expect(starts).toBe(0);
  });
  test("navigation inside subscribed delivery prevents a late error or upstream subscription", async () => {
    const source = new Subject<number>();
    const domain = defineDomain("hardware", {
      event: { change$: event(number) },
    });
    const server = createBridgeServer(
      composeContracts(domain),
      [implementDomain(domain, { event: { change$: broadcastEvent(source) } })],
      { authorize: () => false },
    );
    const target = new FakeTarget();
    server.attach(target);
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command("subscribe", "s", "client-1", "event:hardware/change$"),
      (message) => {
        messages.push(message);
        target.endDocument();
      },
    );
    expect(messages.map((message) => message.type)).toEqual(["subscribed"]);
    expect(source.observed).toBe(false);
  });

  test("retired client IDs cannot replay after detach and a new client may reuse its stream ID", async () => {
    const { server, source } = harness();
    const first: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command("subscribe", "same"),
      (message) => first.push(message),
    );
    server.attach(new FakeTarget());
    const replay: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command("subscribe", "other"),
      (message) => replay.push(message),
    );
    expect(replay).toEqual([]);
    const replacement: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command("subscribe", "same", "client-2"),
      (message) => replacement.push(message),
    );
    expect(replacement.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
    ]);
    source.next(2);
    await server.controlStream(sender(), ack("same", 1, "client-2"), () => {});
    expect(replacement.at(-1)).toMatchObject({ type: "batch", values: [2] });
  });
  test("unsubscribe during pending authorization prevents a late source subscription", async () => {
    let allow!: (value: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const source = new Subject<number>();
    const domain = defineDomain("hardware", {
      event: { change$: event(number) },
    });
    const server = createBridgeServer(
      composeContracts(domain),
      [implementDomain(domain, { event: { change$: broadcastEvent(source) } })],
      { authorize: () => authorization },
    );
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => {
      messages.push(message);
    };
    const pending = server.controlStream(
      sender(),
      command("subscribe", "pending", "client-1", "event:hardware/change$"),
      send,
    );
    await server.controlStream(
      sender(),
      command("unsubscribe", "pending"),
      send,
    );
    allow(true);
    await pending;
    expect(source.observed).toBe(false);
    expect(messages).toEqual([]);
    await server.controlStream(
      sender(),
      command("subscribe", "pending", "client-1", "event:hardware/change$"),
      send,
    );
    expect(source.observed).toBe(false);
    expect(messages).toEqual([]);
  });
  test("a rejected subscription receives a terminal response without starting its source", async () => {
    const source = new Subject<number>();
    const domain = defineDomain("hardware", {
      event: { change$: event(number) },
    });
    const server = createBridgeServer(
      composeContracts(domain),
      [
        implementDomain(domain, {
          event: { change$: broadcastEvent(source) },
        }),
      ],
      { authorize: () => false },
    );
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command("subscribe", "denied", "client-1", "event:hardware/change$"),
      (message) => messages.push(message),
    );
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "error",
    ]);
    expect(messages[1]).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(source.observed).toBe(false);
  });

  test("a failing sender closes the consumer before subscribing upstream", async () => {
    const source = new Subject<number>();
    const domain = defineDomain("hardware", {
      event: { change$: event(number) },
    });
    const server = createBridgeServer(composeContracts(domain), [
      implementDomain(domain, {
        event: { change$: broadcastEvent(source) },
      }),
    ]);
    server.attach(new FakeTarget());
    await expect(
      server.controlStream(
        sender(),
        command("subscribe", "e", "client-1", "event:hardware/change$"),
        () => {
          throw new Error("closed frame");
        },
      ),
    ).resolves.toBeUndefined();
    expect(source.observed).toBe(false);
  });

  test("opaque IDs with delimiters cannot collide across client and subscription fields", async () => {
    const { server, messages, send } = harness();
    await server.controlStream(
      sender(),
      command("subscribe", "b:c", "a"),
      send,
    );
    await server.controlStream(
      sender(),
      command("subscribe", "c", "a:b"),
      send,
    );
    expect(
      messages
        .filter((message) => message.type === "subscribed")
        .map((message) => message.clientId),
    ).toEqual(["a", "a:b"]);
  });

  test("synchronous overflow unsubscribes the producer at the capacity boundary", async () => {
    let produced = 0;
    const source = new Observable<number>((subscriber) => {
      for (let value = 1; value <= 100 && !subscriber.closed; value += 1) {
        produced += 1;
        subscriber.next(value);
      }
    });
    const domain = defineDomain("hardware", {
      event: {
        change$: event(number, { buffer: { capacity: 1, overflow: "error" } }),
      },
    });
    const server = createBridgeServer(composeContracts(domain), [
      implementDomain(domain, {
        event: { change$: broadcastEvent(source) },
      }),
    ]);
    server.attach(new FakeTarget());
    await server.controlStream(
      sender(),
      command("subscribe", "e", "client-1", "event:hardware/change$"),
      () => {},
    );
    expect(produced).toBe(3);
  });

  test("synchronous Event emission follows subscribed and terminal follows ACK", async () => {
    const domain = defineDomain("hardware", {
      event: { change$: event(number) },
    });
    const source = new Observable<number>((subscriber) => {
      subscriber.next(5);
      subscriber.complete();
    });
    const server = createBridgeServer(composeContracts(domain), [
      implementDomain(domain, { event: { change$: broadcastEvent(source) } }),
    ]);
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => messages.push(message);
    await server.controlStream(
      sender(),
      command("subscribe", "e", "client-1", "event:hardware/change$"),
      send,
    );
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
    ]);
    await server.controlStream(sender(), ack("e", 1), send);
    expect(messages.at(-1)).toMatchObject({ type: "complete" });
  });

  test("terminal error drains accepted values and a later subscription starts fresh", async () => {
    const { server, events, messages, send } = harness();
    await server.controlStream(
      sender(),
      command("subscribe", "e", "client-1", "event:hardware/change$"),
      send,
    );
    events.next(1);
    events.next(2);
    events.error(new Error("private secret"));
    await server.controlStream(sender(), ack("e", 1), send);
    await server.controlStream(sender(), ack("e", 2), send);
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
      "batch",
      "error",
    ]);
    expect(messages.at(-1)).toMatchObject({
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    const fresh: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command("subscribe", "later", "client-1", "state:hardware/current$"),
      (message) => fresh.push(message),
    );
    expect(fresh.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
    ]);
  });

  test("old-session ACK and unsubscribe cannot affect replacement", async () => {
    const { server, source, messages, send } = harness();
    await server.controlStream(sender(), command("subscribe", "same"), send);
    const replacement: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command("subscribe", "same", "client-2"),
      (message) => replacement.push(message),
    );
    await server.controlStream(sender(), command("unsubscribe", "same"), send);
    await server.controlStream(sender(), ack("same", 1), send);
    source.next(10);
    await server.controlStream(sender(), ack("same", 1, "client-2"), send);
    expect(replacement.at(-1)).toMatchObject({
      clientId: "client-2",
      type: "batch",
      values: [10],
    });
    expect(messages).toHaveLength(2);
  });

  test("a State value exceeding maxTotalBytes fails validation instead of being sent", async () => {
    const string: Schema<string> = {
      parse(value) {
        if (typeof value !== "string") throw new TypeError("string required");
        return value;
      },
    };
    const source = new BehaviorSubject("x".repeat(2000));
    const domain = defineDomain("hardware", {
      state: { current$: state(string) },
    });
    const diagnostics = { record: vi.fn() };
    const server = createBridgeServer(
      composeContracts(
        {
          payloadLimits: {
            maxDepth: 4,
            maxEntries: 10,
            maxStringBytes: 4096,
            maxTotalBytes: 1024,
          },
        },
        domain,
      ),
      [
        implementDomain(domain, {
          state: { current$: currentValueSource(source) },
        }),
      ],
      { diagnostics },
    );
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command("subscribe", "s", "client-1", "state:hardware/current$"),
      (message) => messages.push(message),
    );
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "error",
    ]);
    expect(messages[1]).toMatchObject({
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    expect(diagnostics.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: "validation-failed" }),
    );
  });
});
