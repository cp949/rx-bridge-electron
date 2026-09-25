import type { PayloadLimits } from "../protocol/index.js";

export const DEFAULT_PAYLOAD_LIMITS: Required<PayloadLimits> = Object.freeze({
  maxDepth: 32,
  maxEntries: 10_000,
  maxStringBytes: 1_000_000,
  maxTotalBytes: 16_777_216,
});

const KEYS = Object.keys(
  DEFAULT_PAYLOAD_LIMITS,
) as readonly (keyof PayloadLimits)[];

export function resolvePayloadLimits(
  options?: Partial<PayloadLimits>,
): Required<PayloadLimits> {
  if (options === undefined) return DEFAULT_PAYLOAD_LIMITS;
  for (const key of Object.keys(options)) {
    if (!KEYS.includes(key as keyof PayloadLimits))
      throw new TypeError(`Unknown payload limit '${key}'.`);
  }
  const resolved: { -readonly [K in keyof PayloadLimits]-?: PayloadLimits[K] } =
    {
      ...DEFAULT_PAYLOAD_LIMITS,
    };
  for (const key of KEYS) {
    // 명시적 undefined는 거부한다 — 생략과 다르다.
    if (!Object.hasOwn(options, key)) continue;
    const value = options[key];
    if (!Number.isSafeInteger(value) || (value as number) < 0)
      throw new TypeError(
        `Payload limit '${key}' must be a non-negative safe integer.`,
      );
    resolved[key] = value as never;
  }
  return Object.freeze(resolved);
}
