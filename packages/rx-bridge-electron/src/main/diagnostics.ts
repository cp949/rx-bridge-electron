import type { BridgeDiagnostic, DiagnosticsSink } from "./types.js";

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
