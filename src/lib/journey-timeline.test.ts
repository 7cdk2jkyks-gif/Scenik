import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDiscoveryNarration,
  buildJourneyTimeline,
  discoveryPresentationState,
  rankJourneyDiscoveries,
} from "./journey-timeline";

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
    assert.equal(
      buildDiscoveryNarration(timeline)[0].text,
      "You’re approaching River Park, one of the featured discoveries on today’s journey.",
    );
  });

  it("uses a verified category fallback for an unnamed place", () => {
    const timeline = buildJourneyTimeline(
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
    );
    assert.equal(timeline[0].name, "Country park");
    assert.equal(timeline[0].category, "Country park");
  });

  it("suppresses duplicate identities and equivalent place presentations", () => {
    const base = {
      lat: 0,
      lng: 1,
      primaryType: "lake",
      types: ["lake"],
      categoryName: "Lake",
      reason: "Lake",
      insertionIndex: 0,
      estimatedDetourMeters: 10,
    };
    const timeline = buildJourneyTimeline(
      [
        { ...base, id: "rutland", displayName: "Rutland Water" },
        { ...base, id: "rutland", displayName: "Rutland Water" },
        { ...base, id: "other", displayName: "rutland-water" },
      ],
      [{ durationSeconds: 300, endLat: 0, endLng: 1 }],
    );
    assert.equal(timeline.length, 1);
  });

  it("ranks strongest theme-relevant discoveries instead of response order", () => {
    const ranked = rankJourneyDiscoveries(
      [
        { atSeconds: 100, name: "Town Park", category: "Park", description: "Verified." },
        {
          atSeconds: 300,
          name: "Wychwood Forest",
          category: "Woodland",
          evidenceCategory: "Woodland",
          description: "Verified.",
          rating: 4.7,
          userRatingCount: 900,
          distanceToRouteMeters: 100,
        },
      ],
      { themes: "Forest" },
      1,
    );
    assert.equal(ranked[0].name, "Wychwood Forest");
  });

  it("does not show an empty discoveries shell", () => {
    assert.deepEqual(discoveryPresentationState([], []), {
      hasDiscoveries: false,
      showDiscoveryHeading: false,
      legacySummary: null,
    });
  });

  it("keeps legacy highlight content as a safe route-character summary", () => {
    assert.deepEqual(
      discoveryPresentationState(undefined, ["Varied roads", "", "River corridor"]),
      {
        hasDiscoveries: false,
        showDiscoveryHeading: false,
        legacySummary: "Varied roads · River corridor",
      },
    );
  });
});
