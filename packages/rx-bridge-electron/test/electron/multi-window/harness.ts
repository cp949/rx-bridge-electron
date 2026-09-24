import { _electron as electron, type Page } from "@playwright/test";
import { expect } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { bundleFixture } from "../bundle-fixture.js";
import type { MultiWindowProbe } from "./main.js";
import type * as FixtureRenderer from "./renderer.js";

export type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
export type Role = "editor" | "viewer";

declare global {
  var __rxBridgeProbe: MultiWindowProbe;
  var fixtureRenderer: typeof FixtureRenderer;
}

const electronExecutable = createRequire(import.meta.url)("electron") as string;
const fixtureRenderer = fileURLToPath(
  new URL("./renderer.html", import.meta.url),
);

export function bundleMultiWindowFixture(): ReturnType<typeof bundleFixture> {
  return bundleFixture(
    "test/electron/multi-window",
    "rx-bridge-electron-multi-window",
  );
}

export async function launch(
  fixture: ReturnType<typeof bundleFixture>,
): Promise<ElectronApp> {
  return electron.launch({
    executablePath: electronExecutable,
    args: [fixture.main],
    env: {
      ...process.env,
      RX_BRIDGE_PRELOAD: fixture.preload,
      RX_BRIDGE_RENDERER: fixtureRenderer,
    },
  });
}

/**
 * 역할 창이 열리고 Renderer API handshake가 끝날 때까지 기다린다.
 * 창 URL이 보여도 번들 스크립트가 아직 실행되지 않았을 수 있어 전역 준비를 따로 기다린다.
 */
export async function windowFor(app: ElectronApp, role: Role): Promise<Page> {
  let page: Page | undefined;
  await expect
    .poll(() => {
      page = app
        .windows()
        .find((candidate) => candidate.url().includes(`role=${role}`));
      return page !== undefined;
    })
    .toBe(true);
  await page!.waitForFunction(() => globalThis.fixtureRenderer !== undefined);
  await expect(
    page!.evaluate(() => globalThis.fixtureRenderer.ready()),
  ).resolves.toBe(role);
  return page!;
}

/**
 * Renderer의 dispose 호출 없이 role 창을 Main 쪽에서 강제로 닫는다(사용자가 창의 X 버튼을
 * 누르는 것과 동일한 경로). `BrowserWindow#close()`가 실제 `closed` 이벤트를 내고 그 안에서
 * `webContents`가 `destroyed`되므로, `bindElectronBridge`가 등록한 `contents.once("destroyed",
 * ...)` 리스너를 거쳐 Main 쪽 세션 회수가 일어나는지 검증할 수 있다.
 */
export async function closeWindow(app: ElectronApp, role: Role): Promise<void> {
  await app.evaluate(({ BrowserWindow }, targetRole) => {
    const target = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes(`role=${targetRole}`),
    );
    target?.close();
  }, role);
}
