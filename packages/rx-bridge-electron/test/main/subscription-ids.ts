/**
 * Builds a subscriptionId in the `<nonce>:<scope>:<seq base36>` format that
 * `src/renderer/ids.ts` `createOpaqueId` produces, for tests that exercise
 * the server's subscriptionId watermark (`Subscriptions.subscribe`).
 * `n` must increase within a session for the watermark to accept each ID.
 */
export function testSubscriptionId(n: number): string {
  return `test:subscription:${n.toString(36)}`;
}
