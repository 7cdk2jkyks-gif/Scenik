import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ComputedDirections } from "./google-maps.server";
import {
  applyRetainedRouteUpgrade,
  selectRouteUpgradeCandidate,
  upgradeOverrunToleranceSeconds,
} from "./route-upgrade";
import { selectedRoutePresentation } from "./route-presentation";
import type { ScenicScoreResult } from "./scenic-score";
import { EMPTY_SCENIC_EVIDENCE } from "./scenic-waypoint";

function candidate(index: number, duration: number, score: number, separated = true) {
  const directions: ComputedDirections = {
    encodedPolyline: separated ? `route-${index}` : "same-route",
    distance: "",
    duration: "",
    distanceMeters: separated ? 10_000 + index * 2_000 : 10_000,
    durationSeconds: duration,
    steps: [],
  };
  const scoreResult = {
    total: score,
    breakdown: {
      natural_beauty: index ? 8 : 5,
      points_of_interest: 5,
      mood_match: 5,
      road_character: index ? 8 : 5,
      theme_match: 5,
      diversity: 5,
      rationale: "Synthetic",
      explanations: {
        natural_beauty: "Synthetic",
        points_of_interest: "Synthetic",
        mood_match: "Synthetic",
        road_character: "Synthetic",
        theme_match: "Synthetic",
        diversity: "Synthetic",
      },
    },
    overallVerdict: "Synthetic",
    worthExtraTime: { verdict: "Promising" as const, explanation: "Synthetic", extraMinutes: 1 },
    badges: [],
    title: "Synthetic",
  } satisfies ScenicScoreResult;
  return {
    directions,
    score,
    scoreResult,
    originalIndex: index,
    evidence: { ...EMPTY_SCENIC_EVIDENCE, natural: index ? 3 : 0 },
  };
}

describe("route upgrade selection", () => {
  it("uses a modest 30% overrun with a three-minute minimum and fifteen-minute cap", () => {
    assert.equal(upgradeOverrunToleranceSeconds(5), 180);
    assert.equal(upgradeOverrunToleranceSeconds(30), 540);
    assert.equal(upgradeOverrunToleranceSeconds(120), 900);
  });

  it("does not offer a four-point improvement", () => {
    assert.equal(
      selectRouteUpgradeCandidate({
        selected: candidate(0, 3_600, 60),
        candidates: [candidate(1, 4_300, 64)],
        fastestDurationSeconds: 3_600,
        requestedExtraMinutes: 10,
      }),
      null,
    );
  });

  it("offers an eight-point improvement slightly beyond budget", () => {
    const result = selectRouteUpgradeCandidate({
      selected: candidate(0, 3_600, 60),
      candidates: [candidate(1, 4_300, 68)],
      fastestDurationSeconds: 3_600,
      requestedExtraMinutes: 10,
    });
    assert.equal(result?.candidate.originalIndex, 1);
  });

  it("rejects excessive overrun and duplicate routes", () => {
    const selected = candidate(0, 3_600, 60, false);
    assert.equal(
      selectRouteUpgradeCandidate({
        selected,
        candidates: [candidate(1, 4_500, 75)],
        fastestDurationSeconds: 3_600,
        requestedExtraMinutes: 10,
      }),
      null,
    );
    assert.equal(
      selectRouteUpgradeCandidate({
        selected,
        candidates: [candidate(1, 4_300, 75, false)],
        fastestDurationSeconds: 3_600,
        requestedExtraMinutes: 10,
      }),
      null,
    );
  });

  it("applies a retained payload without invoking another generation", () => {
    const generationCount = 0;
    const current = {
      scenic_score: 60,
      selectedRouteDurationSeconds: 22_860,
      directions: {
        encodedPolyline: "current",
        durationSeconds: 22_860,
        distanceMeters: 100_000,
        steps: [{ instruction: "Current step" }],
      },
    };
    const payload = {
      scenic_score: 68,
      selectedRouteDurationSeconds: 25_740,
      directions: {
        encodedPolyline: "upgrade",
        durationSeconds: 25_740,
        distanceMeters: 120_000,
        steps: [{ instruction: "Upgrade step" }],
      },
    };
    const result = applyRetainedRouteUpgrade(current, payload);
    assert.equal(result.scenic_score, 68);
    assert.equal(result.directions.encodedPolyline, "upgrade");
    assert.equal(result.selectedRouteDurationSeconds, 25_740);
    assert.equal(result.directions.durationSeconds, 25_740);
    assert.equal(result.directions.distanceMeters, 120_000);
    assert.equal(result.directions.steps[0].instruction, "Upgrade step");
    const mapAndNavigation = selectedRoutePresentation(result);
    assert.equal(mapAndNavigation?.durationSeconds, 25_740);
    assert.equal(mapAndNavigation?.distanceMeters, 120_000);
    assert.equal(mapAndNavigation?.steps[0].instruction, "Upgrade step");
    assert.equal(generationCount, 0);
  });
});
