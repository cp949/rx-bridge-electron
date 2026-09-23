import type { BridgeDiagnostic, DiagnosticsSink } from "./types.js";

/**
 * Adapter-only recording pathway for rejections the adapter itself judges
 * (`frame-not-main`, `origin-not-allowed`, `malformed-envelope`). Not exported
 * from `./index.js` so user-defined `StreamBridgeServer` implementations never
 * need to know about it. Lives here, not in `create-bridge-server.ts`, because
 * `electron-adapter.ts` is bundled into preload and must not pull the server
 * (and `rxjs`) in at runtime.
 */
export const recordAdapterRejection = Symbol("recordAdapterRejection");

export function recordDiagnostic(
  sink: DiagnosticsSink | undefined,
  event: BridgeDiagnostic,
): void {
  if (sink === undefined) return;
  try {
    sink.record(event);
  } catch {
    // A sink failure must not affect bridge behavior.
  }
}
