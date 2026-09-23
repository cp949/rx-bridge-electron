export interface ResourceLimits {
  readonly maxConcurrentRpc: number;
  readonly maxSubscriptions: number;
  readonly maxRpcDurationMs: number;
  readonly maxRetiredClientsPerWebContents: number;
}

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = Object.freeze({
  maxConcurrentRpc: 64,
  maxSubscriptions: 256,
  maxRpcDurationMs: 300_000,
  maxRetiredClientsPerWebContents: 32,
});

const KEYS = Object.keys(
  DEFAULT_RESOURCE_LIMITS,
) as readonly (keyof ResourceLimits)[];

function assertPositiveSafeInteger(
  key: keyof ResourceLimits,
  value: unknown,
): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new TypeError(
      `Resource limit '${key}' must be a positive safe integer.`,
    );
}

// setTimeout은 2^31-1ms를 넘는 지연을 1ms로 바꾸므로 그 이상은 즉시 deadline이 된다.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function assertRpcDuration(value: unknown): void {
  if (value === Number.POSITIVE_INFINITY) return;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TIMER_DELAY_MS
  )
    throw new TypeError(
      `Resource limit 'maxRpcDurationMs' must be an integer from 1 to ${MAX_TIMER_DELAY_MS} or Infinity.`,
    );
}

export function resolveResourceLimits(
  options?: Partial<ResourceLimits>,
): ResourceLimits {
  if (options === undefined) return DEFAULT_RESOURCE_LIMITS;
  for (const key of Object.keys(options)) {
    if (!KEYS.includes(key as keyof ResourceLimits))
      throw new TypeError(`Unknown resource limit '${key}'.`);
  }
  const resolved: { -readonly [K in keyof ResourceLimits]: ResourceLimits[K] } =
    {
      ...DEFAULT_RESOURCE_LIMITS,
    };
  for (const key of KEYS) {
    if (!Object.hasOwn(options, key)) continue;
    const value = options[key];
    if (key === "maxRpcDurationMs") assertRpcDuration(value);
    else assertPositiveSafeInteger(key, value);
    resolved[key] = value as never;
  }
  return Object.freeze(resolved);
}
