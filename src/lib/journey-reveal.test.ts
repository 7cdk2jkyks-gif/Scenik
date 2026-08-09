import { describe, expect, test } from "bun:test";
import { JOURNEY_REVEAL_STAGE_COUNT, journeyRevealDelays } from "./journey-reveal";

describe("journey reveal timing", () => {
  test("uses a short progressive sequence by default", () => {
    const delays = journeyRevealDelays(false);
    expect(delays).toHaveLength(JOURNEY_REVEAL_STAGE_COUNT - 1);
    expect(delays[0]).toBeGreaterThan(0);
    expect(delays.at(-1)).toBeLessThan(1_000);
  });

  test("skips timed animation for reduced motion", () => {
    expect(journeyRevealDelays(true)).toEqual([]);
  });
});
