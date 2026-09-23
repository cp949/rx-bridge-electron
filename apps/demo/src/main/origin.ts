/** Returns the full configured origin, including opaque custom-protocol hosts. */
export function originOf(url: string): string {
  const parsed = new URL(url);
  return parsed.origin === "null"
    ? `${parsed.protocol}//${parsed.host}`
    : parsed.origin;
}
