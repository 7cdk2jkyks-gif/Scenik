import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDiscoveryNarration, buildJourneyTimeline } from "./journey-timeline";

describe("journey timeline", () => {
  it("returns verified place names in chronological order with deterministic narration", () => {
    const timeline = buildJourneyTimeline(
      [
        {
          id: "later",
          lat: 0,
          lng: 2,
          primaryType: "castle",
          types: ["castle"],
          displayName: "Stone Castle",
          categoryName: "Castle",
          reason: "Historic site",
          insertionIndex: 0,
          estimatedDetourMeters: 10,
        },
        {
          id: "earlier",
          lat: 0,
          lng: 1,
          primaryType: "park",
          types: ["park"],
          displayName: "River Park",
          categoryName: "Park",
          reason: "Country park",
          insertionIndex: 0,
          estimatedDetourMeters: 10,
        },
      ],
      [
        { durationSeconds: 300, endLat: 0, endLng: 1 },
        { durationSeconds: 600, endLat: 0, endLng: 2 },
      ],
    );
    assert.deepEqual(
      timeline.map(({ atSeconds, name }) => ({ atSeconds, name })),
      [
        { atSeconds: 300, name: "River Park" },
        { atSeconds: 900, name: "Stone Castle" },
      ],
    );
    assert.equal(timeline[0].description, "Google Places lists River Park as park.");
    assert.equal(buildDiscoveryNarration(timeline)[0].text, "Coming up: River Park, park.");
  });

  it("omits unnamed places instead of inventing a highlight", () => {
    assert.deepEqual(
      buildJourneyTimeline(
        [
          {
            id: "unnamed",
            lat: 0,
            lng: 1,
            primaryType: "park",
            types: ["park"],
            reason: "Country park",
            insertionIndex: 0,
            estimatedDetourMeters: 10,
          },
        ],
        [{ durationSeconds: 300, endLat: 0, endLng: 1 }],
      ),
      [],
    );
  });
});
