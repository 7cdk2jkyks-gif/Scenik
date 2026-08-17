import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDiscoveryNarration,
  buildJourneyTimeline,
  discoveryPresentationState,
  discoveryCategoryPresentation,
  discoveryCardPresentation,
  discoveryCountBand,
  featuredJourneyDiscoveries,
  hasFeaturedDiscoveryDetail,
  rankJourneyDiscoveries,
  selectJourneyDiscoveries,
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

  it("scales desired discovery counts monotonically while retaining the fifteen-item bound", () => {
    const fixtures = [
      [20 * 60, 20_000, 2],
      [60 * 60, 80_000, 4],
      [2 * 60 * 60, 180_000, 7],
      [4 * 60 * 60, 400_000, 12],
      [6 * 60 * 60, 600_000, 14],
      [20 * 60 * 60, 2_000_000, 15],
    ] as const;
    const targets = fixtures.map(([duration, distance, expected]) => {
      const band = discoveryCountBand(duration, distance);
      assert.equal(band.target, expected);
      assert.ok(band.target <= 15);
      return band.target;
    });
    assert.deepEqual(
      targets,
      [...targets].sort((a, b) => a - b),
    );
  });

  it("never exceeds verified evidence and does not overload a short route", () => {
    const evidence = Array.from({ length: 20 }, (_, index) => ({
      atSeconds: 30 + index * 30,
      name: `Place ${index}`,
      category: "Park",
      description: "Verified.",
    }));
    assert.equal(selectJourneyDiscoveries(evidence, 20 * 60, 20_000).length, 2);
    assert.equal(selectJourneyDiscoveries(evidence.slice(0, 1), 6 * 60 * 60, 600_000).length, 1);
  });

  it("spreads long-route discoveries across route-progress sections", () => {
    const duration = 6 * 60 * 60;
    const evidence = Array.from({ length: 30 }, (_, index) => ({
      atSeconds: 120 + index * 700,
      name: `Distributed ${index}`,
      category: index % 3 === 0 ? "Historic place" : index % 3 === 1 ? "Park" : "Art gallery",
      description: "Verified.",
      rating: 4 + (index % 5) / 10,
    }));
    const selected = selectJourneyDiscoveries(evidence, duration, 600_000, {
      themes: ["Historic", "Art & Culture"],
    });
    assert.equal(selected.length, 14);
    assert.deepEqual(
      selected,
      [...selected].sort((a, b) => a.atSeconds - b.atSeconds),
    );
    const quarters = new Set(
      selected.map((item) => Math.min(3, Math.floor((item.atSeconds / duration) * 4))),
    );
    assert.ok(quarters.size >= 3);
  });

  it("limits endpoint clusters when distributed alternatives exist", () => {
    const duration = 4 * 60 * 60;
    const clustered = [
      ...Array.from({ length: 12 }, (_, index) => ({
        atSeconds: 10 + index,
        name: `Origin ${index}`,
        category: "Park",
        description: "Verified.",
        rating: 5,
      })),
      ...Array.from({ length: 12 }, (_, index) => ({
        atSeconds: duration - 20 + index,
        name: `Destination ${index}`,
        category: "Historic place",
        description: "Verified.",
        rating: 5,
      })),
      ...[0.2, 0.4, 0.6, 0.8].map((progress, index) => ({
        atSeconds: duration * progress,
        name: `Middle ${index}`,
        category: index % 2 ? "Art gallery" : "Woodland",
        description: "Verified.",
      })),
    ];
    const selected = selectJourneyDiscoveries(clustered, duration, 400_000);
    assert.ok(selected.filter((item) => item.name.startsWith("Middle")).length >= 4);
  });

  it("deduplicates Place identity and presentation before distributed selection", () => {
    const timeline = buildJourneyTimeline(
      [
        {
          id: "same",
          lat: 0,
          lng: 1,
          primaryType: "park",
          types: ["park"],
          displayName: "One Park",
        },
        {
          id: "same",
          lat: 0,
          lng: 2,
          primaryType: "park",
          types: ["park"],
          displayName: "One Park",
        },
        {
          id: "other",
          lat: 0,
          lng: 2,
          primaryType: "park",
          types: ["park"],
          displayName: "one-park",
        },
      ],
      [
        { durationSeconds: 300, endLat: 0, endLng: 1 },
        { durationSeconds: 300, endLat: 0, endLng: 2 },
      ],
    );
    assert.equal(timeline.length, 1);
  });

  it("keeps narration sparser than a long-route presentation", () => {
    const timeline = Array.from({ length: 15 }, (_, index) => ({
      atSeconds: index * 1_000,
      name: `Place ${index}`,
      category: "Park",
      description: "Verified.",
    }));
    const narration = buildDiscoveryNarration(timeline, 6 * 60 * 60);
    assert.equal(narration.length, 6);
    assert.equal(narration[0].name, "Place 0");
    assert.equal(narration.at(-1)?.name, "Place 14");
  });

  it("normalizes invalid discovery count inputs to finite bounded integers", () => {
    const inputs = [
      [Number.NaN, Number.NaN],
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
      [-1, -1],
      [0, 0],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      [undefined as unknown as number, undefined as unknown as number],
    ];
    for (const [duration, distance] of inputs) {
      const band = discoveryCountBand(duration, distance);
      for (const value of [band.minimum, band.maximum, band.target]) {
        assert.ok(Number.isFinite(value));
        assert.ok(Number.isInteger(value));
      }
      assert.ok(band.minimum <= band.target && band.target <= band.maximum);
      assert.ok(band.target <= 15);
    }
    assert.deepEqual(discoveryCountBand(Number.NaN, Number.NaN), {
      minimum: 2,
      maximum: 3,
      target: 2,
    });
  });

  it("assigns exact duration boundaries to their documented count bands", () => {
    const second = 1;
    const boundaries = [
      [45 * 60 - second, 2, 3],
      [45 * 60, 3, 5],
      [45 * 60 + second, 3, 5],
      [90 * 60 - second, 3, 5],
      [90 * 60, 5, 8],
      [90 * 60 + second, 5, 8],
      [3 * 60 * 60 - second, 5, 8],
      [3 * 60 * 60, 8, 12],
      [3 * 60 * 60 + second, 8, 12],
      [5 * 60 * 60 - second, 8, 12],
      [5 * 60 * 60, 10, 15],
      [5 * 60 * 60 + second, 10, 15],
    ] as const;
    const targets = boundaries.map(([duration, minimum, maximum]) => {
      const band = discoveryCountBand(duration, 0);
      assert.equal(band.minimum, minimum);
      assert.equal(band.maximum, maximum);
      return band.target;
    });
    assert.deepEqual(
      targets,
      [...targets].sort((a, b) => a - b),
    );
  });

  it("selects equivalent evidence deterministically across input reorderings", () => {
    const evidence = Array.from({ length: 12 }, (_, index) => ({
      identity: `place-${index}`,
      atSeconds: 100 + index * 300,
      name: `Place ${index}`,
      category: index % 2 ? "Park" : "Historic place",
      description: "Verified.",
      rating: 4.5,
      distanceToRouteMeters: 100,
    }));
    const reorderings = [
      evidence,
      [...evidence].reverse(),
      [...evidence.slice(4), ...evidence.slice(0, 4)],
    ];
    const selections = reorderings.map((items) =>
      selectJourneyDiscoveries(items, 2 * 60 * 60, 180_000).map((item) => ({
        identity: item.identity,
        atSeconds: item.atSeconds,
        category: item.category,
      })),
    );
    assert.deepEqual(selections[1], selections[0]);
    assert.deepEqual(selections[2], selections[0]);
  });

  it("applies narration caps immediately below, at and above each boundary", () => {
    const timeline = Array.from({ length: 12 }, (_, index) => ({
      identity: `narration-${index}`,
      atSeconds: index * 1_000,
      name: `Narration ${index}`,
      category: "Park",
      description: "Verified.",
    }));
    const cases = [
      [90 * 60 - 1, 3],
      [90 * 60, 5],
      [90 * 60 + 1, 5],
      [3 * 60 * 60 - 1, 5],
      [3 * 60 * 60, 6],
      [3 * 60 * 60 + 1, 6],
    ] as const;
    for (const [duration, cap] of cases) {
      const narration = buildDiscoveryNarration(timeline, duration);
      assert.equal(narration.length, cap);
      assert.deepEqual(
        narration.map(({ atSeconds }) => atSeconds),
        [...narration].map(({ atSeconds }) => atSeconds).sort((a, b) => a - b),
      );
    }
    assert.equal(buildDiscoveryNarration(timeline.slice(0, 2), 4 * 60 * 60).length, 2);
    const missingProgress = buildDiscoveryNarration(
      [{ ...timeline[0], atSeconds: Number.NaN }],
      30 * 60,
    )[0];
    assert.equal(missingProgress.atSeconds, 0);
    assert.equal(missingProgress.triggerAtSeconds, 0);
    assert.ok(Number.isFinite(missingProgress.staleAfterSeconds));
  });
});
