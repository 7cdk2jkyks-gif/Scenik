import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  budgetUtilisation,
  buildCorridorPlans,
  corridorWaypointsWithRequiredStops,
  didCompleteFullAllowanceSearch,
  explorationShouldStop,
  explorationStages,
  isTargetBudgetCandidate,
  selectPlansForDetourTargets,
} from "./corridor-exploration";
import type { ScenicPlace } from "./scenic-waypoint";

const anchors = [
  { lat: 0, lng: 0 },
  { lat: 0, lng: 1 },
  { lat: 0, lng: 2 },
];

function place(id: string, lat: number, lng: number, primaryType: string): ScenicPlace {
  return { id, lat, lng, primaryType, types: [primaryType] };
}

describe("budget-driven corridor exploration", () => {
  it("progressively expands radius, samples, places and candidate caps", () => {
    const stages = explorationStages(60);
    assert.deepEqual(
      stages.map((stage) => stage.radiusMeters),
      [1_200, 2_300, 3_500, 6_000],
    );
    assert.deepEqual(
      stages.map((stage) => stage.sampleCap),
      [3, 4, 5, 3],
    );
    assert.deepEqual(
      stages.map((stage) => stage.cumulativePlaceCap),
      [20, 34, 45, 70],
    );
    assert.deepEqual(
      stages.map((stage) => stage.cumulativeRouteCap),
      [1, 2, 4, 6],
    );
  });

  it("preserves the 30-minute exploration prefix for larger allowances", () => {
    const thirty = explorationStages(30);
    const eightyFive = explorationStages(85);
    assert.deepEqual(eightyFive.slice(0, thirty.length), thirty);
    assert.deepEqual(eightyFive.at(-1)?.targetExtraMinutes, [50, 70]);
    assert.equal(
      eightyFive.reduce((sum, stage) => sum + stage.sampleCap, 0),
      15,
    );
    assert.equal(eightyFive.at(-1)?.cumulativeRouteCap, 6);
  });

  it("distributes long-budget attempts across intermediate and upper targets", () => {
    const plan = (signature: string, estimatedDetourMeters: number) => ({
      kind: "other" as const,
      reason: "Scenic corridor",
      waypoints: [],
      estimatedDetourMeters,
      signature,
    });
    assert.deepEqual(
      selectPlansForDetourTargets(
        [plan("near", 10_000), plan("middle", 30_000), plan("far", 48_000)],
        [28_000, 50_000],
        2,
      ).map((item) => item.signature),
      ["middle", "far"],
    );
  });

  it("covers supported allowance bands without increasing request bounds", () => {
    const summaries = [15, 30, 45, 60, 85, 240].map((minutes) => {
      const stages = explorationStages(minutes);
      return {
        minutes,
        placeSearches: stages.reduce((sum, stage) => sum + stage.sampleCap, 0),
        routeRequests: stages.at(-1)?.cumulativeRouteCap ?? 0,
        targets: stages.flatMap((stage) => stage.targetExtraMinutes),
      };
    });
    for (const summary of summaries) {
      assert.ok(summary.placeSearches <= 15, JSON.stringify(summary));
      assert.ok(summary.routeRequests <= 6, JSON.stringify(summary));
    }
    assert.deepEqual(summaries.find((item) => item.minutes === 45)?.targets.slice(-2), [35, 40]);
    assert.deepEqual(summaries.find((item) => item.minutes === 60)?.targets.slice(-2), [35, 50]);
    assert.deepEqual(summaries.find((item) => item.minutes === 85)?.targets.slice(-2), [50, 70]);
    assert.deepEqual(summaries.find((item) => item.minutes === 240)?.targets.slice(-2), [140, 195]);
  });

  it("builds deterministic category-distinct corridors from verified types", () => {
    const plans = buildCorridorPlans({
      places: [
        place("forest-a", 0.05, 0.4, "woods"),
        place("forest-b", 0.05, 0.7, "woods"),
        place("coast", -0.05, 1.3, "beach"),
        place("historic", 0.04, 1.6, "historical_place"),
        place("view", -0.04, 0.9, "scenic_spot"),
        place("lake", 0.04, 1.8, "lake"),
      ],
      anchors,
      maximumEstimatedDetourMeters: 50_000,
      maximumPlans: 6,
    }).plans;
    assert.ok(plans.some((plan) => plan.kind === "forest" && plan.waypoints.length === 2));
    assert.ok(plans.some((plan) => plan.kind === "coastline"));
    assert.ok(plans.some((plan) => plan.kind === "historic"));
    assert.ok(plans.some((plan) => plan.kind === "viewpoints"));
    assert.ok(plans.some((plan) => plan.kind === "lakes"));
    assert.deepEqual(
      plans,
      buildCorridorPlans({
        places: [
          place("forest-a", 0.05, 0.4, "woods"),
          place("forest-b", 0.05, 0.7, "woods"),
          place("coast", -0.05, 1.3, "beach"),
          place("historic", 0.04, 1.6, "historical_place"),
          place("view", -0.04, 0.9, "scenic_spot"),
          place("lake", 0.04, 1.8, "lake"),
        ],
        anchors,
        maximumEstimatedDetourMeters: 50_000,
        maximumPlans: 6,
      }).plans,
    );
  });

  it("preserves required-stop order when inserting a two-waypoint corridor", () => {
    const plan = buildCorridorPlans({
      places: [place("forest-a", 0.05, 0.4, "woods"), place("forest-b", 0.05, 1.4, "woods")],
      anchors,
      maximumEstimatedDetourMeters: 50_000,
      maximumPlans: 1,
    }).plans[0];
    const routed = corridorWaypointsWithRequiredStops([{ lat: 0, lng: 1 }], anchors, plan);
    assert.equal(routed.length, 3);
    assert.deepEqual(routed[1], { lat: 0, lng: 1 });
  });

  it("recognises measured candidates using at least 75% of the budget", () => {
    assert.equal(isTargetBudgetCandidate(budgetUtilisation(3_600, 4_020, 10)), false);
    assert.equal(isTargetBudgetCandidate(budgetUtilisation(3_600, 4_050, 10)), true);
    assert.equal(isTargetBudgetCandidate(budgetUtilisation(3_600, 4_170, 10)), true);
    assert.equal(isTargetBudgetCandidate(budgetUtilisation(3_600, 3_900, 10)), false);
    assert.equal(isTargetBudgetCandidate(budgetUtilisation(3_600, 4_200, 10)), true);
  });

  it("continues beyond an acceptable route until a stopping condition is met", () => {
    assert.equal(
      explorationShouldStop({
        bestScore: 70,
        bestHighUtilisationScore: -1,
        bestQualityEquivalentUtilisation: 0.3,
        requestedExtraMinutes: 60,
        stagesExplored: 1,
        stagesRemaining: 2,
      }),
      false,
    );
    assert.equal(
      explorationShouldStop({
        bestScore: 75,
        bestHighUtilisationScore: 74,
        bestQualityEquivalentUtilisation: 0.8,
        requestedExtraMinutes: 60,
        stagesExplored: 1,
        stagesRemaining: 2,
      }),
      false,
    );
    assert.equal(
      explorationShouldStop({
        bestScore: 75,
        bestHighUtilisationScore: 74,
        bestQualityEquivalentUtilisation: 0.8,
        requestedExtraMinutes: 60,
        stagesExplored: 2,
        stagesRemaining: 1,
      }),
      true,
    );
    assert.equal(
      explorationShouldStop({
        bestScore: 98,
        bestHighUtilisationScore: 97,
        bestQualityEquivalentUtilisation: 0.75,
        requestedExtraMinutes: 30,
        stagesExplored: 1,
        stagesRemaining: 2,
      }),
      true,
    );
    assert.equal(
      explorationShouldStop({
        bestScore: 70,
        bestHighUtilisationScore: -1,
        bestQualityEquivalentUtilisation: 0.2,
        requestedExtraMinutes: 60,
        stagesExplored: 3,
        stagesRemaining: 0,
      }),
      true,
    );
  });

  it("does not stop a large-budget search on a low-utilisation candidate", () => {
    assert.equal(
      explorationShouldStop({
        bestScore: 98,
        bestHighUtilisationScore: -1,
        bestQualityEquivalentUtilisation: 0.3,
        requestedExtraMinutes: 60,
        stagesExplored: 2,
        stagesRemaining: 1,
      }),
      false,
    );
  });

  it("only claims a full allowance search after successful complete exploration", () => {
    const complete = {
      explorationExhausted: true,
      candidateRequestFailed: false,
      scenicRouteRequestsAttempted: 6,
      intendedScenicRouteRequests: 6,
      longerEligibleCandidateEvaluated: true,
    };
    assert.equal(didCompleteFullAllowanceSearch(complete), true);
    assert.equal(
      didCompleteFullAllowanceSearch({ ...complete, candidateRequestFailed: true }),
      false,
    );
    assert.equal(
      didCompleteFullAllowanceSearch({ ...complete, scenicRouteRequestsAttempted: 5 }),
      false,
    );
    assert.equal(
      didCompleteFullAllowanceSearch({ ...complete, longerEligibleCandidateEvaluated: false }),
      false,
    );
  });
});
