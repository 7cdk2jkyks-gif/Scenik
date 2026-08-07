import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  candidateFitsTimeBudget,
  planScenicWaypoint,
  routeMidpoint,
  selectedPlaceTypes,
} from "./scenic-waypoint";

describe("scenic waypoint planning", () => {
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

  it("enforces the measured extra-time ceiling", () => {
    assert.equal(candidateFitsTimeBudget(1_800, 2_400, 10), true);
    assert.equal(candidateFitsTimeBudget(1_800, 2_401, 10), false);
    assert.equal(candidateFitsTimeBudget(1_800, 1_801, 0), false);
  });
});
