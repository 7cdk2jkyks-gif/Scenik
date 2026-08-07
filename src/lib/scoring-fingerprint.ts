export function preferenceCount(value: string): number {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean).length;
}

export function safeMetricFingerprint(values: readonly number[]): string {
  let hash = 2_166_136_261;
  for (const value of values) {
    const safeValue = Number.isFinite(value) ? Math.round(value) : -1;
    for (const character of String(safeValue)) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16_777_619);
    }
    hash ^= 124;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
