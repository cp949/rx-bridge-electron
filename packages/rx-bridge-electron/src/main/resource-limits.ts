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

function assertRpcDuration(value: unknown): void {
  if (value === Number.POSITIVE_INFINITY) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new TypeError(
      "Resource limit 'maxRpcDurationMs' must be a positive safe integer or Infinity.",
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
