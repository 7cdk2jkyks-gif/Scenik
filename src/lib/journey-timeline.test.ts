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
  routeResultNarrative,
  verifiedDiscoveryDescription,
  verifiedJourneyHighlights,
} from "./journey-timeline";

describe("journey timeline", () => {
  it("omits category-only hero highlights and named-place route copy", () => {
    const highlights = verifiedJourneyHighlights([
      { displayName: "BB2 7LZ" },
      { displayName: undefined },
    ]);
    const narrative = routeResultNarrative({
      selectedWinner: "scenik",
      selectedWaypointReason: highlights,
      requestedExtraMinutes: 85,
      measuredExtraTimeSeconds: 2_460,
    });
    assert.equal(highlights, null);
    assert.equal(narrative.includes("Lake"), false);
    assert.equal(narrative.includes("includes"), false);
    assert.equal(narrative.includes("undefined"), false);
  });

  it("uses only verified meaningful names in hero highlights and route copy", () => {
    const highlights = verifiedJourneyHighlights([
      { displayName: "BB2 7LZ", alternativeDisplayName: "Roddlesworth Reservoir" },
      { displayName: "Wychwood Forest" },
    ]);
    const narrative = routeResultNarrative({
      selectedWinner: "scenik",
      selectedWaypointReason: highlights,
      requestedExtraMinutes: 85,
      measuredExtraTimeSeconds: 2_460,
    });
    assert.equal(highlights, "Roddlesworth Reservoir and Wychwood Forest");
    assert.equal(narrative.includes(highlights), true);
  });

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

  it("omits an unnamed or postcode-only discovery instead of using its category as a title", () => {
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
          displayName: "BB2 7LZ",
          categoryName: "Lake",
        },
      ],
      [{ durationSeconds: 300, endLat: 0, endLng: 1 }],
    );
    assert.deepEqual(timeline, []);
    assert.equal(JSON.stringify(timeline).includes("BB2 7LZ"), false);
    assert.equal(JSON.stringify(timeline).includes('"name":"Lake"'), false);
    assert.deepEqual(featuredJourneyDiscoveries(timeline), []);
  });

  it("uses an existing verified alternative name and keeps valid named places visible", () => {
    const base = {
      lat: 0,
      lng: 1,
      types: [] as string[],
      insertionIndex: 0,
      estimatedDetourMeters: 10,
    };
    const timeline = buildJourneyTimeline(
      [
        {
          ...base,
          id: "alt",
          primaryType: "lake",
          reason: "Lake",
          categoryName: "Lake",
          displayName: "BB2 7LZ",
          alternativeDisplayName: "Roddlesworth Reservoir",
        },
        {
          ...base,
          id: "wood",
          primaryType: "woods",
          reason: "Woodland",
          displayName: "Wychwood Forest",
        },
        {
          ...base,
          id: "village",
          primaryType: "locality",
          reason: "Local town",
          displayName: "Bibury",
        },
        {
          ...base,
          id: "landmark",
          primaryType: "castle",
          reason: "Historic site",
          displayName: "Clitheroe Castle",
        },
      ],
      [{ durationSeconds: 300, endLat: 0, endLng: 1 }],
    );
    assert.deepEqual(timeline.map((item) => item.name).sort(), [
      "Bibury",
      "Clitheroe Castle",
      "Roddlesworth Reservoir",
      "Wychwood Forest",
    ]);
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
