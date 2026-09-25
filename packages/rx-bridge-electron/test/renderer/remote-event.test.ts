import { describe, expect, test } from "vitest";

import { createRendererApi, RemoteError } from "../../src/renderer/index.js";
import type { StreamMessage } from "../../src/protocol/index.js";
import { FakeTransport, streamMessage } from "./fake-transport.js";

interface EventBridge {
  readonly hardware: {
    readonly event: {
      readonly fault$: string;
    };
  };
}

describe("renderer remote Event", () => {
  test("shares a generation, gates values on subscribed, and never replays", async () => {
    const transport = new FakeTransport({
      manifest: { event: ["event:hardware/fault$"] },
    });
    const api = await createRendererApi<EventBridge>({ transport });
    const firstValues: string[] = [];
    const first = api.hardware.event.fault$.subscribe((value) =>
      firstValues.push(value),
    );
    const id = transport.subscriptionIdFor("event:hardware/fault$", 0);

    transport.emitStream(
      streamMessage(id, {
        type: "batch",
        sequence: 1,
        values: ["too-early"],
      }),
    );
    transport.emitStream(
      streamMessage(id, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(id, { type: "batch", sequence: 1, values: ["first"] }),
    );
    expect(firstValues).toEqual(["first"]);

    const secondValues: string[] = [];
    const second = api.hardware.event.fault$.subscribe((value) =>
      secondValues.push(value),
    );
    expect(transport.subscribeCommands()).toHaveLength(1);
    expect(secondValues).toEqual([]);
    transport.emitStream(
      streamMessage(id, { type: "batch", sequence: 2, values: ["second"] }),
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
    const transport = new FakeTransport({
      manifest: { event: ["event:hardware/fault$"] },
    });
    const api = await createRendererApi<EventBridge>({ transport });
    const timeline: string[] = [];
    transport.controlHook = (command) => {
      if (command.type === "acknowledge") {
        timeline.push(`ack:${command.sequence}`);
      }
    };
    const subscription = api.hardware.event.fault$.subscribe((value) =>
      timeline.push(value),
    );
    const id = transport.subscriptionIdFor("event:hardware/fault$", 0);
    transport.emitStream(
      streamMessage(id, { type: "subscribed", sequence: 5 }),
    );
    transport.emitStream(
      streamMessage(id, { type: "batch", sequence: 6, values: ["a", "b"] }),
    );
    transport.emitStream(
      streamMessage(id, {
        type: "batch",
        sequence: 6,
        values: ["duplicate"],
      }),
    );
    transport.emitStream(
      streamMessage(id, {
        type: "batch",
        sequence: 4,
        values: ["decreasing"],
      }),
    );

    expect(timeline).toEqual(["a", "b", "ack:6"]);
    expect(
      transport.controls.filter((command) => command.type === "acknowledge"),
    ).toEqual([{ type: "acknowledge", subscriptionId: id, sequence: 6 }]);
    subscription.unsubscribe();
  });

  test("acknowledges an accepted batch after a synchronous last-subscriber unsubscribe", async () => {
    const transport = new FakeTransport({
      manifest: { event: ["event:hardware/fault$"] },
    });
    const api = await createRendererApi<EventBridge>({ transport });
    const timeline: string[] = [];
    transport.controlHook = (command) => {
      if (command.type === "unsubscribe") {
        timeline.push("unsubscribe");
      } else if (command.type === "acknowledge") {
        timeline.push("acknowledge");
      }
    };
    let subscription!: ReturnType<typeof api.hardware.event.fault$.subscribe>;
    subscription = api.hardware.event.fault$.subscribe((value) => {
      timeline.push(value);
      subscription.unsubscribe();
    });
    const id = transport.subscriptionIdFor("event:hardware/fault$", 0);
    transport.emitStream(
      streamMessage(id, { type: "subscribed", sequence: 0 }),
    );

    transport.emitStream(
      streamMessage(id, {
        type: "batch",
        sequence: 1,
        values: ["first", "second"],
      }),
    );

    expect(timeline).toEqual(["first", "unsubscribe", "acknowledge"]);
  });

  test("closes only the current generation and discards wrong-session and closed-ID messages", async () => {
    const transport = new FakeTransport({
      manifest: { event: ["event:hardware/fault$"] },
    });
    const api = await createRendererApi<EventBridge>({ transport });
    const firstValues: string[] = [];
    let completed = 0;
    api.hardware.event.fault$.subscribe({
      next: (value) => firstValues.push(value),
      complete: () => {
        completed += 1;
      },
    });
    const firstId = transport.subscriptionIdFor("event:hardware/fault$", 0);
    transport.emitStream(
      streamMessage(firstId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream({
      protocolVersion: 1,
      clientId: "old-client",
      subscriptionId: firstId,
      type: "batch",
      sequence: 1,
      values: ["wrong"],
    } as StreamMessage);
    transport.emitStream(
      streamMessage(firstId, { type: "complete", sequence: 2 }),
    );
    transport.emitStream(
      streamMessage(firstId, { type: "batch", sequence: 3, values: ["late"] }),
    );
    expect(firstValues).toEqual([]);
    expect(completed).toBe(1);

    const errors: unknown[] = [];
    api.hardware.event.fault$.subscribe({
      error: (error) => errors.push(error),
    });
    const secondId = transport.subscriptionIdFor("event:hardware/fault$", 1);
    expect(secondId).not.toBe(firstId);
    transport.emitStream(
      streamMessage(secondId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(secondId, {
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
    const transport = new FakeTransport({
      manifest: { event: ["event:hardware/fault$"] },
    });
    const api = await createRendererApi<EventBridge>({ transport });
    const nextValues: string[] = [];

    api.hardware.event.fault$.subscribe({
      error: () => {
        api.hardware.event.fault$.subscribe((value) => nextValues.push(value));
      },
    });
    const firstId = transport.subscriptionIdFor("event:hardware/fault$", 0);
    transport.emitStream(
      streamMessage(firstId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(firstId, {
        type: "error",
        sequence: 1,
        error: { code: "SOURCE_FAILED", message: "stream failed" },
      }),
    );

    expect(transport.subscribeCommands()).toHaveLength(2);
    const secondId = transport.subscriptionIdFor("event:hardware/fault$", 1);
    expect(secondId).not.toBe(firstId);
    transport.emitStream(
      streamMessage(firstId, { type: "batch", sequence: 2, values: ["late"] }),
    );
    transport.emitStream(
      streamMessage(secondId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(secondId, {
        type: "batch",
        sequence: 1,
        values: ["fresh"],
      }),
    );
    expect(nextValues).toEqual(["fresh"]);
  });

  test("opens a fresh generation when a complete callback subscribes again", async () => {
    const transport = new FakeTransport({
      manifest: { event: ["event:hardware/fault$"] },
    });
    const api = await createRendererApi<EventBridge>({ transport });
    const nextValues: string[] = [];

    api.hardware.event.fault$.subscribe({
      complete: () => {
        api.hardware.event.fault$.subscribe((value) => nextValues.push(value));
      },
    });
    const firstId = transport.subscriptionIdFor("event:hardware/fault$", 0);
    transport.emitStream(
      streamMessage(firstId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(firstId, { type: "complete", sequence: 1 }),
    );

    expect(transport.subscribeCommands()).toHaveLength(2);
    const secondId = transport.subscriptionIdFor("event:hardware/fault$", 1);
    expect(secondId).not.toBe(firstId);
    transport.emitStream(
      streamMessage(firstId, { type: "batch", sequence: 2, values: ["late"] }),
    );
    transport.emitStream(
      streamMessage(secondId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(secondId, {
        type: "batch",
        sequence: 1,
        values: ["fresh"],
      }),
    );
    expect(nextValues).toEqual(["fresh"]);
  });

  test("routes subscribed and a synchronous first batch through the pre-registered generation", async () => {
    const transport = new FakeTransport({
      manifest: { event: ["event:hardware/fault$"] },
    });
    const wireOrder: string[] = [];
    transport.controlHook = (command) => {
      if (command.type === "subscribe") {
        wireOrder.push("subscribe");
        transport.emitStream(
          streamMessage(command.subscriptionId, {
            type: "subscribed",
            sequence: 0,
          }),
        );
        wireOrder.push("subscribed");
        transport.emitStream(
          streamMessage(command.subscriptionId, {
            type: "batch",
            sequence: 1,
            values: ["synchronous"],
          }),
        );
      } else if (command.type === "acknowledge") {
        wireOrder.push("acknowledge");
      }
    };
    const api = await createRendererApi<EventBridge>({ transport });

    const subscription = api.hardware.event.fault$.subscribe((value) =>
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
