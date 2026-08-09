import { describe, expect, it } from "bun:test";
import { applyJourneyCompletion, emptyAchievementProgress } from "./journey-achievements";

const discovery = (category: string) => ({
  atSeconds: 1,
  name: category,
  category,
  description: "",
});

describe("journey achievements", () => {
  it("unlocks discovery and distance thresholds", () => {
    const result = applyJourneyCompletion(emptyAchievementProgress(), {
      distanceMiles: 101,
      discoveries: [discovery("Ancient forest"), discovery("Historic castle"), discovery("Lake")],
    });
    expect(result.unlocked.map((item) => item.key)).toEqual([
      "first_scenic_journey",
      "forest_explorer",
      "historic_wanderer",
      "waterside_drive",
      "scenic_miles_100",
    ]);
  });

  it("does not unlock an achievement twice", () => {
    const first = applyJourneyCompletion(emptyAchievementProgress(), {
      distanceMiles: 60,
      discoveries: [discovery("Forest")],
    });
    const second = applyJourneyCompletion(first.progress, {
      distanceMiles: 50,
      discoveries: [discovery("Forest")],
    });
    expect(second.unlocked.map((item) => item.key)).toEqual(["scenic_miles_100"]);
  });

  it("unlocks cumulative 500 miles and ten journeys", () => {
    const result = applyJourneyCompletion(
      { completedJourneys: 9, scenicMiles: 490, earned: ["first_scenic_journey"] },
      { distanceMiles: 10, discoveries: [] },
    );
    expect(result.unlocked.map((item) => item.key)).toEqual([
      "scenic_miles_100",
      "scenic_miles_500",
      "journeys_10",
    ]);
  });
});
