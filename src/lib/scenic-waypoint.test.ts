import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  candidateFitsTimeBudget,
  corridorSampleCount,
  evidenceForRoute,
  haversineDistanceMeters,
  meaningfulPlaceDisplayName,
  explorationLimits,
  planScenicWaypoint,
  planScenicWaypoints,
  routeCorridorSamples,
  routeMidpoint,
  selectedPlaceTypes,
  verifiedMeaningfulPlaceName,
} from "./scenic-waypoint";

describe("scenic waypoint planning", () => {
  it("measures dateline crossings over the shortest wrapped longitude delta", () => {
    const eastbound = haversineDistanceMeters({ lat: 0, lng: 179.99 }, { lat: 0, lng: -179.99 });
    const westbound = haversineDistanceMeters({ lat: 0, lng: -179.99 }, { lat: 0, lng: 179.99 });
    assert.ok(eastbound > 2_000 && eastbound < 2_300);
    assert.equal(eastbound, westbound);
  });
  it("rejects postcode, coordinate and provider-code display names", () => {
    assert.equal(meaningfulPlaceDisplayName("BB2 7LZ"), undefined);
    assert.equal(meaningfulPlaceDisplayName("51.7520, -1.2577"), undefined);
    assert.equal(meaningfulPlaceDisplayName("9C3W9QCJ+2V"), undefined);
    assert.equal(meaningfulPlaceDisplayName("   "), undefined);
  });

  it("preserves legitimate names containing numbers or postcode-like fragments", () => {
    assert.equal(meaningfulPlaceDisplayName("7 Lakes Country Park"), "7 Lakes Country Park");
    assert.equal(meaningfulPlaceDisplayName("BB2 Woodland Walk"), "BB2 Woodland Walk");
    assert.equal(meaningfulPlaceDisplayName("Lake 32"), "Lake 32");
  });

  it("preserves Welsh, Scottish, Irish and Gaelic names without an Anglo-centric allow-list", () => {
    for (const name of [
      "Bwlchgwyn",
      "Auchtermuchty",
      "Dún Laoghaire",
      "Baile a’ Chaolais",
      "Llanfairpwllgwyngyll",
      "Kilbride-Hill",
      "St David's",
    ])
      assert.equal(meaningfulPlaceDisplayName(name), name);
    assert.equal(meaningfulPlaceDisplayName("AB12CD34"), undefined);
  });

  it("uses a verified alternative name but never substitutes a category title", () => {
    assert.equal(
      verifiedMeaningfulPlaceName({
        displayName: "BB2 7LZ",
        alternativeDisplayName: "Roddlesworth Reservoir",
      }),
      "Roddlesworth Reservoir",
    );
    assert.equal(verifiedMeaningfulPlaceName({ displayName: "BB2 7LZ" }), undefined);
  });
  it("maps selected preferences to verified Google place types deterministically", () => {
    assert.deepEqual(selectedPlaceTypes(["Romantic"], ["Historic"]).slice(0, 3), [
      "historical_place",
      "historical_landmark",
      "castle",
    ]);
  });

  it("uses measured route progress for the search midpoint", () => {
    assert.deepEqual(
      routeMidpoint({ lat: 0, lng: 0 }, { lat: 1, lng: 1 }, [
        { distanceMeters: 400, endLat: 0.2, endLng: 0.2 },
        { distanceMeters: 600, endLat: 0.8, endLng: 0.8 },
      ]),
      { lat: 0.8, lng: 0.8 },
    );
  });

  it("chooses an insertion segment without changing required-stop order", () => {
    const plan = planScenicWaypoint(
      [
        {
          id: "verified-place",
          lat: 0,
          lng: 1.1,
          primaryType: "historical_place",
          types: ["historical_place"],
        },
      ],
      [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 1 },
        { lat: 0, lng: 2 },
      ],
      30_000,
    );
    assert.equal(plan?.insertionIndex, 1);
    const requiredStops = ["required-stop"];
    requiredStops.splice(plan!.insertionIndex, 0, "scenic-stop");
    assert.deepEqual(requiredStops, ["required-stop", "scenic-stop"]);
  });

  it("rejects duplicate and excessive-backtracking places", () => {
    const anchors = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
    ];
    assert.equal(
      planScenicWaypoint(
        [
          { id: "duplicate", lat: 0, lng: 0, primaryType: "park", types: ["park"] },
          { id: "far", lat: 10, lng: 10, primaryType: "park", types: ["park"] },
        ],
        anchors,
        1_000,
      ),
      null,
    );
  });

  it("does not route through separate Place IDs at effectively the same waypoint", () => {
    const plans = planScenicWaypoints(
      [
        { id: "park-a", lat: 0.01, lng: 0.5, primaryType: "park", types: ["park"] },
        { id: "park-b", lat: 0.0101, lng: 0.5, primaryType: "park", types: ["park"] },
      ],
      [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 1 },
      ],
      10_000,
      2,
    );
    assert.equal(plans.length, 1);
  });

  it("enforces the measured extra-time ceiling", () => {
    assert.equal(candidateFitsTimeBudget(1_800, 2_400, 10), true);
    assert.equal(candidateFitsTimeBudget(1_800, 2_401, 10), false);
    assert.equal(candidateFitsTimeBudget(1_800, 1_801, 0), false);
  });

  it("samples short, medium and long corridors away from endpoints", () => {
    assert.equal(corridorSampleCount(20_000), 3);
    assert.equal(corridorSampleCount(80_000), 5);
    assert.equal(corridorSampleCount(200_000), 7);
    const samples = routeCorridorSamples(
      { lat: 0, lng: 0 },
      { lat: 0, lng: 4 },
      [
        { endLat: 0, endLng: 1 },
        { endLat: 0, endLng: 2 },
        { endLat: 0, endLng: 3 },
      ],
      3,
    );
    assert.equal(samples.length, 3);
    assert.ok(samples.every((sample) => sample.lng > 0 && sample.lng < 4));
  });

  it("expands bounded exploration with the time allowance", () => {
    assert.deepEqual(explorationLimits(0), {
      radiusMeters: 0,
      maxSearches: 0,
      maxPlaces: 0,
      maxRouteCandidates: 0,
    });
    assert.ok(explorationLimits(30).maxSearches > explorationLimits(10).maxSearches);
    assert.equal(explorationLimits(120).maxSearches, 7);
    assert.equal(explorationLimits(120).maxRouteCandidates, 4);
    assert.deepEqual(
      [0, 10, 30, 60].map((minutes) => explorationLimits(minutes)),
      [
        { radiusMeters: 0, maxSearches: 0, maxPlaces: 0, maxRouteCandidates: 0 },
        { radiusMeters: 1_500, maxSearches: 3, maxPlaces: 24, maxRouteCandidates: 2 },
        { radiusMeters: 3_500, maxSearches: 5, maxPlaces: 45, maxRouteCandidates: 3 },
        { radiusMeters: 6_000, maxSearches: 7, maxPlaces: 70, maxRouteCandidates: 4 },
      ],
    );
  });

  it("categorises verified place types without inspecting names", () => {
    const evidence = evidenceForRoute(
      [
        { id: "p1", lat: 0, lng: 0.01, primaryType: "park", types: ["park"] },
        {
          id: "p2",
          lat: 0,
          lng: 0.02,
          primaryType: "history_museum",
          types: ["museum"],
        },
      ],
      [{ lat: 0, lng: 0 }],
      3_000,
    );
    assert.equal(evidence.natural, 1);
    assert.equal(evidence.historic, 1);
    assert.equal(evidence.cultural, 1);
  });

  it("does not attribute an inserted-waypoint place to a distant baseline corridor", () => {
    const place = {
      id: "verified-scenic-place",
      lat: 0.02,
      lng: 0,
      primaryType: "park",
      types: ["park"],
    };
    const baselineEvidence = evidenceForRoute([place], [{ lat: 0, lng: 0 }], 750);
    const scenicEvidence = evidenceForRoute([place], [{ lat: place.lat, lng: place.lng }], 750);
    assert.equal(baselineEvidence.natural, 0);
    assert.equal(scenicEvidence.natural, 1);
  });
});
