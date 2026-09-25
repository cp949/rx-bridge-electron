import { BehaviorSubject, Observable, Subject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import { createBridgeServer } from "../../src/main/index.js";
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
import { testSubscriptionId } from "./subscription-ids.js";

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
  const diagnostics = { record: vi.fn() };
  const server = createBridgeServer(
    {
      hardware: {
        state: { current$: currentValueSource(source) },
        event: {
          change$: broadcastEvent(events, {
            buffer: {
              capacity: options.capacity ?? 2,
              overflow: options.overflow ?? "error",
            },
          }),
        },
      },
    },
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
    const server = createBridgeServer({
      hardware: { event: { change$: broadcastEvent(source) } },
    });
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => {
      messages.push(message);
    };
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      send,
    );
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(2),
        "client-1",
        "event:hardware/change$",
      ),
      send,
    );
    expect(subscriptions).toBe(2);
    expect(live).toBe(1);
    await server.controlStream(sender(), ack(testSubscriptionId(1), 1), send);
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(3),
        "client-1",
        "event:hardware/change$",
      ),
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
    const server = createBridgeServer({
      hardware: { state: { current$: currentValueSource(source) } },
    });
    server.attach(new FakeTarget(1));
    server.attach(new FakeTarget(2));
    const first: StreamMessage[] = [];
    const second: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command("subscribe", testSubscriptionId(1)),
      (message) => first.push(message),
    );
    await server.controlStream(
      sender({ webContentsId: 2 }),
      command("subscribe", testSubscriptionId(2), "client-2"),
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
    await server.controlStream(
      sender(),
      command("unsubscribe", testSubscriptionId(1)),
      () => {},
    );
    await server.controlStream(
      sender({ webContentsId: 2 }),
      command("unsubscribe", testSubscriptionId(2), "client-2"),
      () => {},
    );
    expect(source.observed).toBe(false);
    source.next(9);
    const later: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command("subscribe", testSubscriptionId(3)),
      (message) => later.push(message),
    );
    expect(later[1]).toMatchObject({ values: [9] });
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  test("scoped factory receives trusted role and sender only after attached subscribe", async () => {
    const contexts: unknown[] = [];
    const server = createBridgeServer({
      hardware: {
        event: {
          change$: scopedEvent((context) => {
            contexts.push(context);
            return new Subject<number>();
          }),
        },
      },
    });
    server.attach(new FakeTarget(1, "dashboard"));
    await server.controlStream(
      sender({ origin: "https://evil.example" }),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      () => {},
    );
    expect(contexts).toHaveLength(0);
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(2),
        "client-1",
        "event:hardware/change$",
      ),
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

describe("Main stream scoped Event delivery", () => {
  test("scoped Event batches values with the same ack-gated flow control as broadcast", async () => {
    const upstream = new Subject<number>();
    const server = createBridgeServer({
      hardware: { event: { change$: scopedEvent(() => upstream) } },
    });
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => messages.push(message);
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      send,
    );
    upstream.next(1);
    upstream.next(2);
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
    ]);
    expect(messages.at(-1)).toMatchObject({ values: [1] });
    await server.controlStream(sender(), ack(testSubscriptionId(1), 1), send);
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
      "batch",
    ]);
    expect(messages.at(-1)).toMatchObject({ values: [2] });
  });

  test("scoped Event error terminates with a masked INTERNAL error and returns the slot", async () => {
    const upstream = new Subject<number>();
    const diagnostics = { record: vi.fn() };
    const server = createBridgeServer(
      { hardware: { event: { change$: scopedEvent(() => upstream) } } },
      { diagnostics },
    );
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => messages.push(message);
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      send,
    );
    upstream.error(new Error("boom"));
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "error",
    ]);
    expect(messages.at(-1)).toMatchObject({
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    expect(diagnostics.record.mock.calls.map(([event]) => event.type)).toEqual(
      expect.arrayContaining(["subscription-opened", "subscription-closed"]),
    );
  });

  test("scoped Event complete terminates and returns the slot", async () => {
    const upstream = new Subject<number>();
    const diagnostics = { record: vi.fn() };
    const server = createBridgeServer(
      { hardware: { event: { change$: scopedEvent(() => upstream) } } },
      { diagnostics },
    );
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => messages.push(message);
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      send,
    );
    upstream.complete();
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "complete",
    ]);
    expect(diagnostics.record.mock.calls.map(([event]) => event.type)).toEqual(
      expect.arrayContaining(["subscription-opened", "subscription-closed"]),
    );
  });

  test("scoped Event creates a separate upstream per subscription, unlike broadcast", async () => {
    let factoryCalls = 0;
    const firstSubject = new Subject<number>();
    const secondSubject = new Subject<number>();
    const server = createBridgeServer({
      hardware: {
        event: {
          change$: scopedEvent(() => {
            factoryCalls += 1;
            return factoryCalls === 1 ? firstSubject : secondSubject;
          }),
        },
      },
    });
    server.attach(new FakeTarget(1));
    server.attach(new FakeTarget(2));
    const first: StreamMessage[] = [];
    const second: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      (message) => first.push(message),
    );
    await server.controlStream(
      sender({ webContentsId: 2 }),
      command(
        "subscribe",
        testSubscriptionId(2),
        "client-2",
        "event:hardware/change$",
      ),
      (message) => second.push(message),
    );
    expect(factoryCalls).toBe(2);
    firstSubject.next(1);
    secondSubject.next(2);
    expect(first.at(-1)).toMatchObject({ values: [1] });
    expect(second.at(-1)).toMatchObject({ values: [2] });
  });
});

describe("Main stream flow control", () => {
  test("queued State is an immutable snapshot of the accepted schema value", async () => {
    const source = new BehaviorSubject({ nested: { count: 1 } });
    const server = createBridgeServer({
      hardware: { state: { current$: currentValueSource(source) } },
    });
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => {
      messages.push(message);
    };
    await server.controlStream(
      sender(),
      command("subscribe", testSubscriptionId(1)),
      send,
    );
    const pending: { nested: { count: number } } = { nested: { count: 2 } };
    source.next(pending);
    Object.assign(pending.nested, { count: "invalid" });
    await server.controlStream(sender(), ack(testSubscriptionId(1), 1), send);
    expect(messages.at(-1)).toMatchObject({
      type: "batch",
      values: [{ nested: { count: 2 } }],
    });
  });

  test("queued Event cannot be mutated into a non-BridgeValue before ACK", async () => {
    const source = new Subject<{ nested: { count: number } }>();
    const server = createBridgeServer({
      hardware: { event: { change$: broadcastEvent(source) } },
    });
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => {
      messages.push(message);
    };
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      send,
    );
    source.next({ nested: { count: 1 } });
    const pending: { nested: { count: number } } = { nested: { count: 2 } };
    source.next(pending);
    Object.assign(pending.nested, { raw: new Uint8Array([3]) });
    await server.controlStream(sender(), ack(testSubscriptionId(1), 1), send);
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
    await server.controlStream(
      sender(),
      command("subscribe", testSubscriptionId(1)),
      send,
    );
    source.next(2);
    source.next(3);
    expect(messages.filter((message) => message.type === "batch")).toHaveLength(
      1,
    );
    await server.controlStream(sender(), ack(testSubscriptionId(1), 1), send);
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
        command(
          "subscribe",
          testSubscriptionId(1),
          "client-1",
          "event:hardware/change$",
        ),
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
      await server.controlStream(sender(), ack(testSubscriptionId(1), 1), send);
      await server.controlStream(sender(), ack(testSubscriptionId(1), 2), send);
      expect(
        messages
          .filter((message) => message.type === "batch")
          .slice(1)
          .map((message) =>
            message.type === "batch" ? message.values[0] : undefined,
          ),
      ).toEqual(expected);
      await server.controlStream(sender(), ack(testSubscriptionId(1), 3), send);
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
    const server = createBridgeServer({
      hardware: {
        event: {
          change$: scopedEvent(() => {
            target.endDocument();
            return new Observable<number>(() => {
              starts += 1;
            });
          }),
        },
      },
    });
    server.attach(target);
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      (message) => messages.push(message),
    );
    expect(messages.map((message) => message.type)).toEqual(["subscribed"]);
    expect(starts).toBe(0);
  });
  test("navigation inside subscribed delivery prevents a late error or upstream subscription", async () => {
    const source = new Subject<number>();
    const server = createBridgeServer(
      { hardware: { event: { change$: broadcastEvent(source) } } },
      { authorize: () => false },
    );
    const target = new FakeTarget();
    server.attach(target);
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
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
      command("subscribe", testSubscriptionId(1)),
      (message) => first.push(message),
    );
    server.attach(new FakeTarget());
    const replay: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command("subscribe", testSubscriptionId(1)),
      (message) => replay.push(message),
    );
    expect(replay.map((message) => message.type)).toEqual([
      "subscribed",
      "error",
    ]);
    expect(replay.at(-1)).toMatchObject({
      type: "error",
      error: {
        code: "FORBIDDEN",
        message: "Bridge sender is not authorized.",
      },
    });
    const replacement: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command("subscribe", testSubscriptionId(1), "client-2"),
      (message) => replacement.push(message),
    );
    expect(replacement.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
    ]);
    source.next(2);
    await server.controlStream(
      sender(),
      ack(testSubscriptionId(1), 1, "client-2"),
      () => {},
    );
    expect(replacement.at(-1)).toMatchObject({ type: "batch", values: [2] });
  });
  test("unsubscribe during pending authorization prevents a late source subscription", async () => {
    let allow!: (value: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const source = new Subject<number>();
    const server = createBridgeServer(
      { hardware: { event: { change$: broadcastEvent(source) } } },
      { authorize: () => authorization },
    );
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => {
      messages.push(message);
    };
    const pending = server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      send,
    );
    await server.controlStream(
      sender(),
      command("unsubscribe", testSubscriptionId(1)),
      send,
    );
    allow(true);
    await pending;
    expect(source.observed).toBe(false);
    expect(messages).toEqual([]);
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      send,
    );
    expect(source.observed).toBe(false);
    expect(messages).toEqual([]);
  });
  test("a rejected subscription receives a terminal response without starting its source", async () => {
    const source = new Subject<number>();
    const server = createBridgeServer(
      { hardware: { event: { change$: broadcastEvent(source) } } },
      { authorize: () => false },
    );
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
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
    const server = createBridgeServer({
      hardware: { event: { change$: broadcastEvent(source) } },
    });
    server.attach(new FakeTarget());
    await expect(
      server.controlStream(
        sender(),
        command(
          "subscribe",
          testSubscriptionId(1),
          "client-1",
          "event:hardware/change$",
        ),
        () => {
          throw new Error("closed frame");
        },
      ),
    ).resolves.toBeUndefined();
    expect(source.observed).toBe(false);
  });

  test("delimiter-laden clientIds cannot collide across sessions", async () => {
    const { server, messages, send } = harness();
    await server.controlStream(
      sender(),
      command("subscribe", testSubscriptionId(1), "a"),
      send,
    );
    await server.controlStream(
      sender(),
      command("subscribe", testSubscriptionId(1), "a:b:c"),
      send,
    );
    expect(
      messages
        .filter((message) => message.type === "subscribed")
        .map((message) => message.clientId),
    ).toEqual(["a", "a:b:c"]);
  });

  test("synchronous overflow unsubscribes the producer at the capacity boundary", async () => {
    let produced = 0;
    const source = new Observable<number>((subscriber) => {
      for (let value = 1; value <= 100 && !subscriber.closed; value += 1) {
        produced += 1;
        subscriber.next(value);
      }
    });
    const server = createBridgeServer({
      hardware: {
        event: {
          change$: broadcastEvent(source, {
            buffer: { capacity: 1, overflow: "error" },
          }),
        },
      },
    });
    server.attach(new FakeTarget());
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      () => {},
    );
    expect(produced).toBe(3);
  });

  test("synchronous Event emission follows subscribed and terminal follows ACK", async () => {
    const source = new Observable<number>((subscriber) => {
      subscriber.next(5);
      subscriber.complete();
    });
    const server = createBridgeServer({
      hardware: { event: { change$: broadcastEvent(source) } },
    });
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => messages.push(message);
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      send,
    );
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
    ]);
    await server.controlStream(sender(), ack(testSubscriptionId(1), 1), send);
    expect(messages.at(-1)).toMatchObject({ type: "complete" });
  });

  test("terminal error drains accepted values and a later subscription starts fresh", async () => {
    const { server, events, messages, send } = harness();
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      send,
    );
    events.next(1);
    events.next(2);
    events.error(new Error("private secret"));
    await server.controlStream(sender(), ack(testSubscriptionId(1), 1), send);
    await server.controlStream(sender(), ack(testSubscriptionId(1), 2), send);
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
      command(
        "subscribe",
        testSubscriptionId(2),
        "client-1",
        "state:hardware/current$",
      ),
      (message) => fresh.push(message),
    );
    expect(fresh.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
    ]);
  });

  test("old-session ACK and unsubscribe cannot affect replacement", async () => {
    const { server, source, messages, send } = harness();
    await server.controlStream(
      sender(),
      command("subscribe", testSubscriptionId(1)),
      send,
    );
    const replacement: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command("subscribe", testSubscriptionId(1), "client-2"),
      (message) => replacement.push(message),
    );
    await server.controlStream(
      sender(),
      command("unsubscribe", testSubscriptionId(1)),
      send,
    );
    await server.controlStream(sender(), ack(testSubscriptionId(1), 1), send);
    source.next(10);
    await server.controlStream(
      sender(),
      ack(testSubscriptionId(1), 1, "client-2"),
      send,
    );
    expect(replacement.at(-1)).toMatchObject({
      clientId: "client-2",
      type: "batch",
      values: [10],
    });
    expect(messages).toHaveLength(2);
  });

  test("a State value exceeding maxTotalBytes fails validation instead of being sent", async () => {
    const source = new BehaviorSubject("x".repeat(2000));
    const diagnostics = { record: vi.fn() };
    const server = createBridgeServer(
      { hardware: { state: { current$: currentValueSource(source) } } },
      {
        payloadLimits: {
          maxDepth: 4,
          maxEntries: 10,
          maxStringBytes: 4096,
          maxTotalBytes: 1024,
        },
        diagnostics,
      },
    );
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "state:hardware/current$",
      ),
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

  test("unsubscribe during pending authorization silences a later deny", async () => {
    let allow!: (value: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const source = new Subject<number>();
    const diagnostics = { record: vi.fn() };
    const server = createBridgeServer(
      { hardware: { event: { change$: broadcastEvent(source) } } },
      { authorize: () => authorization, diagnostics },
    );
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => {
      messages.push(message);
    };
    const pending = server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      send,
    );
    await server.controlStream(
      sender(),
      command("unsubscribe", testSubscriptionId(1)),
      send,
    );
    allow(false);
    await pending;
    expect(messages).toEqual([]);
    const rejections = diagnostics.record.mock.calls
      .map(([event]) => event as { type: string })
      .filter((event) => event.type === "rejected");
    expect(rejections).toEqual([]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("detach during pending authorization silences a later authorize exception", async () => {
    let fail!: (cause: unknown) => void;
    const authorization = new Promise<boolean>((_resolve, reject) => {
      fail = reject;
    });
    const diagnostics = { record: vi.fn() };
    const server = createBridgeServer(
      {
        hardware: { event: { change$: broadcastEvent(new Subject<number>()) } },
      },
      { authorize: () => authorization, diagnostics },
    );
    const detach = server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    const pending = server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      (message) => messages.push(message),
    );
    detach();
    fail(new Error("authorize boom"));
    await pending;
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "error",
    ]);
    expect(messages[1]).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
    const rejections = diagnostics.record.mock.calls
      .map(([event]) => event as { type: string })
      .filter((event) => event.type === "rejected");
    expect(rejections).toEqual([]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("subscribing without an authorize option delivers subscribed synchronously", async () => {
    const { server } = harness();
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => {
      messages.push(message);
    };
    const pending = server.controlStream(
      sender(),
      command("subscribe", testSubscriptionId(1)),
      send,
    );
    expect(messages[0]).toMatchObject({ type: "subscribed", sequence: 0 });
    await pending;
  });

  test("detach from the diagnostics sink during stream-dropped ends the stream with CANCELLED", async () => {
    const { server, events, diagnostics, messages, send } = harness({
      capacity: 2,
      overflow: "drop-oldest",
    });
    const detach = server.attach(new FakeTarget());
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      send,
    );
    diagnostics.record.mockImplementation((event: { type: string }) => {
      if (event.type === "stream-dropped") detach();
    });
    events.next(1);
    events.next(2);
    events.next(3);
    events.next(4);
    events.next(5);
    expect(
      messages.map((message) => ({
        type: message.type,
        sequence: message.sequence,
      })),
    ).toEqual([
      { type: "subscribed", sequence: 0 },
      { type: "batch", sequence: 1 },
      { type: "error", sequence: 2 },
    ]);
    expect(messages[1]).toMatchObject({ values: [1] });
    expect(messages.at(-1)).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
    expect(
      diagnostics.record.mock.calls
        .slice(-4)
        .map(
          ([event]) =>
            event as { type: string; count?: number; depth?: number },
        ),
    ).toEqual([
      expect.objectContaining({ type: "stream-dropped", count: 1 }),
      expect.objectContaining({ type: "session-closed" }),
      expect.objectContaining({ type: "subscription-closed" }),
      expect.objectContaining({ type: "stream-queue", depth: 2 }),
    ]);
    expect(server.getDiagnosticsSnapshot()).toMatchObject({
      subscriptions: 0,
      queuedEvents: 0,
    });
  });

  test("detach from the diagnostics sink during a post-push stream-queue diagnostic drops the pending batch", async () => {
    const { server, events, diagnostics, messages, send } = harness({
      capacity: 2,
      overflow: "drop-oldest",
    });
    const detach = server.attach(new FakeTarget());
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      send,
    );
    diagnostics.record.mockImplementation(
      (event: { type: string; depth?: number }) => {
        if (event.type === "stream-queue" && event.depth === 1) detach();
      },
    );
    events.next(1);
    events.next(2);
    expect(
      messages.map((message) => ({
        type: message.type,
        sequence: message.sequence,
      })),
    ).toEqual([
      { type: "subscribed", sequence: 0 },
      { type: "error", sequence: 1 },
    ]);
    expect(messages.at(-1)).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
    expect(
      diagnostics.record.mock.calls
        .slice(-3)
        .map(([event]) => event as { type: string; depth?: number }),
    ).toEqual([
      expect.objectContaining({ type: "stream-queue", depth: 1 }),
      expect.objectContaining({ type: "session-closed" }),
      expect.objectContaining({ type: "subscription-closed" }),
    ]);
  });

  test("a synchronous acknowledge reentrant inside send drains the deferred queue in order", async () => {
    const { server, events, diagnostics } = harness({
      capacity: 2,
      overflow: "drop-oldest",
    });
    const id = testSubscriptionId(1);
    const messages: StreamMessage[] = [];
    let gate = false;
    const send = (message: StreamMessage) => {
      messages.push(message);
      if (gate && message.type === "batch") {
        void server.controlStream(sender(), ack(id, message.sequence), send);
      }
    };
    await server.controlStream(
      sender(),
      command("subscribe", id, "client-1", "event:hardware/change$"),
      send,
    );
    events.next(1);
    events.next(2);
    events.next(3);
    events.complete();
    gate = true;
    await server.controlStream(sender(), ack(id, 1), send);
    expect(
      messages.map((message) => ({
        type: message.type,
        sequence: message.sequence,
      })),
    ).toEqual([
      { type: "subscribed", sequence: 0 },
      { type: "batch", sequence: 1 },
      { type: "batch", sequence: 2 },
      { type: "batch", sequence: 3 },
      { type: "complete", sequence: 4 },
    ]);
    expect(messages[1]).toMatchObject({ values: [1] });
    expect(messages[2]).toMatchObject({ values: [2] });
    expect(messages[3]).toMatchObject({ values: [3] });
    expect(
      diagnostics.record.mock.calls
        .slice(-3)
        .map(([event]) => event as { type: string; depth?: number }),
    ).toEqual([
      expect.objectContaining({ type: "stream-queue", depth: 1 }),
      expect.objectContaining({ type: "stream-queue", depth: 0 }),
      expect.objectContaining({ type: "subscription-closed" }),
    ]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("a synchronous unsubscribe reentrant inside send stops delivery immediately", async () => {
    const { server, events, diagnostics } = harness({
      capacity: 2,
      overflow: "drop-oldest",
    });
    const id = testSubscriptionId(1);
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => {
      messages.push(message);
      if (message.type === "batch") {
        void server.controlStream(sender(), command("unsubscribe", id), send);
      }
    };
    await server.controlStream(
      sender(),
      command("subscribe", id, "client-1", "event:hardware/change$"),
      send,
    );
    events.next(1);
    events.next(2);
    expect(
      messages.map((message) => ({
        type: message.type,
        sequence: message.sequence,
      })),
    ).toEqual([
      { type: "subscribed", sequence: 0 },
      { type: "batch", sequence: 1 },
    ]);
    expect(messages[1]).toMatchObject({ values: [1] });
    expect(
      diagnostics.record.mock.calls
        .slice(-3)
        .map(([event]) => event as { type: string; depth?: number }),
    ).toEqual([
      expect.objectContaining({ type: "stream-queue", depth: 1 }),
      expect.objectContaining({ type: "stream-queue", depth: 0 }),
      expect.objectContaining({ type: "subscription-closed" }),
    ]);
    expect(server.getDiagnosticsSnapshot()).toMatchObject({
      subscriptions: 0,
      queuedEvents: 0,
    });
    events.next(3);
    expect(messages).toHaveLength(2);
  });

  test("detach from the diagnostics sink during a post-shift stream-queue diagnostic discards the flushed value", async () => {
    const { server, events, diagnostics, messages, send } = harness({
      capacity: 2,
      overflow: "drop-oldest",
    });
    const detach = server.attach(new FakeTarget());
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      send,
    );
    diagnostics.record.mockImplementation(
      (event: { type: string; depth?: number }) => {
        if (event.type === "stream-queue" && event.depth === 0) detach();
      },
    );
    events.next(1);
    events.next(2);
    expect(
      messages.map((message) => ({
        type: message.type,
        sequence: message.sequence,
      })),
    ).toEqual([
      { type: "subscribed", sequence: 0 },
      { type: "error", sequence: 1 },
    ]);
    expect(messages.at(-1)).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
    expect(
      diagnostics.record.mock.calls
        .slice(-3)
        .map(([event]) => event as { type: string; depth?: number }),
    ).toEqual([
      expect.objectContaining({ type: "stream-queue", depth: 0 }),
      expect.objectContaining({ type: "session-closed" }),
      expect.objectContaining({ type: "subscription-closed" }),
    ]);
    expect(server.getDiagnosticsSnapshot()).toMatchObject({
      subscriptions: 0,
      queuedEvents: 0,
    });
  });
});

describe("Main stream terminal notify on retire", () => {
  test("detach retires an active State subscriber with CANCELLED, discarding an unacked pending value", async () => {
    const { server, source, messages, send } = harness();
    const detach = server.attach(new FakeTarget());
    await server.controlStream(
      sender(),
      command("subscribe", testSubscriptionId(1)),
      send,
    );
    source.next(2);
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
    ]);
    detach();
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
      "error",
    ]);
    expect(messages.at(-1)).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
    source.next(3);
    expect(messages).toHaveLength(3);
  });

  test("detach replaces a recorded terminal still waiting for ACK with CANCELLED", async () => {
    const { server, source, messages, send } = harness();
    const detach = server.attach(new FakeTarget());
    await server.controlStream(
      sender(),
      command("subscribe", testSubscriptionId(1)),
      send,
    );
    source.complete();
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
    ]);
    detach();
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
      "error",
    ]);
    expect(messages.at(-1)).toMatchObject({
      sequence: 2,
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
  });

  test("server.dispose() retires an active broadcast Event subscriber with CANCELLED", async () => {
    const { server, messages, send } = harness();
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      send,
    );
    expect(messages.map((message) => message.type)).toEqual(["subscribed"]);
    server.dispose();
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "error",
    ]);
    expect(messages.at(-1)).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
  });

  test("detach retires an active scoped Event subscriber with CANCELLED", async () => {
    const upstream = new Subject<number>();
    const server = createBridgeServer({
      hardware: {
        event: { change$: scopedEvent(() => upstream) },
      },
    });
    const detach = server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      (message) => messages.push(message),
    );
    detach();
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "error",
    ]);
    expect(messages.at(-1)).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
    expect(upstream.observed).toBe(false);
  });

  test.each([
    ["main-frame-navigation"],
    ["render-process-gone"],
    ["destroyed"],
  ] as const)(
    "%s retires an active subscriber without a stream termination",
    async (reason) => {
      const target = new FakeTarget();
      const { server, messages, send } = harness();
      server.attach(target);
      await server.controlStream(
        sender(),
        command("subscribe", testSubscriptionId(1)),
        send,
      );
      const before = messages.length;
      target.fireLifecycle(reason);
      expect(messages.slice(before)).toEqual([]);
      expect(messages.slice(0, before).map((message) => message.type)).toEqual([
        "subscribed",
        "batch",
      ]);
      expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
    },
  );

  test("a replacing clientId retires the previous active subscriber without a stream termination", async () => {
    const { server, messages, send } = harness();
    await server.controlStream(
      sender(),
      command("subscribe", testSubscriptionId(1), "client-1"),
      send,
    );
    const before = messages.length;
    const replacement: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      command("subscribe", testSubscriptionId(1), "client-2"),
      (message) => replacement.push(message),
    );
    expect(messages.slice(before)).toEqual([]);
    expect(replacement.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
    ]);
  });

  test("a send failure while notifying an active subscriber still closes it", async () => {
    const source = new BehaviorSubject(1);
    const server = createBridgeServer({
      hardware: { state: { current$: currentValueSource(source) } },
    });
    const detach = server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    let calls = 0;
    await server.controlStream(
      sender(),
      command("subscribe", testSubscriptionId(1)),
      (message) => {
        calls += 1;
        if (calls === 3) throw new Error("closed frame");
        messages.push(message);
      },
    );
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "batch",
    ]);
    expect(() => detach()).not.toThrow();
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("detach during pending authorization sends subscribed then CANCELLED", async () => {
    let allow!: (value: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const server = createBridgeServer(
      {
        hardware: { event: { change$: broadcastEvent(new Subject<number>()) } },
      },
      { authorize: () => authorization },
    );
    const detach = server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    const pending = server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      (message) => messages.push(message),
    );
    detach();
    allow(true);
    await pending;
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "error",
    ]);
    expect(messages[1]).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
  });

  test("server.dispose() during pending authorization sends subscribed then CANCELLED", async () => {
    let allow!: (value: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const server = createBridgeServer(
      {
        hardware: { event: { change$: broadcastEvent(new Subject<number>()) } },
      },
      { authorize: () => authorization },
    );
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    const pending = server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      (message) => messages.push(message),
    );
    server.dispose();
    allow(true);
    await pending;
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "error",
    ]);
    expect(messages[1]).toMatchObject({
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
  });

  test("a send failure while notifying a pending subscriber still releases its slot", async () => {
    let allow!: (value: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const server = createBridgeServer(
      {
        hardware: { event: { change$: broadcastEvent(new Subject<number>()) } },
      },
      { authorize: () => authorization },
    );
    const detach = server.attach(new FakeTarget());
    const pending = server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      () => {
        throw new Error("closed frame");
      },
    );
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(1);
    expect(() => detach()).not.toThrow();
    allow(true);
    await pending;
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("navigation during pending authorization sends nothing", async () => {
    let allow!: (value: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const target = new FakeTarget();
    const server = createBridgeServer(
      {
        hardware: { event: { change$: broadcastEvent(new Subject<number>()) } },
      },
      { authorize: () => authorization },
    );
    server.attach(target);
    const messages: StreamMessage[] = [];
    const pending = server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "event:hardware/change$",
      ),
      (message) => messages.push(message),
    );
    target.endDocument();
    allow(true);
    await pending;
    expect(messages).toEqual([]);
  });

  test("detach while sending a rejection's subscribed replaces the rejection with CANCELLED", async () => {
    const { server } = harness();
    const target = new FakeTarget();
    const detach = server.attach(target);
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => {
      messages.push(message);
      if (message.type === "subscribed") detach();
    };
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "state:hardware/missing$",
      ),
      send,
    );
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "error",
    ]);
    expect(messages[0]).toMatchObject({ sequence: 0 });
    expect(messages[1]).toMatchObject({
      sequence: 1,
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("a non-notifying retire while sending a rejection's subscribed sends nothing more", async () => {
    const { server } = harness();
    const target = new FakeTarget();
    server.attach(target);
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => {
      messages.push(message);
      if (message.type === "subscribed") target.fireLifecycle("destroyed");
    };
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "state:hardware/missing$",
      ),
      send,
    );
    expect(messages.map((message) => message.type)).toEqual(["subscribed"]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("detach from the diagnostics sink before a rejection is sent answers with CANCELLED", async () => {
    const { server, diagnostics, messages, send } = harness();
    const detach = server.attach(new FakeTarget());
    diagnostics.record.mockImplementation((event: { type: string }) => {
      if (event.type === "rejected") detach();
    });
    await server.controlStream(
      sender(),
      command(
        "subscribe",
        testSubscriptionId(1),
        "client-1",
        "state:hardware/missing$",
      ),
      send,
    );
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "error",
    ]);
    expect(messages[1]).toMatchObject({
      sequence: 1,
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("detach from the diagnostics sink during an authorize-denied rejection answers with CANCELLED", async () => {
    const source = new BehaviorSubject(1);
    const diagnostics = { record: vi.fn() };
    const server = createBridgeServer(
      { hardware: { state: { current$: currentValueSource(source) } } },
      { authorize: () => false, diagnostics },
    );
    const detach = server.attach(new FakeTarget());
    diagnostics.record.mockImplementation(
      (event: { type: string; reason?: string }) => {
        if (event.type === "rejected" && event.reason === "authorize-denied")
          detach();
      },
    );
    const messages: StreamMessage[] = [];
    const send = (message: StreamMessage) => {
      messages.push(message);
    };
    await server.controlStream(
      sender(),
      command("subscribe", testSubscriptionId(1)),
      send,
    );
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "error",
    ]);
    expect(messages[1]).toMatchObject({
      sequence: 1,
      error: { code: "CANCELLED", message: "Bridge session ended." },
    });
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
    const rejections = diagnostics.record.mock.calls
      .map(([event]) => event as { type: string })
      .filter((event) => event.type === "rejected");
    expect(rejections).toEqual([
      {
        type: "rejected",
        reason: "authorize-denied",
        key: "state:hardware/current$",
      },
    ]);
  });

  test("the authorize-denied diagnostic is recorded before the subscription slot is released", async () => {
    const diagnostics = { record: vi.fn() };
    const server = createBridgeServer(
      {
        hardware: {
          state: { current$: currentValueSource(new BehaviorSubject(1)) },
        },
      },
      { authorize: () => false, diagnostics },
    );
    server.attach(new FakeTarget());
    const inSink: number[] = [];
    diagnostics.record.mockImplementation(
      (event: { type: string; reason?: string }) => {
        if (event.type === "rejected" && event.reason === "authorize-denied")
          inSink.push(server.getDiagnosticsSnapshot().subscriptions);
      },
    );
    await server.controlStream(
      sender(),
      command("subscribe", testSubscriptionId(1)),
      () => {},
    );
    expect(inSink).toEqual([1]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });
});
