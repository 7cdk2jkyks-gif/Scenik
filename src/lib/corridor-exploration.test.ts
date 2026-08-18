import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adaptiveDurationTargetMinutes,
  budgetUtilisation,
  buildCorridorPlans,
  classifyDurationTargetResult,
  corridorWaypointsWithRequiredStops,
  createPositiveAllowanceProductionCoordinator,
  didCompleteFullAllowanceSearch,
  distinctDurationTargetsBySearchGeometry,
  durationAwareCorridorSamples,
  explorationShouldStop,
  explorationStages,
  isTargetBudgetCandidate,
  positiveAllowanceTargetLadder,
  selectPlansForDetourTargets,
  targetLateralDisplacementMeters,
} from "./corridor-exploration";
import { timeBudgetExplanation } from "./route-presentation";
import { selectRouteCandidate, type ScoredRouteCandidate } from "./route-selection";
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
      [1_200, 2_300, 3_500, 10_000],
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
      [1, 2, 3, 4],
    );
  });

  it("extends large allowances through useful medium targets", () => {
    const eightyFive = explorationStages(85);
    assert.deepEqual(
      eightyFive.flatMap((stage) => stage.targetExtraMinutes),
      [30, 50, 70, 75],
    );
    assert.equal(
      eightyFive.reduce((sum, stage) => sum + stage.sampleCap, 0),
      15,
    );
    assert.equal(eightyFive.at(-1)?.cumulativeRouteCap, 4);
  });

  it("builds exact bounded ladders and reserves refinement capacity", () => {
    const expected = new Map([
      [10, [8, 9]],
      [30, [15, 23, 27]],
      [80, [30, 45, 65, 70]],
      [120, [30, 60, 90, 110]],
      [180, [30, 60, 90, 135, 160]],
      [240, [30, 60, 120, 180, 215]],
    ]);
    for (const [allowance, targets] of expected) {
      assert.deepEqual(positiveAllowanceTargetLadder(allowance), targets);
      assert.deepEqual(
        explorationStages(allowance).flatMap((stage) => stage.targetExtraMinutes),
        targets,
      );
      assert.ok((explorationStages(allowance).at(-1)?.cumulativeRouteCap ?? 0) <= 5);
    }
  });

  it("keeps every allowance ladder positive, unique, increasing and bounded", () => {
    for (let allowance = 1; allowance <= 240; allowance += 1) {
      const targets = positiveAllowanceTargetLadder(allowance);
      assert.ok(targets.length > 0);
      assert.deepEqual(
        targets,
        [...new Set(targets)].sort((a, b) => a - b),
      );
      assert.ok(targets.every((target) => target > 0 && target <= allowance));
    }
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

  it("recognises the production-style 85-minute result as a severe target-generation undershoot", () => {
    assert.equal(classifyDurationTargetResult(30, 24, 30), "TARGET_BAND");
    assert.equal(classifyDurationTargetResult(70, 30, 85), "SEVERE_UNDERSHOOT");
    assert.equal(classifyDurationTargetResult(70, 50, 85), "MODERATE_UNDERSHOOT");
    assert.equal(classifyDurationTargetResult(70, 68, 85), "TARGET_BAND");
    assert.equal(classifyDurationTargetResult(70, 86, 85), "OVER_BUDGET");
  });

  it("constructs a +70-minute search more ambitiously than +30", () => {
    const baseline = { baselineDistanceMeters: 560_000, baselineDurationSeconds: 21_600 };
    const thirty = targetLateralDisplacementMeters({ ...baseline, targetExtraMinutes: 30 });
    const seventy = targetLateralDisplacementMeters({ ...baseline, targetExtraMinutes: 70 });
    assert.ok(seventy > thirty, `${thirty} vs ${seventy}`);
    const samples = durationAwareCorridorSamples({
      samples: [
        { lat: 51.75, lng: -1.25 },
        { lat: 53.2, lng: -2.1 },
        { lat: 54.7, lng: -3.2 },
      ],
      ...baseline,
      targetExtraMinutes: [50, 70],
    });
    assert.deepEqual(
      samples.map((sample) => sample.targetExtraMinutes),
      [50, 70, 70],
    );
    assert.ok(samples[1].lateralDisplacementMeters > samples[0].lateralDisplacementMeters);
    assert.deepEqual(
      samples.map((sample) => sample.journeyProgress),
      [0.25, 0.5, 0.75],
    );
  });

  it("scales lateral exploration by journey length instead of using one fixed corridor", () => {
    const short = targetLateralDisplacementMeters({
      baselineDistanceMeters: 100_000,
      baselineDurationSeconds: 3_857,
      targetExtraMinutes: 70,
    });
    const oxfordToGlasgow = targetLateralDisplacementMeters({
      baselineDistanceMeters: 560_000,
      baselineDurationSeconds: 21_600,
      targetExtraMinutes: 70,
    });
    assert.equal(short, 15_000);
    assert.equal(oxfordToGlasgow, 54_444);
    const modelledAddedMinutes = (oxfordToGlasgow * 2) / (560_000 / 21_600) / 60;
    assert.ok(modelledAddedMinutes >= 69 && modelledAddedMinutes <= 71);
  });

  it("adapts the final bounded target after a routed undershoot", () => {
    assert.equal(
      adaptiveDurationTargetMinutes({
        nextTargetMinutes: 70,
        priorIntendedMinutes: 50,
        priorActualMinutes: 28,
        maximumExtraMinutes: 85,
      }),
      85,
    );
    assert.equal(
      adaptiveDurationTargetMinutes({
        nextTargetMinutes: 70,
        priorIntendedMinutes: 50,
        priorActualMinutes: 42,
        maximumExtraMinutes: 85,
      }),
      70,
    );
    assert.equal(
      adaptiveDurationTargetMinutes({
        nextTargetMinutes: 90,
        priorIntendedMinutes: 50,
        priorActualMinutes: 45,
        maximumExtraMinutes: 85,
      }),
      85,
    );
  });

  it("selects displaced waypoints across coherent forward journey segments", () => {
    const routeAnchors = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
      { lat: 0, lng: 2 },
      { lat: 0, lng: 3 },
    ];
    const result = buildCorridorPlans({
      places: [
        place("near-a", 0.03, 0.5, "woods"),
        place("far-a", 0.4, 0.5, "woods"),
        place("near-b", 0.03, 2.5, "woods"),
        place("far-b", 0.4, 2.5, "woods"),
      ],
      anchors: routeAnchors,
      maximumEstimatedDetourMeters: 100_000,
      maximumPlans: 1,
      targetDetourMeters: [50_000],
    });
    assert.equal(result.plans[0].waypoints.length, 2);
    assert.deepEqual(
      result.plans[0].waypoints.map((waypoint) => waypoint.id),
      ["far-a", "far-b"],
    );
    assert.ok(
      result.plans[0].waypoints[0].insertionIndex < result.plans[0].waypoints[1].insertionIndex,
    );
    assert.deepEqual(
      corridorWaypointsWithRequiredStops([], routeAnchors, result.plans[0]).map(
        (waypoint) => waypoint.lng,
      ),
      [0.5, 2.5],
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
    assert.deepEqual(summaries.find((item) => item.minutes === 60)?.targets.slice(-2), [50, 55]);
    assert.deepEqual(summaries.find((item) => item.minutes === 85)?.targets.slice(-2), [70, 75]);
    assert.deepEqual(summaries.find((item) => item.minutes === 240)?.targets.slice(-2), [180, 215]);
  });

  it("reallocates capped-equivalent target geometry without exposing coordinates", () => {
    const input = {
      samples: [
        { lat: 51, lng: 179.7 },
        { lat: 52, lng: -179.8 },
        { lat: 53, lng: -179.3 },
      ],
      baselineDistanceMeters: 560_000,
      baselineDurationSeconds: 21_600,
    };
    const collided = distinctDurationTargetsBySearchGeometry({
      ...input,
      targetExtraMinutes: [105, 150],
    });
    assert.deepEqual(collided, { targets: [105], distinctGeometryCount: 1, collisionCount: 1 });
    const distinct = distinctDurationTargetsBySearchGeometry({
      ...input,
      targetExtraMinutes: [30, 60],
    });
    assert.deepEqual(distinct, { targets: [30, 60], distinctGeometryCount: 2, collisionCount: 0 });
    assert.doesNotMatch(JSON.stringify(collided), /lat|lng|179/);
  });

  it("runs the Production-used bounded sequence through collision, providers, recording and final selection", async () => {
    type Candidate = ScoredRouteCandidate<{ total: number }>;
    const candidate = (
      originalIndex: number,
      addedMinutes: number,
      score: number,
      geometry: string,
    ): Candidate => ({
      candidateId: originalIndex === 0 ? "baseline-fixture" : `fictional-${originalIndex}`,
      originalIndex,
      source: originalIndex === 0 ? "fastest" : "scenik",
      directions: {
        encodedPolyline: geometry,
        durationSeconds: 3_600 + addedMinutes * 60,
        distanceMeters: 50_000 + originalIndex * 1_000,
        duration: "",
        distance: "",
        steps: [],
      },
      score,
      scoreResult: { total: score },
      routeShapeEligible: true,
      evidence:
        originalIndex === 0
          ? undefined
          : {
              natural: 1,
              historic: 0,
              cultural: 0,
              coastal: 0,
              viewpoint: 0,
              wildlife: 0,
              food: 0,
              otherPoi: 0,
            },
    });

    const runFixture = async (refinementSucceeds: boolean) => {
      const candidates = [candidate(0, 0, 78, "baseline-geometry")];
      const events: string[] = [];
      const coordinator = createPositiveAllowanceProductionCoordinator({ candidates });
      const collision = coordinator.prepareStage({
        samples: [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 1 },
          { lat: 0, lng: 2 },
        ],
        baselineDistanceMeters: 560_000,
        baselineDurationSeconds: 21_600,
        targetExtraMinutes: [105, 150],
      });
      assert.deepEqual(collision.targets, [105]);
      assert.deepEqual(coordinator.counts(), {
        placesRequestsStarted: 0,
        routeRequestsStarted: 0,
        remainingRouteRequests: 6,
      });

      let ordinaryOrdinal = 0;
      for (const stage of explorationStages(180)) {
        const prepared = coordinator.prepareStage({
          samples: Array.from({ length: stage.sampleCap }, (_, index) => ({
            lat: 0,
            lng: index + 1,
          })),
          baselineDistanceMeters: 560_000,
          baselineDurationSeconds: 21_600,
          targetExtraMinutes: stage.targetExtraMinutes,
        });
        await coordinator.collectPlaces(
          prepared.samples.map((sample) => sample.center),
          async () => {
            events.push("places");
            return [];
          },
        );
        for (const target of prepared.targets) {
          ordinaryOrdinal += 1;
          const [response] = await Promise.allSettled([
            coordinator.requestRoute(async () => {
              events.push(`ordinary-${target}`);
              if (target !== 30) throw new Error("FICTIONAL_PROVIDER_FAILURE");
              return candidate(ordinaryOrdinal, 63, 71, "medium-geometry");
            }),
          ]);
          if (response.status === "fulfilled") coordinator.recordCandidate(response.value);
        }
      }

      assert.equal(coordinator.counts().remainingRouteRequests, 2);
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const [refinement] = await Promise.allSettled([
          coordinator.requestRoute(async () => {
            events.push(`refinement-${attempt}`);
            if (!refinementSucceeds || attempt === 1)
              throw new Error("FICTIONAL_REFINEMENT_FAILURE");
            return candidate(6, 150, 71, "refined-target-geometry");
          }),
        ]);
        if (refinement.status === "fulfilled") coordinator.recordCandidate(refinement.value);
      }

      events.push("final-rescore");
      const selection = coordinator.finalise((recorded) => selectRouteCandidate(recorded, 180));
      const presentation = timeBudgetExplanation(
        selection.measuredExtraTimeSeconds,
        180,
        true,
        selection.timeTargetOutcome,
      );
      assert.equal(coordinator.counts().placesRequestsStarted, 15);
      assert.equal(coordinator.counts().routeRequestsStarted, 6);
      assert.equal(events.at(-1), "final-rescore");
      assert.equal(
        candidates.filter((item) => item.candidateId === "fictional-6").length,
        refinementSucceeds ? 1 : 0,
      );
      await assert.rejects(() => coordinator.requestRoute(async () => candidate(7, 170, 80, "x")));
      return { candidates, selection, presentation };
    };

    const medium = await runFixture(false);
    assert.equal(medium.selection.selected.directions.durationSeconds, 3_600 + 63 * 60);
    assert.equal(medium.selection.selected.directions.encodedPolyline, "medium-geometry");
    assert.equal(medium.selection.timeTargetOutcome, "MEANINGFUL_FALLBACK");
    assert.match(medium.presentation.explanation, /useful longer route/i);

    const refined = await runFixture(true);
    assert.equal(refined.selection.selected.directions.durationSeconds, 3_600 + 150 * 60);
    assert.equal(refined.selection.selected.directions.encodedPolyline, "refined-target-geometry");
    assert.equal(refined.selection.timeTargetOutcome, "TARGET_MET");
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
