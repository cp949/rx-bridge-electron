import { describe, expect, test } from "vitest";

import type { RemoteState } from "../../src/contract/index.js";
import {
  createRendererApi,
  type RendererApi,
} from "../../src/renderer/index.js";
import type { StreamMessage } from "../../src/protocol/index.js";
import { FakeTransport } from "./fake-transport.js";

interface StateBridge {
  readonly hardware: {
    readonly connection$: RemoteState<string | undefined>;
  };
}

type StreamMessageBody = StreamMessage extends infer Message
  ? Message extends StreamMessage
    ? Omit<Message, "protocolVersion" | "clientId" | "subscriptionId">
    : never
  : never;

function stateTransport(): FakeTransport {
  const transport = new FakeTransport();
  transport.handshake = Promise.resolve({
    protocolVersion: 1,
    clientId: "client-1",
    manifest: {
      rpc: [],
      state: ["state:hardware/connection$"],
      event: [],
    },
  });
  return transport;
}

function message(
  subscriptionId: string,
  value: StreamMessageBody,
): StreamMessage {
  return {
    protocolVersion: 1,
    clientId: "client-1",
    subscriptionId,
    ...value,
  } as StreamMessage;
}

function firstSubscriptionId(transport: FakeTransport): string {
  const command = transport.controls.find(
    (candidate) => candidate.type === "subscribe",
  );
  if (command?.type !== "subscribe") {
    throw new Error("Missing State subscribe command.");
  }
  return command.subscriptionId;
}

describe("renderer RemoteState", () => {
  test("shares one remote generation and updates the snapshot before delivering legitimate undefined", async () => {
    const transport = stateTransport();
    const api = await createRendererApi<StateBridge>(transport);
    const state = api.hardware.connection$;
    const observed: Array<{
      readonly value: string | undefined;
      readonly snapshot: unknown;
    }> = [];

    expect(state.snapshot).toEqual({ status: "uninitialized", active: false });
    const first = state.subscribe((value) => {
      observed.push({ value, snapshot: state.snapshot });
    });
    expect(state.snapshot).toEqual({ status: "connecting", active: true });
    const secondValues: Array<string | undefined> = [];
    const second = state.subscribe((value) => secondValues.push(value));

    expect(transport.controls).toHaveLength(1);
    expect(transport.controls[0]).toMatchObject({
      type: "subscribe",
      key: "state:hardware/connection$",
    });
    const subscriptionId = firstSubscriptionId(transport);
    transport.emitStream(
      message(subscriptionId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      message(subscriptionId, {
        type: "batch",
        sequence: 1,
        values: [undefined],
      }),
    );

    expect(observed).toEqual([
      {
        value: undefined,
        snapshot: { status: "current", active: true, value: undefined },
      },
    ]);
    expect(secondValues).toEqual([undefined]);
    first.unsubscribe();
    expect(
      transport.controls.filter((command) => command.type === "unsubscribe"),
    ).toHaveLength(0);
    second.unsubscribe();
    expect(state.snapshot).toEqual({
      status: "stale",
      active: false,
      value: undefined,
    });
    expect(transport.controls.at(-1)).toEqual({
      type: "unsubscribe",
      subscriptionId,
    });
  });

  test("opens a new ID without replaying stale data and discards the closed generation", async () => {
    const transport = stateTransport();
    const api = await createRendererApi<StateBridge>(transport);
    const state = api.hardware.connection$;
    const firstValues: Array<string | undefined> = [];
    const first = state.subscribe((value) => firstValues.push(value));
    const firstId = firstSubscriptionId(transport);
    transport.emitStream(message(firstId, { type: "subscribed", sequence: 0 }));
    transport.emitStream(
      message(firstId, { type: "batch", sequence: 1, values: ["old"] }),
    );
    first.unsubscribe();

    const nextValues: Array<string | undefined> = [];
    const next = state.subscribe((value) => nextValues.push(value));
    const subscribeCommands = transport.controls.filter(
      (
        command,
      ): command is Extract<typeof command, { readonly type: "subscribe" }> =>
        command.type === "subscribe",
    );
    const secondId = subscribeCommands[1]?.subscriptionId;
    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);
    expect(state.snapshot).toEqual({ status: "connecting", active: true });
    expect(nextValues).toEqual([]);

    transport.emitStream(
      message(firstId, { type: "batch", sequence: 2, values: ["late"] }),
    );
    expect(nextValues).toEqual([]);
    transport.emitStream(
      message(secondId!, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      message(secondId!, { type: "batch", sequence: 1, values: ["fresh"] }),
    );
    expect(nextValues).toEqual(["fresh"]);
    next.unsubscribe();
  });

  test("opens a fresh generation when a terminal callback subscribes again", async () => {
    const transport = stateTransport();
    const api = await createRendererApi<StateBridge>(transport);
    const state = api.hardware.connection$;
    const snapshots: unknown[] = [];
    const nextValues: Array<string | undefined> = [];

    state.subscribe({
      complete: () => {
        snapshots.push(state.snapshot);
        state.subscribe((value) => nextValues.push(value));
        snapshots.push(state.snapshot);
      },
    });
    const firstId = firstSubscriptionId(transport);
    transport.emitStream(message(firstId, { type: "subscribed", sequence: 0 }));
    transport.emitStream(
      message(firstId, { type: "batch", sequence: 1, values: ["old"] }),
    );
    transport.emitStream(message(firstId, { type: "complete", sequence: 2 }));

    const subscribeCommands = transport.controls.filter(
      (command) => command.type === "subscribe",
    );
    expect(subscribeCommands).toHaveLength(2);
    const secondId = subscribeCommands[1]!.subscriptionId;
    expect(secondId).not.toBe(firstId);
    expect(snapshots).toEqual([
      { status: "stale", active: false, value: "old" },
      { status: "connecting", active: true },
    ]);
    transport.emitStream(
      message(firstId, { type: "batch", sequence: 3, values: ["late"] }),
    );
    transport.emitStream(
      message(secondId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      message(secondId, { type: "batch", sequence: 1, values: ["fresh"] }),
    );
    expect(nextValues).toEqual(["fresh"]);
  });

  test("registers one listener per API, handles synchronous delivery, and removes it on disposal", async () => {
    const transport = stateTransport();
    transport.controlHook = (command) => {
      if (command.type !== "subscribe") {
        return;
      }
      transport.emitStream(
        message(command.subscriptionId, { type: "subscribed", sequence: 0 }),
      );
      transport.emitStream(
        message(command.subscriptionId, {
          type: "batch",
          sequence: 1,
          values: ["synchronous"],
        }),
      );
    };
    const api = await createRendererApi<StateBridge>(transport);
    const snapshots: unknown[] = [];

    const subscription = api.hardware.connection$.subscribe(() => {
      snapshots.push(api.hardware.connection$.snapshot);
    });

    expect(transport.streamListenerRegistrations).toBe(1);
    expect(transport.streamListeners.size).toBe(1);
    expect(snapshots).toEqual([
      { status: "current", active: true, value: "synchronous" },
    ]);
    api[Symbol.dispose]();
    expect(transport.streamListeners.size).toBe(0);
    expect(subscription.closed).toBe(true);
  });

  test("preserves stream types while adding renderer RPC options", () => {
    expectTypeAssignment({} as RendererApi<StateBridge>);
  });
});

function expectTypeAssignment(_api: RendererApi<StateBridge>): void {}
