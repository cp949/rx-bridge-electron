import { EventEmitter } from "node:events";

import type { AttachedTarget, SenderIdentity } from "../../src/main/index.js";

export const sender = (
  overrides: Partial<SenderIdentity> = {},
): SenderIdentity => ({
  webContentsId: 1,
  frameId: 10,
  isMainFrame: true,
  origin: "app://local",
  ...overrides,
});

// server.handshake(sender, value)의 두 번째 인자는 envelope 객체다(ADR 0016 —
// 옛 시그니처는 clientId 문자열이었다).
export const handshakeRequest = (
  clientId: string,
): { readonly protocolVersion: 1; readonly clientId: string } => ({
  protocolVersion: 1,
  clientId,
});

export class FakeTarget implements AttachedTarget {
  public readonly webContentsId: number;
  public readonly role: string;
  // 현재 main frame의 frameId. `sender()` 기본값(10)과 맞춘다. 실제
  // adapter(`contents.mainFrame.routingId`)처럼 탐색이 일어나면 바뀐다.
  private mainFrameId: number;
  private readonly listeners = new Set<
    (
      reason: "main-frame-navigation" | "render-process-gone" | "destroyed",
    ) => void
  >();

  public constructor(webContentsId = 1, role = "main", mainFrameId = 10) {
    this.webContentsId = webContentsId;
    this.role = role;
    this.mainFrameId = mainFrameId;
  }

  public isCurrentMainFrame(value: SenderIdentity): boolean {
    return (
      value.webContentsId === this.webContentsId &&
      value.isMainFrame &&
      value.frameId === this.mainFrameId
    );
  }

  // main frame 문서 교체(commit)를 흉내 낸다. commit 이벤트(ADR 0019
  // 실험)는 발생 시점에 이미 `contents.mainFrame.routingId`가 새
  // 값으로 바뀌어 있다 — 그래서 frame id를 먼저 바꾸고 나서 lifecycle 알림을 쏜다
  // (구 `did-start-navigation`은 반대로 커밋 전이라 순서가 달랐다).
  public replaceMainFrame(newFrameId: number): void {
    this.mainFrameId = newFrameId;
    this.fireLifecycle("main-frame-navigation");
  }

  public isAllowedOrigin(origin: string): boolean {
    return origin === "app://local";
  }

  public onLifecycle(
    listener: (
      reason: "main-frame-navigation" | "render-process-gone" | "destroyed",
    ) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public endDocument(): void {
    this.fireLifecycle("main-frame-navigation");
  }

  public fireLifecycle(
    reason: "main-frame-navigation" | "render-process-gone" | "destroyed",
  ): void {
    for (const listener of this.listeners) listener(reason);
  }
}

/** Minimal fake standing in for Electron's `ipcMain`: adds `handle`/`removeHandler` over a plain EventEmitter. */
export class FakeIpcMain extends EventEmitter {
  public readonly handlers = new Map<
    string,
    (event: unknown, value: unknown) => unknown
  >();

  // Electron `ipcMain.handle`처럼 같은 채널의 두 번째 등록은 throw한다.
  public handle(
    channel: string,
    listener: (event: unknown, value: unknown) => unknown,
  ): void {
    if (this.handlers.has(channel))
      throw new Error(
        `Attempted to register a second handler for '${channel}'`,
      );
    this.handlers.set(channel, listener);
  }

  public removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
}

/** Minimal fake standing in for Electron's `WebContents`: id + mainFrame(routingId, url) + EventEmitter lifecycle events. */
export class FakeWebContents extends EventEmitter {
  public readonly id: number;
  public readonly mainFrame: {
    readonly routingId: number;
    readonly url: string;
  };

  public constructor(id = 1, routingId = 10, url = "app://local") {
    super();
    this.id = id;
    this.mainFrame = { routingId, url };
  }
}
