/**
 * Parses the sequence portion of an opaque ID produced by
 * `src/renderer/ids.ts` `createOpaqueId`: `<nonce>:<scope>:<seq base36>`.
 * Returns `undefined` if `id` does not match that format (wrong segment
 * count, empty segment, leading zero, non-base36 digits, or a sequence
 * that is not a safe integer).
 */
export function parseOpaqueIdSequence(id: string): number | undefined {
  const segments = id.split(":");
  if (segments.length !== 3) return undefined;
  const [nonce, scope, sequence] = segments as [string, string, string];
  if (nonce === "" || scope === "" || sequence === "") return undefined;
  if (!/^[1-9a-z][0-9a-z]*$/.test(sequence)) return undefined;
  const value = parseInt(sequence, 36);
  return Number.isSafeInteger(value) ? value : undefined;
}
