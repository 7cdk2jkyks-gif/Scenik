import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ComputedDirections, NavStep } from "./google-maps.server";
import { scoreScenicRoute } from "./scenic-score";
import { safeMetricFingerprint } from "./scoring-fingerprint";

function step(distanceMeters: number, maneuver = "straight"): NavStep {
  return {
    instruction: "Continue",
    maneuver,
    distance: "",
    duration: "",
    distanceMeters,
    durationSeconds: 60,
  };
}

function directions(
  distanceMeters: number,
  durationSeconds: number,
  steps: NavStep[],
): ComputedDirections {
  return {
    encodedPolyline: `synthetic-${distanceMeters}-${steps.length}`,
    distance: "",
    duration: "",
    distanceMeters,
    durationSeconds,
    steps,
  };
}

const baseInput = {
  start: { lat: 51.5, lng: -0.12 },
  end: { lat: 51.58, lng: -0.12 },
  mood: "Peaceful",
  theme: "Countryside",
  extraMinutes: 10,
  stopCount: 0,
};

describe("scoreScenicRoute input sensitivity", () => {
  const direct = directions(9_200, 900, [step(4_600), step(4_600)]);
  const varied = directions(12_800, 1_200, [
    step(300, "turn-left"),
    step(900, "turn-right"),
    step(2_600, "turn-left"),
    step(9_000),
  ]);

  it("changes a geometry category when route metrics change", () => {
    const first = scoreScenicRoute({ ...baseInput, directions: direct });
    const second = scoreScenicRoute({ ...baseInput, directions: varied });
    assert.notDeepEqual(
      [first.breakdown.natural_beauty, first.breakdown.road_character, first.breakdown.diversity],
      [
        second.breakdown.natural_beauty,
        second.breakdown.road_character,
        second.breakdown.diversity,
      ],
    );
  });

  it("changes Mood Match for an additional compatible mood", () => {
    const one = scoreScenicRoute({ ...baseInput, directions: direct });
    const two = scoreScenicRoute({ ...baseInput, mood: "Peaceful, Relaxed", directions: direct });
    assert.notEqual(one.breakdown.mood_match, two.breakdown.mood_match);
  });

  it("changes Theme Match for an additional compatible theme", () => {
    const one = scoreScenicRoute({ ...baseInput, directions: direct });
    const two = scoreScenicRoute({
      ...baseInput,
      theme: "Countryside, Villages",
      directions: direct,
    });
    assert.notEqual(one.breakdown.theme_match, two.breakdown.theme_match);
  });

  it("scores each candidate from its own geometry", () => {
    const first = scoreScenicRoute({ ...baseInput, directions: direct });
    const second = scoreScenicRoute({ ...baseInput, directions: varied });
    assert.notEqual(first.total, second.total);
  });

  it("produces distinct fingerprints for distinct scoring inputs", () => {
    const first = safeMetricFingerprint([0, 900, 9_200, 2, 1, 1, 10, 0]);
    const second = safeMetricFingerprint([1, 1_200, 12_800, 4, 1, 1, 10, 0]);
    assert.notEqual(first, second);
  });

  it("remains deterministic for identical inputs", () => {
    const first = scoreScenicRoute({ ...baseInput, directions: direct });
    const second = scoreScenicRoute({ ...baseInput, directions: direct });
    assert.deepEqual(first, second);
  });
});
