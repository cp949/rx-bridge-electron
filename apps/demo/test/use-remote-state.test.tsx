import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import {
  createRendererApi,
  type BridgeTransport,
  type RemoteState,
} from "@cp949/rx-bridge-electron/renderer";
import type {
  RendererStreamCommand,
  StreamMessage,
} from "@cp949/rx-bridge-electron/protocol";

import { useRemoteState } from "../src/renderer/use-remote-state.js";

interface StateBridge {
  readonly hardware: {
    readonly state: { readonly sensor: number };
  };
}

async function stateHarness(): Promise<{
  readonly state: RemoteState<number>;
  readonly controls: RendererStreamCommand[];
  emit(message: StreamMessage): void;
}> {
  const controls: RendererStreamCommand[] = [];
  const listeners = new Set<(message: StreamMessage) => void>();
  const transport: BridgeTransport = {
    connect: async () => ({
      protocolVersion: 1,
      clientId: "client-1",
      manifest: { rpc: [], state: ["state:hardware/sensor"], event: [] },
    }),
    invoke: async () => {
      throw new Error("No RPC is used by this State test.");
    },
    cancel: () => {},
    control(command) {
      controls.push(command);
    },
    onStreamMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const api = await createRendererApi<StateBridge>(transport);
  return {
    state: api.hardware.state.sensor,
    controls,
    emit(message) {
      for (const listener of listeners) listener(message);
    },
  };
}

function subscriptionId(controls: readonly RendererStreamCommand[]): string {
  const command = controls.find((item) => item.type === "subscribe");
  if (command?.type !== "subscribe")
    throw new Error("State subscription missing.");
  return command.subscriptionId;
}

describe("useRemoteState", () => {
  test("keeps one actual remote State generation across a React rerender", async () => {
    const { state, controls } = await stateHarness();
    const { rerender } = renderHook(() => useRemoteState(state));

    rerender();

    expect(
      controls.filter((command) => command.type === "subscribe"),
    ).toHaveLength(1);
    expect(
      controls.filter((command) => command.type === "unsubscribe"),
    ).toHaveLength(0);
  });

  test("renders current and stale snapshots from an actual terminal remote State", async () => {
    const { state, controls, emit } = await stateHarness();
    const { result } = renderHook(() => useRemoteState(state));
    const id = subscriptionId(controls);

    emit({
      protocolVersion: 1,
      clientId: "client-1",
      type: "subscribed",
      subscriptionId: id,
      sequence: 0,
    });
    emit({
      protocolVersion: 1,
      clientId: "client-1",
      type: "batch",
      subscriptionId: id,
      sequence: 1,
      values: [23.5],
    });

    await waitFor(() =>
      expect(result.current).toEqual({
        status: "current",
        active: true,
        value: 23.5,
      }),
    );

    emit({
      protocolVersion: 1,
      clientId: "client-1",
      type: "complete",
      subscriptionId: id,
      sequence: 2,
    });
    await waitFor(() =>
      expect(result.current).toEqual({
        status: "stale",
        active: false,
        value: 23.5,
      }),
    );
  });
});
