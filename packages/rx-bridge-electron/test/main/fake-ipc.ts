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

  // main frame 탐색을 흉내 낸다. Electron은 탐색 시작이 커밋보다 먼저
  // 일어나므로(`did-start-navigation`), lifecycle 알림을 먼저 쏘고 나서
  // 현재 main frame id를 바꾼다(ADR 0015: routingId는 retire 없이 바뀌지 않는다).
  public replaceMainFrame(newFrameId: number): void {
    this.fireLifecycle("main-frame-navigation");
    this.mainFrameId = newFrameId;
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
