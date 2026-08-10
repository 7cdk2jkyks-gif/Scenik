import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDiscoveryNarration,
  buildJourneyTimeline,
  discoveryPresentationState,
  discoveryCategoryPresentation,
  discoveryCardPresentation,
  featuredJourneyDiscoveries,
  hasFeaturedDiscoveryDetail,
  rankJourneyDiscoveries,
  verifiedDiscoveryDescription,
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
    assert.equal(timeline[0].description, "Natural discovery along your journey.");
    assert.equal(
      buildDiscoveryNarration(timeline)[0].text,
      "You’re approaching River Park, one of the featured discoveries on today’s journey.",
    );
  });

  it("uses provider-neutral verified fallbacks", () => {
    assert.equal(
      verifiedDiscoveryDescription("Woodland"),
      "Woodland discovery along your journey.",
    );
    assert.deepEqual(discoveryCategoryPresentation("woods"), {
      label: "Woodland",
      copy: "Woodland discovery along your journey.",
    });
    assert.deepEqual(discoveryCategoryPresentation("internal_place_type"), {
      label: "Discovery",
      copy: "Discovery along your journey.",
    });
    assert.equal(verifiedDiscoveryDescription("museum"), "Museum discovery along your journey.");
    assert.doesNotMatch(verifiedDiscoveryDescription("museum"), /google|provider|places/i);
    assert.doesNotMatch(
      verifiedDiscoveryDescription("ordinary building"),
      /beautiful|historic|ancient|peaceful|famous|worth visiting/i,
    );
  });

  it("selects richer featured discoveries before deterministic ranking", () => {
    const timeline = [
      { atSeconds: 10, name: "Timeline only", category: "Park", description: "Natural discovery." },
      {
        atSeconds: 40,
        name: "Later rich",
        category: "Park",
        description: "Natural discovery.",
        rating: 4.4,
      },
      {
        atSeconds: 20,
        name: "Earlier rich",
        category: "Park",
        description: "Natural discovery.",
        userRatingCount: 12,
      },
    ];
    const selected = featuredJourneyDiscoveries(timeline, {}, 2).map((item) => item.name);
    assert.deepEqual(selected, ["Later rich", "Earlier rich"]);
    assert.deepEqual(
      featuredJourneyDiscoveries([...timeline].reverse(), {}, 2).map((item) => item.name),
      selected,
    );
  });

  it("handles missing rating and review data without inventing detail", () => {
    const event = {
      atSeconds: 60,
      name: "A very long verified place name that should remain unchanged in presentation",
      category: "unknown_type",
      description: verifiedDiscoveryDescription("unknown_type"),
      photoUrl: "https://example.com/existing-photo.jpg",
    };
    assert.equal(hasFeaturedDiscoveryDetail(event), true);
    assert.equal(event.description, "Discovery along your journey.");
    assert.equal(
      event.name,
      "A very long verified place name that should remain unchanged in presentation",
    );
    assert.equal(discoveryCardPresentation(event).showPhoto, true);
    assert.equal(discoveryCardPresentation(event, true).showPhoto, false);
    assert.equal(discoveryCardPresentation({ ...event, photoUrl: undefined }).showPhoto, false);
  });

  it("features only discoveries with details beyond the timeline", () => {
    assert.equal(
      hasFeaturedDiscoveryDetail({
        atSeconds: 60,
        name: "Pine Wood",
        category: "Woodland",
        description: "Verified woodland discovery along your journey.",
      }),
      false,
    );
    assert.equal(
      hasFeaturedDiscoveryDetail({
        atSeconds: 60,
        name: "Pine Wood",
        category: "Woodland",
        description: "Verified woodland discovery along your journey.",
        rating: 4.6,
      }),
      true,
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
