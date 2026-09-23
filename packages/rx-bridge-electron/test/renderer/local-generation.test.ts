import { Observable } from "rxjs";
import { describe, expect, test } from "vitest";

import { LocalGeneration } from "../../src/renderer/local-generation.js";
import { StreamMultiplexer } from "../../src/renderer/stream-multiplexer.js";
import type { StreamMessage } from "../../src/protocol/index.js";
import { FakeTransport } from "./fake-transport.js";

function message(
  subscriptionId: string,
  body: Pick<StreamMessage, "type" | "sequence"> & Record<string, unknown>,
): StreamMessage {
  return {
    protocolVersion: 1,
    clientId: "client-1",
    subscriptionId,
    ...body,
  } as StreamMessage;
}

describe("renderer local generation", () => {
  test("retires the old generation before terminal notification and reopens from its callback", () => {
    const transport = new FakeTransport();
    const multiplexer = new StreamMultiplexer(transport, {
      protocolVersion: 1,
      clientId: "client-1",
    });
    const timeline: string[] = [];
    const local = new LocalGeneration<string>(
      multiplexer,
      "event:hardware/fault$",
      {
        onOpen: () => timeline.push("open"),
        beforeNext: (value) => timeline.push(`before:${value}`),
        onClose: () => timeline.push("close"),
      },
    );
    const stream = new Observable<string>((subscriber) =>
      local.subscribe(subscriber),
    );
    const nextValues: string[] = [];

    stream.subscribe({
      complete: () => {
        timeline.push("complete");
        stream.subscribe((value) => nextValues.push(value));
      },
    });
    const firstId = transport.controls.find(
      (command) => command.type === "subscribe",
    )!.subscriptionId;
    transport.emitStream(message(firstId, { type: "subscribed", sequence: 0 }));
    transport.emitStream(message(firstId, { type: "complete", sequence: 1 }));

    const subscribeCommands = transport.controls.filter(
      (command) => command.type === "subscribe",
    );
    expect(subscribeCommands).toHaveLength(2);
    const secondId = subscribeCommands[1]!.subscriptionId;
    expect(secondId).not.toBe(firstId);
    expect(timeline).toEqual(["open", "close", "complete", "open"]);

    transport.emitStream(
      message(secondId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      message(secondId, { type: "batch", sequence: 1, values: ["fresh"] }),
    );
    expect(nextValues).toEqual(["fresh"]);
    expect(timeline.at(-1)).toBe("before:fresh");
  });
});
