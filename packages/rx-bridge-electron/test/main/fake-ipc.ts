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

export class FakeTarget implements AttachedTarget {
  public readonly webContentsId: number;
  public readonly role: string;
  private readonly listeners = new Set<
    (
      reason: "main-frame-navigation" | "render-process-gone" | "destroyed",
    ) => void
  >();

  public constructor(webContentsId = 1, role = "main") {
    this.webContentsId = webContentsId;
    this.role = role;
  }

  public isCurrentMainFrame(value: SenderIdentity): boolean {
    return value.webContentsId === this.webContentsId && value.isMainFrame;
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
