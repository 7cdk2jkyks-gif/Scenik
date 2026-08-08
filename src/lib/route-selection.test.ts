import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ComputedDirections } from "./google-maps.server";
import {
  maximumAllowedDurationSeconds,
  routesAreMeaningfullyDifferent,
  selectRouteCandidate,
  type ScoredRouteCandidate,
} from "./route-selection";

function candidate(
  originalIndex: number,
  durationSeconds: number,
  score: number,
  distanceMeters = 10_000 + originalIndex * 1_000,
): ScoredRouteCandidate<{ total: number }> {
  const directions: ComputedDirections = {
    encodedPolyline: `polyline-${originalIndex}`,
    distance: `${distanceMeters} m`,
    duration: `${durationSeconds} s`,
    distanceMeters,
    durationSeconds,
    steps: [],
  };
  return { originalIndex, directions, score, scoreResult: { total: score } };
}

describe("selectRouteCandidate", () => {
  it("recognises a separated corridor even when duration and distance are similar", () => {
    const first = candidate(0, 900, 50).directions;
    const second = candidate(1, 910, 50, first.distanceMeters + 100).directions;
    first.steps = [
      {
        instruction: "Continue",
        distance: "",
        duration: "",
        distanceMeters: 1_000,
        durationSeconds: 60,
        endLat: 51,
        endLng: 0,
      },
    ];
    second.steps = [
      {
        instruction: "Continue",
        distance: "",
        duration: "",
        distanceMeters: 1_000,
        durationSeconds: 60,
        endLat: 51.02,
        endLng: 0,
      },
    ];
    assert.equal(routesAreMeaningfullyDifferent(first, second), true);
  });
  it("expands the duration ceiling for 0, 10, 30 and 60 minutes", () => {
    assert.deepEqual(
      [0, 10, 30, 60].map((minutes) => maximumAllowedDurationSeconds(3_600, minutes)),
      [3_600, 4_200, 5_400, 7_200],
    );
  });
  it("selects the fastest baseline for a zero-minute budget", () => {
    const result = selectRouteCandidate([candidate(0, 600, 50), candidate(1, 620, 90)], 0);
    assert.equal(result.selected.originalIndex, 0);
  });

  it("excludes a candidate adding eleven minutes from a ten-minute budget", () => {
    const result = selectRouteCandidate([candidate(0, 600, 50), candidate(1, 1_260, 90)], 10);
    assert.deepEqual(
      result.eligible.map((item) => item.originalIndex),
      [0],
    );
  });

  it("selects a higher-scoring eligible candidate", () => {
    const result = selectRouteCandidate([candidate(0, 600, 50), candidate(1, 1_080, 70)], 10);
    assert.equal(result.selected.originalIndex, 1);
  });

  it("keeps an over-budget higher-scoring candidate from winning", () => {
    const result = selectRouteCandidate([candidate(0, 600, 50), candidate(1, 1_201, 99)], 10);
    assert.equal(result.selected.originalIndex, 0);
  });

  it("uses duration, distance, then original order as deterministic tie-breaks", () => {
    const result = selectRouteCandidate(
      [candidate(0, 600, 40), candidate(1, 900, 70, 12_000), candidate(2, 900, 70, 11_000)],
      10,
    );
    assert.equal(result.selected.originalIndex, 2);
  });

  it("ignores malformed candidate durations", () => {
    const result = selectRouteCandidate([candidate(0, 600, 50), candidate(1, Number.NaN, 99)], 10);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.selected.originalIndex, 0);
  });

  it("falls back to a valid baseline when an alternative request yields no candidates", () => {
    const result = selectRouteCandidate([candidate(0, 600, 50)], 10);
    assert.equal(result.selected.originalIndex, 0);
    assert.equal(result.candidates.length, 1);
  });
});
