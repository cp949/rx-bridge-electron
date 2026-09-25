/*
 * demo 화면의 직접 구독(Event·`sampleTime` State)이 원격 종료를 `error`로
 * 받는지 검증한다. 실제 composition + loopback transport에서 server를 dispose해
 * 모든 구독에 `CANCELLED "Bridge session ended."`를 보낸 뒤, rxjs 미처리
 * 오류가 0건이고 종료 원인이 화면에 보이는지 확인한다.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { config } from "rxjs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createRendererApi } from "@cp949/rx-bridge-electron/renderer";
import { createLoopbackTransport } from "@cp949/rx-bridge-electron/testing";

import type { AppBridge } from "../src/bridge/contract.js";
import { createDemoComposition } from "../src/main/composition.js";
import { MainMonitorApp, SensorMonitorApp } from "../src/renderer/App.js";

const SESSION_ENDED = "CANCELLED: Bridge session ended.";

/**
 * 주어진 role로 실제 composition에 붙은 Renderer API를 만든다.
 * `dispose`는 transport·composition을 정리한다.
 */
async function harness(role: "main" | "monitor") {
  const composition = createDemoComposition();
  const transport = createLoopbackTransport(composition.server, { role });
  const api = await createRendererApi<AppBridge>({ transport });
  return {
    api,
    endSession: () => composition.server.dispose(),
    dispose() {
      api.dispose();
      transport.dispose();
      composition.dispose();
    },
  };
}

/** macrotask 경계까지 진행해 loopback의 microtask 전달을 비운다. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

afterEach(() => {
  config.onUnhandledError = null;
});

describe("demo 직접 구독의 원격 종료 처리", () => {
  test.each([
    ["MainMonitorApp", "main", MainMonitorApp],
    ["SensorMonitorApp", "monitor", SensorMonitorApp],
  ] as const)(
    "%s는 세션 종료를 미처리 오류 없이 화면에 표시한다",
    async (_name, role, App) => {
      const unhandled = vi.fn();
      config.onUnhandledError = unhandled;
      const { api, endSession, dispose } = await harness(role);
      try {
        render(<App api={api} />);
        await act(flush);

        await act(async () => {
          endSession();
          await flush();
        });

        expect(unhandled).not.toHaveBeenCalled();
        await waitFor(() =>
          expect(
            screen.getAllByText(SESSION_ENDED, { exact: false }),
          ).not.toHaveLength(0),
        );
      } finally {
        dispose();
      }
    },
  );
});
