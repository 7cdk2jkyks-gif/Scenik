import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ComputedDirections, NavStep } from "./google-maps.server";
import { selectRouteCandidate } from "./route-selection";
import { scoreScenicRoute } from "./scenic-score";
import { EMPTY_SCENIC_EVIDENCE, explorationLimits } from "./scenic-waypoint";

function route(
  distanceMeters: number,
  durationSeconds: number,
  lengths: number[],
): ComputedDirections {
  const steps: NavStep[] = lengths.map((distance, index) => ({
    instruction: "Continue",
    maneuver: index % 2 ? "turn-left" : "straight",
    distance: "",
    duration: "",
    distanceMeters: distance,
    durationSeconds: 60,
  }));
  return {
    encodedPolyline: `fixture-${distanceMeters}-${lengths.join("-")}`,
    distance: "",
    duration: "",
    distanceMeters,
    durationSeconds,
    steps,
  };
}

const common = {
  start: { lat: 51.5, lng: -0.12 },
  end: { lat: 52.1, lng: -0.12 },
  mood: "Peaceful",
  theme: "Historic",
  extraMinutes: 30,
  stopCount: 0,
  fastestDurationSeconds: 3_600,
};

describe("Journey Engine V2 evidence calibration", () => {
  const direct = route(68_000, 3_600, [34_000, 34_000]);
  const mixed = route(75_000, 3_900, [500, 2_000, 8_000, 24_000, 40_500]);
  const varied = route(82_000, 4_500, [300, 700, 1_500, 4_000, 9_000, 18_000, 48_500]);

  it("spreads poor, ordinary and evidence-rich fixtures without randomisation", () => {
    const poor = scoreScenicRoute({
      ...common,
      directions: direct,
      evidence: EMPTY_SCENIC_EVIDENCE,
    });
    const ordinary = scoreScenicRoute({
      ...common,
      directions: mixed,
      evidence: { ...EMPTY_SCENIC_EVIDENCE, natural: 2, cultural: 1 },
    });
    const historic = scoreScenicRoute({
      ...common,
      directions: varied,
      evidence: { ...EMPTY_SCENIC_EVIDENCE, natural: 3, historic: 4, cultural: 2, viewpoint: 1 },
    });
    const coastal = scoreScenicRoute({
      ...common,
      mood: "Awestruck",
      theme: "Coastal",
      directions: varied,
      evidence: { ...EMPTY_SCENIC_EVIDENCE, natural: 4, coastal: 4, viewpoint: 2, wildlife: 1 },
    });
    assert.ok(poor.total >= 20 && poor.total <= 45, `${poor.total}`);
    assert.ok(ordinary.total >= 40 && ordinary.total <= 65, `${ordinary.total}`);
    assert.ok(historic.total >= 60 && historic.total <= 95, `${historic.total}`);
    assert.ok(coastal.total >= 60 && coastal.total <= 95, `${coastal.total}`);
    assert.ok(Math.max(historic.total, coastal.total) - poor.total >= 30);
  });

  it("verified evidence materially changes Natural Beauty and POI scores", () => {
    const none = scoreScenicRoute({
      ...common,
      directions: mixed,
      evidence: EMPTY_SCENIC_EVIDENCE,
    });
    const rich = scoreScenicRoute({
      ...common,
      directions: mixed,
      evidence: { ...EMPTY_SCENIC_EVIDENCE, natural: 4, historic: 3, viewpoint: 2 },
    });
    assert.ok(rich.breakdown.natural_beauty - none.breakdown.natural_beauty >= 4);
    assert.ok(rich.breakdown.points_of_interest - none.breakdown.points_of_interest >= 3);
  });

  it("verified matching evidence beats mismatched evidence", () => {
    const historic = scoreScenicRoute({
      ...common,
      directions: mixed,
      evidence: { ...EMPTY_SCENIC_EVIDENCE, historic: 4 },
    });
    const mismatch = scoreScenicRoute({
      ...common,
      directions: mixed,
      evidence: { ...EMPTY_SCENIC_EVIDENCE, coastal: 4 },
    });
    assert.ok(historic.breakdown.theme_match - mismatch.breakdown.theme_match >= 5);
  });

  it("route geometry materially changes Road Character", () => {
    const plain = scoreScenicRoute({ ...common, directions: direct });
    const characterful = scoreScenicRoute({ ...common, directions: varied });
    assert.ok(characterful.breakdown.road_character - plain.breakdown.road_character >= 2);
  });

  it("uses the budget to expand search and candidate eligibility", () => {
    assert.equal(explorationLimits(0).maxRouteCandidates, 0);
    assert.ok(explorationLimits(30).radiusMeters > explorationLimits(10).radiusMeters);
    const baselineScore = scoreScenicRoute({ ...common, directions: direct });
    const plusEighteen = route(82_000, 4_680, [300, 700, 1_500, 4_000, 9_000, 18_000, 48_500]);
    const scenicScore = scoreScenicRoute({
      ...common,
      directions: plusEighteen,
      evidence: { ...EMPTY_SCENIC_EVIDENCE, natural: 4, historic: 4 },
    });
    const candidates = [
      {
        directions: direct,
        score: baselineScore.total,
        scoreResult: baselineScore,
        originalIndex: 0,
      },
      {
        directions: plusEighteen,
        score: scenicScore.total,
        scoreResult: scenicScore,
        originalIndex: 1,
      },
    ];
    assert.ok(scenicScore.total > baselineScore.total);
    assert.equal(selectRouteCandidate(candidates, 10).selected.originalIndex, 0);
    assert.equal(selectRouteCandidate(candidates, 30).selected.originalIndex, 1);
  });

  it("keeps identical evidence and geometry deterministic", () => {
    const input = {
      ...common,
      directions: varied,
      evidence: { ...EMPTY_SCENIC_EVIDENCE, natural: 2, historic: 2 },
    };
    assert.deepEqual(scoreScenicRoute(input), scoreScenicRoute(input));
  });
});
