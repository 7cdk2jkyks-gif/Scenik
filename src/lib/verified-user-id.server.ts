const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function canonicalVerifiedUserId(value: unknown): string | null {
  if (typeof value !== "string" || !CANONICAL_UUID_PATTERN.test(value)) return null;
  return value.toLowerCase();
}
