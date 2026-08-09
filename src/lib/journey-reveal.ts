export const JOURNEY_REVEAL_STAGE_COUNT = 7;

export function journeyRevealDelays(prefersReducedMotion: boolean): number[] {
  if (prefersReducedMotion) return [];
  return Array.from({ length: JOURNEY_REVEAL_STAGE_COUNT - 1 }, (_, index) => 140 + index * 150);
}
