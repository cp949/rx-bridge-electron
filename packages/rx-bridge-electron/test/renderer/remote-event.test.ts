import { describe, expect, test } from "vitest";
import type { Observable } from "rxjs";

import { createRendererApi, RemoteError } from "../../src/renderer/index.js";
import type {
  RendererStreamCommand,
  StreamMessage,
} from "../../src/protocol/index.js";
import { FakeTransport } from "./fake-transport.js";

interface EventBridge {
  readonly hardware: {
    readonly fault$: Observable<string>;
  };
}

type StreamMessageBody = StreamMessage extends infer Message
  ? Message extends StreamMessage
    ? Omit<Message, "protocolVersion" | "clientId" | "subscriptionId">
    : never
  : never;

function eventTransport(): FakeTransport {
  const transport = new FakeTransport();
  transport.handshake = Promise.resolve({
    protocolVersion: 1,
    clientId: "client-1",
    manifest: {
      rpc: [],
      state: [],
      event: ["event:hardware/fault$"],
    },
  });
  return transport;
}

function message(
  subscriptionId: string,
  value: StreamMessageBody,
  clientId = "client-1",
): StreamMessage {
  return {
    protocolVersion: 1,
    clientId,
    subscriptionId,
    ...value,
  } as StreamMessage;
}

function subscriptions(transport: FakeTransport) {
  return transport.controls.filter(
    (
      command,
    ): command is Extract<
      RendererStreamCommand,
      { readonly type: "subscribe" }
    > => command.type === "subscribe",
  );
}

describe("renderer remote Event", () => {
  test("shares a generation, gates values on subscribed, and never replays", async () => {
    const transport = eventTransport();
    const api = await createRendererApi<EventBridge>(transport);
    const firstValues: string[] = [];
    const first = api.hardware.fault$.subscribe((value) =>
      firstValues.push(value),
    );
    const id = subscriptions(transport)[0]!.subscriptionId;

    transport.emitStream(
      message(id, { type: "batch", sequence: 1, values: ["too-early"] }),
    );
    transport.emitStream(message(id, { type: "subscribed", sequence: 0 }));
    transport.emitStream(
      message(id, { type: "batch", sequence: 1, values: ["first"] }),
    );
    expect(firstValues).toEqual(["first"]);

    const secondValues: string[] = [];
    const second = api.hardware.fault$.subscribe((value) =>
      secondValues.push(value),
    );
    expect(subscriptions(transport)).toHaveLength(1);
    expect(secondValues).toEqual([]);
    transport.emitStream(
      message(id, { type: "batch", sequence: 2, values: ["second"] }),
    );
    expect(firstValues).toEqual(["first", "second"]);
    expect(secondValues).toEqual(["second"]);

    first.unsubscribe();
    expect(
      transport.controls.filter((command) => command.type === "unsubscribe"),
    ).toHaveLength(0);
    second.unsubscribe();
    expect(transport.controls.at(-1)).toEqual({
      type: "unsubscribe",
      subscriptionId: id,
    });
  });

  test("delivers a batch synchronously in order before ACK and ignores non-increasing sequences", async () => {
    const transport = eventTransport();
    const api = await createRendererApi<EventBridge>(transport);
    const timeline: string[] = [];
    transport.controlHook = (command) => {
      if (command.type === "acknowledge") {
        timeline.push(`ack:${command.sequence}`);
      }
    };
    const subscription = api.hardware.fault$.subscribe((value) =>
      timeline.push(value),
    );
    const id = subscriptions(transport)[0]!.subscriptionId;
    transport.emitStream(message(id, { type: "subscribed", sequence: 5 }));
    transport.emitStream(
      message(id, { type: "batch", sequence: 6, values: ["a", "b"] }),
    );
    transport.emitStream(
      message(id, { type: "batch", sequence: 6, values: ["duplicate"] }),
    );
    transport.emitStream(
      message(id, { type: "batch", sequence: 4, values: ["decreasing"] }),
    );

    expect(timeline).toEqual(["a", "b", "ack:6"]);
    expect(
      transport.controls.filter((command) => command.type === "acknowledge"),
    ).toEqual([{ type: "acknowledge", subscriptionId: id, sequence: 6 }]);
    subscription.unsubscribe();
  });

  test("acknowledges an accepted batch after a synchronous last-subscriber unsubscribe", async () => {
    const transport = eventTransport();
    const api = await createRendererApi<EventBridge>(transport);
    const timeline: string[] = [];
    transport.controlHook = (command) => {
      if (command.type === "unsubscribe") {
        timeline.push("unsubscribe");
      } else if (command.type === "acknowledge") {
        timeline.push("acknowledge");
      }
    };
    let subscription!: ReturnType<typeof api.hardware.fault$.subscribe>;
    subscription = api.hardware.fault$.subscribe((value) => {
      timeline.push(value);
      subscription.unsubscribe();
    });
    const id = subscriptions(transport)[0]!.subscriptionId;
    transport.emitStream(message(id, { type: "subscribed", sequence: 0 }));

    transport.emitStream(
      message(id, { type: "batch", sequence: 1, values: ["first", "second"] }),
    );

    expect(timeline).toEqual(["first", "unsubscribe", "acknowledge"]);
  });

  test("closes only the current generation and discards wrong-session and closed-ID messages", async () => {
    const transport = eventTransport();
    const api = await createRendererApi<EventBridge>(transport);
    const firstValues: string[] = [];
    let completed = 0;
    api.hardware.fault$.subscribe({
      next: (value) => firstValues.push(value),
      complete: () => {
        completed += 1;
      },
    });
    const firstId = subscriptions(transport)[0]!.subscriptionId;
    transport.emitStream(message(firstId, { type: "subscribed", sequence: 0 }));
    transport.emitStream(
      message(
        firstId,
        { type: "batch", sequence: 1, values: ["wrong"] },
        "old-client",
      ),
    );
    transport.emitStream(message(firstId, { type: "complete", sequence: 2 }));
    transport.emitStream(
      message(firstId, { type: "batch", sequence: 3, values: ["late"] }),
    );
    expect(firstValues).toEqual([]);
    expect(completed).toBe(1);

    const errors: unknown[] = [];
    api.hardware.fault$.subscribe({ error: (error) => errors.push(error) });
    const secondId = subscriptions(transport)[1]!.subscriptionId;
    expect(secondId).not.toBe(firstId);
    transport.emitStream(
      message(secondId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      message(secondId, {
        type: "error",
        sequence: 1,
        error: { code: "SOURCE_FAILED", message: "stream failed" },
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RemoteError);
    expect(errors[0]).toMatchObject({
      code: "SOURCE_FAILED",
      message: "stream failed",
    });
  });

  test("opens a fresh generation when an error callback subscribes again", async () => {
    const transport = eventTransport();
    const api = await createRendererApi<EventBridge>(transport);
    const nextValues: string[] = [];

    api.hardware.fault$.subscribe({
      error: () => {
        api.hardware.fault$.subscribe((value) => nextValues.push(value));
      },
    });
    const firstId = subscriptions(transport)[0]!.subscriptionId;
    transport.emitStream(message(firstId, { type: "subscribed", sequence: 0 }));
    transport.emitStream(
      message(firstId, {
        type: "error",
        sequence: 1,
        error: { code: "SOURCE_FAILED", message: "stream failed" },
      }),
    );

    expect(subscriptions(transport)).toHaveLength(2);
    const secondId = subscriptions(transport)[1]!.subscriptionId;
    expect(secondId).not.toBe(firstId);
    transport.emitStream(
      message(firstId, { type: "batch", sequence: 2, values: ["late"] }),
    );
    transport.emitStream(
      message(secondId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      message(secondId, { type: "batch", sequence: 1, values: ["fresh"] }),
    );
    expect(nextValues).toEqual(["fresh"]);
  });

  test("routes subscribed and a synchronous first batch through the pre-registered generation", async () => {
    const transport = eventTransport();
    const wireOrder: string[] = [];
    transport.controlHook = (command) => {
      if (command.type === "subscribe") {
        wireOrder.push("subscribe");
        transport.emitStream(
          message(command.subscriptionId, { type: "subscribed", sequence: 0 }),
        );
        wireOrder.push("subscribed");
        transport.emitStream(
          message(command.subscriptionId, {
            type: "batch",
            sequence: 1,
            values: ["synchronous"],
          }),
        );
      } else if (command.type === "acknowledge") {
        wireOrder.push("acknowledge");
      }
    };
    const api = await createRendererApi<EventBridge>(transport);

    const subscription = api.hardware.fault$.subscribe((value) =>
      wireOrder.push(value),
    );

    expect(wireOrder).toEqual([
      "subscribe",
      "subscribed",
      "synchronous",
      "acknowledge",
    ]);
    subscription.unsubscribe();
  });
});
