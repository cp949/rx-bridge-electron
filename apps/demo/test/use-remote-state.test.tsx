import { BehaviorSubject, Observable } from "rxjs";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import {
  createRendererApi,
  type RemoteState,
} from "@cp949/rx-bridge-electron/renderer";
import {
  createBridgeServer,
  currentValueSource,
} from "@cp949/rx-bridge-electron/main";
import { createLoopbackTransport } from "@cp949/rx-bridge-electron/testing";
import type { BridgeImpl } from "@cp949/rx-bridge-electron/contract";

import { useRemoteState } from "../src/renderer/use-remote-state.js";

interface StateBridge {
  readonly hardware: {
    readonly state: { readonly sensor: number };
  };
}

/**
 * `hardware.state.sensor`의 실제 upstream(`BehaviorSubject`) 구독 횟수를
 * 센다. server가 같은 key의 wire 구독을 shared upstream 하나로 묶으므로
 * (`Subscriptions#startShared`), React rerender가 실수로
 * unsubscribe→resubscribe 쌍을 만들면 이 카운트가 1을 넘어 늘어난다 —
 * 수기 `RendererStreamCommand` 기록 대신 이 카운트로 "세대 1개"를 확인한다.
 */
function countingSensorSource(initial: number) {
  const subject = new BehaviorSubject(initial);
  let subscribeCount = 0;
  const counted = Object.assign(
    new Observable<number>((subscriber) => {
      subscribeCount++;
      return subject.subscribe(subscriber);
    }),
    { getValue: () => subject.getValue() },
  );
  return {
    source: currentValueSource(counted),
    subject,
    subscribeCount: () => subscribeCount,
  };
}

async function stateHarness(): Promise<{
  readonly state: RemoteState<number>;
  readonly subject: BehaviorSubject<number>;
  readonly subscribeCount: () => number;
  dispose(): void;
}> {
  const sensor = countingSensorSource(23.5);
  const impl: BridgeImpl<StateBridge> = {
    hardware: { state: { sensor: sensor.source } },
  };
  const server = createBridgeServer(impl);
  const transport = createLoopbackTransport(server);
  const api = await createRendererApi<StateBridge>({ transport });
  return {
    state: api.hardware.state.sensor,
    subject: sensor.subject,
    subscribeCount: sensor.subscribeCount,
    dispose() {
      api.dispose();
      transport.dispose();
      server.dispose();
    },
  };
}

describe("useRemoteState", () => {
  test("keeps one actual remote State generation across a React rerender", async () => {
    const { state, subscribeCount, dispose } = await stateHarness();
    try {
      const { result, rerender } = renderHook(() => useRemoteState(state));
      await waitFor(() => expect(result.current.status).toBe("current"));

      rerender();
      expect(result.current.status).toBe("current");

      // loopback은 control을 microtask 뒤에 server로 보낸다 — 재구독 명령이 있었다면
      // server에 도달한 뒤에 upstream 구독 횟수를 센다.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(subscribeCount()).toBe(1);
    } finally {
      dispose();
    }
  });

  test("renders current and stale snapshots from an actual terminal remote State", async () => {
    const { state, subject, dispose } = await stateHarness();
    try {
      const { result } = renderHook(() => useRemoteState(state));

      await waitFor(() =>
        expect(result.current).toEqual({
          status: "current",
          active: true,
          value: 23.5,
        }),
      );

      subject.complete();

      await waitFor(() =>
        expect(result.current).toEqual({
          status: "stale",
          active: false,
          value: 23.5,
        }),
      );
    } finally {
      dispose();
    }
  });
});
