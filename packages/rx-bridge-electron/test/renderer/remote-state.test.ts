import { firstValueFrom, take } from "rxjs";
import { describe, expect, expectTypeOf, test } from "vitest";

import {
  createRendererApi,
  type RendererApi,
} from "../../src/renderer/index.js";
import { FakeTransport, streamMessage } from "./fake-transport.js";

interface StateBridge {
  readonly hardware: {
    readonly state: {
      readonly connection$: string | undefined;
    };
  };
}

describe("renderer RemoteState", () => {
  test("shares one remote generation and updates the snapshot before delivering legitimate undefined", async () => {
    const transport = new FakeTransport({ manifest: { state: ["state:hardware/connection$"] } });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
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
    const subscriptionId = transport.subscriptionIdFor("state:hardware/connection$");
    transport.emitStream(
      streamMessage(subscriptionId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(subscriptionId, {
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

  test("delivers the current value synchronously to a late subscriber joining an active generation", async () => {
    const transport = new FakeTransport({ manifest: { state: ["state:hardware/connection$"] } });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const first = state.subscribe(() => {});
    const subscriptionId = transport.subscriptionIdFor("state:hardware/connection$");
    transport.emitStream(
      streamMessage(subscriptionId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(subscriptionId, { type: "batch", sequence: 1, values: ["a"] }),
    );

    const secondValues: Array<string | undefined> = [];
    const snapshotsDuringDelivery: unknown[] = [];
    const second = state.subscribe((value) => {
      secondValues.push(value);
      snapshotsDuringDelivery.push(state.snapshot);
    });

    expect(secondValues).toEqual(["a"]);
    expect(snapshotsDuringDelivery).toEqual([
      { status: "current", active: true, value: "a" },
    ]);

    first.unsubscribe();
    second.unsubscribe();
  });

  test("delivers a legitimate undefined current value synchronously to a late subscriber", async () => {
    const transport = new FakeTransport({ manifest: { state: ["state:hardware/connection$"] } });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const first = state.subscribe(() => {});
    const subscriptionId = transport.subscriptionIdFor("state:hardware/connection$");
    transport.emitStream(
      streamMessage(subscriptionId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(subscriptionId, {
        type: "batch",
        sequence: 1,
        values: [undefined],
      }),
    );

    const secondValues: Array<string | undefined> = [];
    const second = state.subscribe((value) => secondValues.push(value));

    expect(secondValues).toEqual([undefined]);

    first.unsubscribe();
    second.unsubscribe();
  });

  test("does not open an additional remote subscription for a late subscriber", async () => {
    const transport = new FakeTransport({ manifest: { state: ["state:hardware/connection$"] } });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const first = state.subscribe(() => {});
    const subscriptionId = transport.subscriptionIdFor("state:hardware/connection$");
    transport.emitStream(
      streamMessage(subscriptionId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(subscriptionId, { type: "batch", sequence: 1, values: ["a"] }),
    );
    expect(
      transport.controls.filter((command) => command.type === "subscribe"),
    ).toHaveLength(1);

    const second = state.subscribe(() => {});
    expect(
      transport.controls.filter((command) => command.type === "subscribe"),
    ).toHaveLength(1);

    first.unsubscribe();
    second.unsubscribe();
    expect(
      transport.controls.filter((command) => command.type === "subscribe"),
    ).toHaveLength(1);
  });

  test("does not deliver to a late subscriber joining before subscribed", async () => {
    const transport = new FakeTransport({ manifest: { state: ["state:hardware/connection$"] } });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const firstValues: Array<string | undefined> = [];
    const first = state.subscribe((value) => firstValues.push(value));
    const secondValues: Array<string | undefined> = [];
    const second = state.subscribe((value) => secondValues.push(value));

    expect(firstValues).toEqual([]);
    expect(secondValues).toEqual([]);

    const subscriptionId = transport.subscriptionIdFor("state:hardware/connection$");
    transport.emitStream(
      streamMessage(subscriptionId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(subscriptionId, { type: "batch", sequence: 1, values: ["x"] }),
    );
    expect(firstValues).toEqual(["x"]);
    expect(secondValues).toEqual(["x"]);

    first.unsubscribe();
    second.unsubscribe();
  });

  test("does not deliver to a late subscriber joining after subscribed but before the first batch", async () => {
    const transport = new FakeTransport({ manifest: { state: ["state:hardware/connection$"] } });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const firstValues: Array<string | undefined> = [];
    const first = state.subscribe((value) => firstValues.push(value));
    const subscriptionId = transport.subscriptionIdFor("state:hardware/connection$");
    transport.emitStream(
      streamMessage(subscriptionId, { type: "subscribed", sequence: 0 }),
    );

    const secondValues: Array<string | undefined> = [];
    const second = state.subscribe((value) => secondValues.push(value));
    expect(firstValues).toEqual([]);
    expect(secondValues).toEqual([]);

    transport.emitStream(
      streamMessage(subscriptionId, { type: "batch", sequence: 1, values: ["x"] }),
    );
    expect(firstValues).toEqual(["x"]);
    expect(secondValues).toEqual(["x"]);

    first.unsubscribe();
    second.unsubscribe();
  });

  test("replays the in-flight value once to a subscriber that joins reentrantly from another subscriber's callback", async () => {
    const transport = new FakeTransport({ manifest: { state: ["state:hardware/connection$"] } });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const firstValues: Array<string | undefined> = [];
    const secondValues: Array<string | undefined> = [];
    let second: { unsubscribe(): void } | undefined;

    const first = state.subscribe((value) => {
      firstValues.push(value);
      if (second === undefined) {
        second = state.subscribe((innerValue) => secondValues.push(innerValue));
      }
    });
    const subscriptionId = transport.subscriptionIdFor("state:hardware/connection$");
    transport.emitStream(
      streamMessage(subscriptionId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(subscriptionId, {
        type: "batch",
        sequence: 1,
        values: ["a", "b"],
      }),
    );

    expect(firstValues).toEqual(["a", "b"]);
    expect(secondValues).toEqual(["a", "b"]);

    first.unsubscribe();
    second?.unsubscribe();
  });

  test("delivers the current value synchronously to firstValueFrom and does not disturb existing subscribers", async () => {
    const transport = new FakeTransport({ manifest: { state: ["state:hardware/connection$"] } });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const firstValues: Array<string | undefined> = [];
    const first = state.subscribe((value) => firstValues.push(value));
    const subscriptionId = transport.subscriptionIdFor("state:hardware/connection$");
    transport.emitStream(
      streamMessage(subscriptionId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(subscriptionId, { type: "batch", sequence: 1, values: ["a"] }),
    );

    const takeValues: Array<string | undefined> = [];
    state.pipe(take(1)).subscribe((value) => takeValues.push(value));
    expect(takeValues).toEqual(["a"]);
    expect(
      transport.controls.filter((command) => command.type === "unsubscribe"),
    ).toHaveLength(0);

    const resolved = await firstValueFrom(state);
    expect(resolved).toBe("a");
    expect(
      transport.controls.filter((command) => command.type === "unsubscribe"),
    ).toHaveLength(0);

    transport.emitStream(
      streamMessage(subscriptionId, { type: "batch", sequence: 2, values: ["b"] }),
    );
    expect(firstValues).toEqual(["a", "b"]);

    first.unsubscribe();
  });

  test("does not replay a value after a remote complete and before a fresh subscribed", async () => {
    const transport = new FakeTransport({ manifest: { state: ["state:hardware/connection$"] } });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const firstValues: Array<string | undefined> = [];
    let completed = 0;
    state.subscribe({
      next: (value) => firstValues.push(value),
      complete: () => {
        completed += 1;
      },
    });
    const firstId = transport.subscriptionIdFor("state:hardware/connection$");
    transport.emitStream(streamMessage(firstId, { type: "subscribed", sequence: 0 }));
    transport.emitStream(
      streamMessage(firstId, { type: "batch", sequence: 1, values: ["old"] }),
    );
    transport.emitStream(streamMessage(firstId, { type: "complete", sequence: 2 }));
    expect(completed).toBe(1);

    const nextValues: Array<string | undefined> = [];
    const next = state.subscribe((value) => nextValues.push(value));
    expect(nextValues).toEqual([]);
    expect(state.snapshot).toEqual({ status: "connecting", active: true });

    const subscribeCommands = transport.controls.filter(
      (command) => command.type === "subscribe",
    );
    expect(subscribeCommands).toHaveLength(2);
    const secondId = subscribeCommands[1]!.subscriptionId;
    expect(secondId).not.toBe(firstId);

    transport.emitStream(
      streamMessage(secondId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(secondId, { type: "batch", sequence: 1, values: ["fresh"] }),
    );
    expect(nextValues).toEqual(["fresh"]);
    next.unsubscribe();
  });

  test("does not replay a value after a remote error and before a fresh subscribed", async () => {
    const transport = new FakeTransport({ manifest: { state: ["state:hardware/connection$"] } });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const firstValues: Array<string | undefined> = [];
    const errors: unknown[] = [];
    state.subscribe({
      next: (value) => firstValues.push(value),
      error: (error) => errors.push(error),
    });
    const firstId = transport.subscriptionIdFor("state:hardware/connection$");
    transport.emitStream(streamMessage(firstId, { type: "subscribed", sequence: 0 }));
    transport.emitStream(
      streamMessage(firstId, { type: "batch", sequence: 1, values: ["old"] }),
    );
    transport.emitStream(
      streamMessage(firstId, {
        type: "error",
        sequence: 2,
        error: { code: "SOURCE_FAILED", message: "stream failed" },
      }),
    );
    expect(errors).toHaveLength(1);

    const nextValues: Array<string | undefined> = [];
    const next = state.subscribe((value) => nextValues.push(value));
    expect(nextValues).toEqual([]);
    expect(state.snapshot).toEqual({ status: "connecting", active: true });

    const subscribeCommands = transport.controls.filter(
      (command) => command.type === "subscribe",
    );
    expect(subscribeCommands).toHaveLength(2);
    const secondId = subscribeCommands[1]!.subscriptionId;
    expect(secondId).not.toBe(firstId);

    transport.emitStream(
      streamMessage(secondId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(secondId, { type: "batch", sequence: 1, values: ["fresh"] }),
    );
    expect(nextValues).toEqual(["fresh"]);
    next.unsubscribe();
  });

  test("opens a new ID without replaying stale data and discards the closed generation", async () => {
    const transport = new FakeTransport({ manifest: { state: ["state:hardware/connection$"] } });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const firstValues: Array<string | undefined> = [];
    const first = state.subscribe((value) => firstValues.push(value));
    const firstId = transport.subscriptionIdFor("state:hardware/connection$");
    transport.emitStream(streamMessage(firstId, { type: "subscribed", sequence: 0 }));
    transport.emitStream(
      streamMessage(firstId, { type: "batch", sequence: 1, values: ["old"] }),
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
      streamMessage(firstId, { type: "batch", sequence: 2, values: ["late"] }),
    );
    expect(nextValues).toEqual([]);
    transport.emitStream(
      streamMessage(secondId!, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(secondId!, { type: "batch", sequence: 1, values: ["fresh"] }),
    );
    expect(nextValues).toEqual(["fresh"]);
    next.unsubscribe();
  });

  test("opens a fresh generation when a terminal callback subscribes again", async () => {
    const transport = new FakeTransport({ manifest: { state: ["state:hardware/connection$"] } });
    const api = await createRendererApi<StateBridge>({ transport });
    const state = api.hardware.state.connection$;
    const snapshots: unknown[] = [];
    const nextValues: Array<string | undefined> = [];

    state.subscribe({
      complete: () => {
        snapshots.push(state.snapshot);
        state.subscribe((value) => nextValues.push(value));
        snapshots.push(state.snapshot);
      },
    });
    const firstId = transport.subscriptionIdFor("state:hardware/connection$");
    transport.emitStream(streamMessage(firstId, { type: "subscribed", sequence: 0 }));
    transport.emitStream(
      streamMessage(firstId, { type: "batch", sequence: 1, values: ["old"] }),
    );
    transport.emitStream(streamMessage(firstId, { type: "complete", sequence: 2 }));

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
      streamMessage(firstId, { type: "batch", sequence: 3, values: ["late"] }),
    );
    transport.emitStream(
      streamMessage(secondId, { type: "subscribed", sequence: 0 }),
    );
    transport.emitStream(
      streamMessage(secondId, { type: "batch", sequence: 1, values: ["fresh"] }),
    );
    expect(nextValues).toEqual(["fresh"]);
  });

  test("registers one listener per API, handles synchronous delivery, and removes it on disposal", async () => {
    const transport = new FakeTransport({ manifest: { state: ["state:hardware/connection$"] } });
    transport.controlHook = (command) => {
      if (command.type !== "subscribe") {
        return;
      }
      transport.emitStream(
        streamMessage(command.subscriptionId, { type: "subscribed", sequence: 0 }),
      );
      transport.emitStream(
        streamMessage(command.subscriptionId, {
          type: "batch",
          sequence: 1,
          values: ["synchronous"],
        }),
      );
    };
    const api = await createRendererApi<StateBridge>({ transport });
    const snapshots: unknown[] = [];

    const subscription = api.hardware.state.connection$.subscribe(() => {
      snapshots.push(api.hardware.state.connection$.snapshot);
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

  test("exposes dispose() as the same function reference as Symbol.dispose", async () => {
    const transport = new FakeTransport({ manifest: { state: ["state:hardware/connection$"] } });
    const api = await createRendererApi<StateBridge>({ transport });

    expect(typeof api.dispose).toBe("function");
    expect(api.dispose).toBe(api[Symbol.dispose]);
  });

  test("api.dispose() tears down active stream subscriptions", async () => {
    const transport = new FakeTransport({ manifest: { state: ["state:hardware/connection$"] } });
    transport.controlHook = (command) => {
      if (command.type !== "subscribe") {
        return;
      }
      transport.emitStream(
        streamMessage(command.subscriptionId, { type: "subscribed", sequence: 0 }),
      );
    };
    const api = await createRendererApi<StateBridge>({ transport });
    api.hardware.state.connection$.subscribe(() => {});

    expect(transport.streamListeners.size).toBe(1);
    api.dispose();
    expect(transport.streamListeners.size).toBe(0);
  });

  test("preserves stream types while adding renderer RPC options", () => {
    expectTypeAssignment({} as RendererApi<StateBridge>);
  });

  test("types dispose() as a callable returning void", () => {
    expectTypeOf<RendererApi<StateBridge>["dispose"]>().toEqualTypeOf<
      () => void
    >();
  });
});

function expectTypeAssignment(_api: RendererApi<StateBridge>): void {}
