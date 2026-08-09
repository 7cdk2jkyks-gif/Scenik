import { describe, expect, it } from "bun:test";
import { buildJourneySummary } from "./journey-summary";

describe("journey completion summary", () => {
  it("uses the selected upgraded route rather than stale route values", () => {
    const summary = buildJourneySummary({
      title: "Woodland Escape",
      scenic_score: 86,
      selectedRouteDurationSeconds: 24_120,
      measuredExtraTimeSeconds: 2_460,
      directions: {
        encodedPolyline: "upgraded",
        durationSeconds: 24_120,
        duration: "6 hr 42 min",
        distanceMeters: 296_119,
        distance: "184 miles",
      },
      journeyTimeline: [{ atSeconds: 1, name: "Old Wood", category: "Forest", description: "" }],
    });
    expect(summary?.durationSeconds).toBe(24_120);
    expect(summary?.distanceMeters).toBe(296_119);
    expect(summary?.shareText).toContain("184 miles");
    expect(summary?.shareText).not.toContain("upgraded");
  });
});
