const sessionNonce =
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

let nextSequence = 0;

/** Returns an opaque ID that is never reused during this document session. */
export function createOpaqueId(scope: string): string {
  if (nextSequence >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Renderer ID space exhausted.");
  }
  nextSequence += 1;
  return `${sessionNonce}:${scope}:${nextSequence.toString(36)}`;
}
