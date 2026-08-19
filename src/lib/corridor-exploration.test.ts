import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adaptiveDurationTargetMinutes,
  budgetUtilisation,
  buildCorridorPlans,
  classifyDurationTargetResult,
  corridorWaypointsWithRequiredStops,
  createOrdinaryPlanningCounter,
  createPositiveAllowanceProductionCoordinator,
  didCompleteFullAllowanceSearch,
  distinctDurationTargetsBySearchGeometry,
  durationAwareCorridorSamples,
  effectivePlanningOutcome,
  effectiveRoutePlanSignature,
  explorationShouldStop,
  explorationStages,
  geographicDestinationPoint,
  isTargetBudgetCandidate,
  positiveAllowanceTargetLadder,
  positiveAllowanceAttemptRoles,
  prepareRoleSpecificCorridorPlan,
  deterministicallyRankCorridorEvidence,
  selectPlansForDetourTargets,
  targetLateralDisplacementMeters,
} from "./corridor-exploration";
import { timeBudgetExplanation } from "./route-presentation";
import { selectRouteCandidate, type ScoredRouteCandidate } from "./route-selection";
import { isValidLatLng, type ScenicPlace } from "./scenic-waypoint";
import { effectiveConstructionMetadata } from "./route-duration-refinement";

const anchors = [
  { lat: 0, lng: 0 },
  { lat: 0, lng: 1 },
  { lat: 0, lng: 2 },
];

function place(id: string, lat: number, lng: number, primaryType: string): ScenicPlace {
  return { id, lat, lng, primaryType, types: [primaryType] };
}

describe("budget-driven corridor exploration", () => {
  it("accounts for each processed ordinary target exactly once", () => {
    const counter = createOrdinaryPlanningCounter(8);
    counter.record("PLANNED");
    counter.record("EFFECTIVE_COLLISION");
    counter.record("NO_PLAN");
    counter.record("PLANNED"); // A later provider failure does not change planning.
    counter.record("EFFECTIVE_COLLISION"); // Pre-search geometry collision.
    counter.record("EFFECTIVE_COLLISION"); // Post-evidence effective collision.
    counter.record("PLANNED");
    counter.record("NO_PLAN");
    assert.deepEqual(counter.snapshot(), {
      scheduled: 8,
      processed: 8,
      distinct: 3,
      collisions: 3,
      noPlan: 2,
    });
  });

  it("reports early stops without assigning outcomes to unprocessed targets", () => {
    const counter = createOrdinaryPlanningCounter(5);
    counter.record("PLANNED");
    counter.record("NO_PLAN");
    assert.deepEqual(counter.snapshot(), {
      scheduled: 5,
      processed: 2,
      distinct: 1,
      collisions: 0,
      noPlan: 1,
    });
  });

  it("cannot count one scheduled target twice or exceed processed targets", () => {
    const counter = createOrdinaryPlanningCounter(1);
    counter.record("PLANNED");
    counter.record("EFFECTIVE_COLLISION");
    counter.record("NO_PLAN");
    const summary = counter.snapshot();
    assert.deepEqual(summary, {
      scheduled: 1,
      processed: 1,
      distinct: 1,
      collisions: 0,
      noPlan: 0,
    });
    assert.equal(summary.distinct + summary.collisions + summary.noPlan, summary.processed);
  });

  it("preserves explicit effective-collision and no-plan outcomes for empty plans", () => {
    assert.deepEqual(effectivePlanningOutcome({ plans: [], rejectedEffectiveCollision: 1 }), {
      outcome: "EFFECTIVE_COLLISION",
      plan: null,
    });
    assert.deepEqual(effectivePlanningOutcome({ plans: [], rejectedEffectiveCollision: 0 }), {
      outcome: "NO_PLAN",
      plan: null,
    });
  });

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
      [30, 45, 60, 70, 75],
    );
    assert.equal(
      eightyFive.reduce((sum, stage) => sum + stage.sampleCap, 0),
      15,
    );
    assert.equal(eightyFive.at(-1)?.cumulativeRouteCap, 5);
  });

  it("builds exact bounded ladders and reserves refinement capacity", () => {
    const expected = new Map([
      [10, [8, 9]],
      [30, [15, 23, 27]],
      [80, [30, 45, 60, 70]],
      [110, [30, 60, 70, 85, 100]],
      [140, [30, 60, 70, 105, 125]],
      [180, [30, 60, 70, 135, 160]],
      [240, [30, 60, 70, 180, 215]],
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

  it("uses allowance-aware reach instead of capping short routes by baseline length", () => {
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
    assert.equal(short, 54_446);
    assert.equal(oxfordToGlasgow, 54_444);
    const modelledAddedMinutes = (oxfordToGlasgow * 2) / (560_000 / 21_600) / 60;
    assert.ok(modelledAddedMinutes >= 69 && modelledAddedMinutes <= 71);
  });

  it("assigns deterministic distinct construction roles to stable anchors", () => {
    const roles = positiveAllowanceAttemptRoles(positiveAllowanceTargetLadder(180));
    assert.deepEqual(
      roles.map((role) => role.targetExtraMinutes),
      [30, 60, 70, 135, 160],
    );
    assert.equal(
      new Set(roles.map((role) => `${role.side}:${role.progress}:${role.waypointForm}`)).size,
      5,
    );
    assert.equal(
      roles.find((role) => role.targetExtraMinutes === 70)?.waypointForm,
      "two-waypoint-arc",
    );
  });

  it("distinguishes a requested two-waypoint role from its effective one-waypoint fallback", () => {
    const requestedRole = {
      targetExtraMinutes: 30,
      side: "left" as const,
      progress: "distributed" as const,
      waypointForm: "two-waypoint-arc" as const,
      evidencePreference: "overall-scenic" as const,
    };
    const planning = prepareRoleSpecificCorridorPlan({
      places: [place("forest", 0.05, 0.4, "woods"), place("coast", 0.05, 0.6, "beach")],
      preferredTypes: new Set(["woods"]),
      anchors,
      maximumEstimatedDetourMeters: 100_000,
      attemptedSignatures: new Set(),
      attemptedKinds: new Set(),
      targetDetourMeters: [10_000],
      attemptRole: requestedRole,
    });
    assert.equal(planning.plans[0]?.waypoints.length, 1);
    const effective = planning.plans[0]
      ? effectiveConstructionMetadata(planning.plans[0], anchors)
      : null;
    assert.equal(requestedRole.waypointForm, "two-waypoint-arc");
    assert.equal(effective?.waypointForm, "one-waypoint");
    assert.equal(effective?.progress, "middle");
    assert.equal(effective?.orientation, "left");
  });

  it("keeps short-route +30, +80 and +180 constructions meaningfully distinct", () => {
    const samples = [
      { lat: 51.5, lng: -0.2 },
      { lat: 51.55, lng: -0.1 },
      { lat: 51.6, lng: 0 },
    ];
    const signatures = [30, 80, 180].map((allowance) => {
      const targets = positiveAllowanceTargetLadder(allowance);
      const roles = positiveAllowanceAttemptRoles(targets);
      const plans = durationAwareCorridorSamples({
        samples,
        baselineDistanceMeters: 24_000,
        baselineDurationSeconds: 1_200,
        targetExtraMinutes: targets,
        attemptRoles: roles,
      });
      return plans
        .map((plan) =>
          [
            plan.targetExtraMinutes,
            Math.round(plan.lateralDisplacementMeters / 100),
            Math.sign(plan.center.lat - samples[plans.indexOf(plan)].lat),
          ].join(":"),
        )
        .join("|");
    });
    assert.equal(new Set(signatures).size, 3);
    assert.ok(positiveAllowanceTargetLadder(180).includes(70));
    assert.equal(
      targetLateralDisplacementMeters({
        baselineDistanceMeters: 24_000,
        baselineDurationSeconds: 1_200,
        targetExtraMinutes: 180,
      }),
      70_000,
    );
  });

  it("ranks equivalent provider evidence independently of response order", () => {
    const places = [
      { ...place("b", 0, 0.5, "park"), rating: 4.8, userRatingCount: 20 },
      { ...place("a", 0, 0.6, "museum"), rating: 4.8, userRatingCount: 20 },
      place("missing", 0, 0.7, "park"),
    ];
    const preferred = new Set(["park"]);
    const expected = deterministicallyRankCorridorEvidence(places, preferred).map(({ id }) => id);
    assert.deepEqual(expected, ["b", "missing", "a"]);
    assert.deepEqual(
      deterministicallyRankCorridorEvidence([...places].reverse(), preferred).map(({ id }) => id),
      expected,
    );
  });

  it("normalises spherical reach safely across poles and the antimeridian", () => {
    const cases = [
      geographicDestinationPoint({ lat: 51.5, lng: -0.1 }, 70_000, 90),
      geographicDestinationPoint({ lat: 0, lng: 179.9 }, 70_000, 90),
      geographicDestinationPoint({ lat: 0, lng: -179.9 }, 70_000, 270),
      geographicDestinationPoint({ lat: 89.999, lng: 20 }, 70_000, 0),
      geographicDestinationPoint({ lat: -89.999, lng: 20 }, 70_000, 180),
      geographicDestinationPoint({ lat: 90, lng: 180 }, 70_000, 90),
      geographicDestinationPoint({ lat: -90, lng: -180 }, 70_000, 270),
      geographicDestinationPoint({ lat: 51.5, lng: 180 }, 0, 720),
    ];
    assert.ok(cases.every((point) => point != null && isValidLatLng(point)));
    assert.equal(cases.at(-1)?.lng, -180);
    for (const invalid of [
      geographicDestinationPoint({ lat: 91, lng: 0 }, 1, 0),
      geographicDestinationPoint({ lat: 0, lng: 181 }, 1, 0),
      geographicDestinationPoint({ lat: 0, lng: 0 }, 70_001, 0),
      geographicDestinationPoint({ lat: 0, lng: 0 }, Number.NaN, 0),
      geographicDestinationPoint({ lat: 0, lng: 0 }, 1, Number.POSITIVE_INFINITY),
    ])
      assert.equal(invalid, null);
  });

  it("keeps left and right spherical centres valid and on opposite sides", () => {
    const roles = positiveAllowanceAttemptRoles([30, 60]);
    const samples = durationAwareCorridorSamples({
      samples: [
        { lat: 51, lng: -1 },
        { lat: 51, lng: 0 },
        { lat: 51, lng: 1 },
      ],
      baselineDistanceMeters: 24_000,
      baselineDurationSeconds: 1_200,
      targetExtraMinutes: [30, 60],
      attemptRoles: roles,
    });
    assert.ok(samples.every(({ center }) => isValidLatLng(center)));
    assert.ok(samples[0].center.lat > 51);
    assert.ok(samples.at(-1)!.center.lat < 51);
  });

  it("drops invalid generated centres before the Places boundary", async () => {
    const coordinator = createPositiveAllowanceProductionCoordinator({ candidates: [] });
    const prepared = coordinator.prepareStage({
      samples: [
        { lat: 91, lng: 0 },
        { lat: 91, lng: 1 },
      ],
      baselineDistanceMeters: 24_000,
      baselineDurationSeconds: 1_200,
      targetExtraMinutes: [30],
      attemptRoles: positiveAllowanceAttemptRoles([30]),
    });
    let searches = 0;
    await coordinator.collectPlaces(
      prepared.samples.map(({ center }) => center),
      async () => {
        searches += 1;
        return [];
      },
    );
    assert.equal(searches, 0);
    assert.equal(coordinator.counts().placesRequestsStarted, 0);
  });

  it("sanitises malformed evidence metadata and differentiates evidence roles", () => {
    const places = [
      { ...place("preferred", 0, 0, "park"), rating: 4, userRatingCount: 10 },
      { ...place("strong", 0, 1, "museum"), rating: 5, userRatingCount: 100 },
      { ...place("zero", 0, 2, "lake"), rating: 0, userRatingCount: 0 },
      { ...place("nan", 0, 3, "park"), rating: Number.NaN, userRatingCount: Infinity },
      { ...place("negative", 0, 4, "park"), rating: 8, userRatingCount: -1 },
      { ...place("fraction", 0, 5, "park"), rating: 3, userRatingCount: 10.9 },
    ];
    const preferred = new Set(["park"]);
    const preference = deterministicallyRankCorridorEvidence(
      places,
      preferred,
      "preference-match",
    ).map(({ id }) => id);
    const overall = deterministicallyRankCorridorEvidence(places, preferred, "overall-scenic").map(
      ({ id }) => id,
    );
    const alternate = deterministicallyRankCorridorEvidence(
      places,
      preferred,
      "alternate-cluster",
    ).map(({ id }) => id);
    assert.equal(preference[0], "preferred");
    assert.equal(overall[0], "strong");
    assert.equal(alternate[0], "zero");
    for (const permutation of [
      places,
      [...places].reverse(),
      [places[2], ...places.slice(0, 2), ...places.slice(3)],
    ]) {
      assert.deepEqual(
        deterministicallyRankCorridorEvidence(permutation, preferred, "preference-match").map(
          ({ id }) => id,
        ),
        preference,
      );
    }
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

  it("collides effective plans by the exact provider request rather than role labels", () => {
    const waypointA = {
      ...place("provider-a", 0.05, 0.5, "park"),
      reason: "Park",
      insertionIndex: 0,
      estimatedDetourMeters: 1_000,
    };
    const waypointEquivalent = { ...waypointA, id: "provider-b" };
    const one = {
      kind: "other" as const,
      reason: "Scenic corridor",
      waypoints: [waypointA],
      estimatedDetourMeters: 1_000,
      signature: "",
    };
    const equivalent = { ...one, waypoints: [waypointEquivalent] };
    const reordered = {
      ...one,
      waypoints: [{ ...waypointA, insertionIndex: 1, lng: 1.5 }, waypointA],
    };
    assert.equal(
      effectiveRoutePlanSignature(one, anchors),
      effectiveRoutePlanSignature(equivalent, anchors),
    );
    assert.notEqual(
      effectiveRoutePlanSignature(one, anchors),
      effectiveRoutePlanSignature(reordered, anchors),
    );
    const attempted = new Set([effectiveRoutePlanSignature(one, anchors)]);
    const result = buildCorridorPlans({
      places: [waypointEquivalent],
      anchors,
      maximumEstimatedDetourMeters: 10_000,
      maximumPlans: 1,
      attemptedSignatures: attempted,
    });
    assert.equal(result.plans.length, 0);
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
    assert.deepEqual(summaries.find((item) => item.minutes === 60)?.targets.slice(-2), [55, 60]);
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
          attemptRoles: stage.attemptRoles,
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
              if (target !== 70) throw new Error("FICTIONAL_PROVIDER_FAILURE");
              return candidate(ordinaryOrdinal, 63, 71, "medium-geometry");
            }),
          ]);
          if (response.status === "fulfilled") coordinator.recordCandidate(response.value);
        }
      }

      assert.equal(coordinator.counts().remainingRouteRequests, 1);
      for (let attempt = 1; attempt <= 1; attempt += 1) {
        const [refinement] = await Promise.allSettled([
          coordinator.requestRoute(async () => {
            events.push(`refinement-${attempt}`);
            if (!refinementSucceeds) throw new Error("FICTIONAL_REFINEMENT_FAILURE");
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

  it("executes the real +180 Production handler from schedule through presentation", async () => {
    // @ts-expect-error Bun's test runtime provides module-boundary mocks; the repository's
    // project TypeScript configuration intentionally does not include Bun test declarations.
    const { mock } = await import("bun:test");
    const actualTanstack = await import("@tanstack/react-start");
    const actualAuthMiddleware = await import("@/integrations/supabase/auth-middleware");
    const actualInternalTesters = await import("./internal-testers.server");
    const actualOrchestration = await import("./route-generation-orchestration.server");
    const actualGoogleMaps = await import("./google-maps.server");
    const encode = (points: Array<{ lat: number; lng: number }>) => {
      let previousLat = 0;
      let previousLng = 0;
      const delta = (value: number) => {
        let encoded = "";
        let shifted = value < 0 ? ~(value << 1) : value << 1;
        while (shifted >= 0x20) {
          encoded += String.fromCharCode((0x20 | (shifted & 0x1f)) + 63);
          shifted >>= 5;
        }
        return encoded + String.fromCharCode(shifted + 63);
      };
      return points
        .map((point) => {
          const latitude = Math.round(point.lat * 1e5);
          const longitude = Math.round(point.lng * 1e5);
          const value = delta(latitude - previousLat) + delta(longitude - previousLng);
          previousLat = latitude;
          previousLng = longitude;
          return value;
        })
        .join("");
    };
    const start = { lat: 51, lng: -1, formatted: "Fictional origin" };
    const requiredStop = { lat: 51, lng: 0, formatted: "Fictional required stop" };
    const end = { lat: 51, lng: 1, formatted: "Fictional destination" };
    const computed = (
      points: Array<{ lat: number; lng: number }>,
      durationSeconds: number,
      distanceMeters: number,
    ) => ({
      encodedPolyline: encode(points),
      durationSeconds,
      distanceMeters,
      duration: `${Math.round(durationSeconds / 60)} min`,
      distance: `${distanceMeters} m`,
      steps: points.slice(1).map((point, index) => ({
        instruction: "Continue",
        distance: "",
        duration: "",
        distanceMeters: Math.round(distanceMeters / Math.max(1, points.length - 1)),
        durationSeconds: Math.round(durationSeconds / Math.max(1, points.length - 1)),
        startLat: points[index].lat,
        startLng: points[index].lng,
        endLat: point.lat,
        endLng: point.lng,
      })),
    });

    const baselineDurationSeconds = 3_600;
    let placesCalls = 0;
    let scenicRouteCalls = 0;
    let activeFixture: "180" | "30" = "180";
    const submittedWaypointCounts: number[] = [];
    const returnedGeometryByDuration = new Map<number, string>();
    const safePlaceTypes = [
      "woods",
      "historical_place",
      "scenic_spot",
      "beach",
      "wildlife_refuge",
      "farmers_market",
    ];
    const fixedCollisionPlace = {
      id: "fixture-collision-place",
      lat: 51.03,
      lng: -0.45,
      primaryType: "woods",
      types: ["woods", "nature_preserve"],
      displayName: "Fictional woodland",
      rating: 4.5,
      userRatingCount: 50,
    };

    mock.module("@tanstack/react-start", () => ({
      ...actualTanstack,
      createServerFn: () => {
        const builder = {
          middleware: () => builder,
          inputValidator: () => builder,
          handler: (handler: unknown) => handler,
        };
        return builder;
      },
    }));
    mock.module("@/integrations/supabase/auth-middleware", () => ({
      ...actualAuthMiddleware,
      requireSupabaseAuth: {},
    }));
    mock.module("./internal-testers.server", () => ({
      ...actualInternalTesters,
      internalDiagnosticsEnabled: () => true,
      isInternalTestUser: () => true,
    }));
    mock.module("./route-generation-orchestration.server", () => ({
      ...actualOrchestration,
      executeProductionRouteGeneration: async (input: {
        generateRoute(input: { isPremium: boolean }): Promise<unknown>;
      }) => input.generateRoute({ isPremium: true }),
    }));
    mock.module("./google-maps.server", () => ({
      ...actualGoogleMaps,
      geocodeAddress: async (address: string) =>
        address === "Origin" ? start : address === "Stop" ? requiredStop : end,
      searchNearbyScenicPlaces: async ({ center }: { center: { lat: number; lng: number } }) => {
        placesCalls += 1;
        if (activeFixture === "180" && placesCalls <= 7) return [fixedCollisionPlace];
        return safePlaceTypes.map((primaryType, index) => ({
          id: `fixture-evidence-${placesCalls}-${index}`,
          lat:
            activeFixture === "30"
              ? 51.04 + (index % 3) * 0.004
              : center.lat + (index - 2.5) * 0.002,
          lng:
            activeFixture === "30"
              ? index % 2 === 0
                ? -0.5
                : 0.5
              : center.lng + (index - 2.5) * 0.015,
          primaryType,
          types: [primaryType, "woods", "nature_preserve"],
          displayName: `Fictional evidence ${placesCalls}-${index}`,
          rating: 4.8 - index * 0.05,
          userRatingCount: 100 - index,
        }));
      },
      computeDirections: async (input: {
        origin: { lat: number; lng: number };
        destination: { lat: number; lng: number };
        waypoints?: Array<{ lat: number; lng: number }>;
      }) => {
        if (scenicRouteCalls === 0 && (input.waypoints?.length ?? 0) === 1) {
          scenicRouteCalls = -1;
          return computed([start, requiredStop, end], baselineDurationSeconds, 140_000);
        }
        scenicRouteCalls = Math.max(0, scenicRouteCalls) + 1;
        const ordinal = scenicRouteCalls;
        const waypoints = input.waypoints ?? [];
        submittedWaypointCounts.push(waypoints.length - 1);
        if (activeFixture === "180" && ordinal === 1) throw new Error("FICTIONAL_PROVIDER_FAILURE");
        const addedSecondsByOrdinal =
          activeFixture === "180"
            ? [0, 70 * 60 + 1, 145 * 60, 160 * 60 + 1]
            : [38.7 * 60, 57.7 * 60, 79.6 * 60, 35 * 60, 27 * 60];
        const addedSeconds =
          addedSecondsByOrdinal[Math.min(ordinal, addedSecondsByOrdinal.length) - 1];
        const requestedPoints =
          activeFixture === "30" && ordinal >= 3
            ? [
                start,
                ...[...waypoints, { lat: 51.04, lng: -0.5 }, { lat: 51.04, lng: 0.5 }].sort(
                  (a, b) => a.lng - b.lng,
                ),
                end,
              ]
            : [start, ...waypoints, end];
        const returnedPoints =
          (activeFixture === "180" && ordinal === 3 && waypoints.length >= 2) ||
          (activeFixture === "30" && ordinal <= 2 && waypoints.length >= 2)
            ? [start, waypoints[1], waypoints[0], ...waypoints.slice(2), end]
            : requestedPoints;
        const directions = computed(
          returnedPoints,
          baselineDurationSeconds + addedSeconds,
          150_000 + ordinal * 10_000,
        );
        returnedGeometryByDuration.set(directions.durationSeconds, directions.encodedPolyline);
        return directions;
      },
    }));

    const diagnosticLogs: string[] = [];
    const originalInfo = console.info;
    console.info = (...values: unknown[]) => {
      const line = values.map(String).join(" ");
      if (line.startsWith("scenik-route-summary-v3 ")) diagnosticLogs.push(line);
    };
    try {
      const { planScenicRoute } = await import(`./routes.functions?production-180=${Date.now()}`);
      const result = await (
        planScenicRoute as unknown as (input: {
          data: {
            start_address: string;
            end_address: string;
            mood: string;
            theme: string;
            extra_minutes: number;
            stops: string[];
          };
          context: { userId: string; supabase: object };
        }) => Promise<{
          scoringDiagnostics: {
            explorationTargets: Array<{ targetExtraMinutes: number[] }>;
            scenicRouteRequestsAttempted: number;
            generatedCandidateOutcomes: Array<{
              addedMinutes: number;
              intendedAddedMinutes: number;
              outcome: string;
            }>;
          };
          scenic_score: number;
          selectedWinner: string;
          directions: { durationSeconds: number; encodedPolyline: string };
          selectedRouteDurationSeconds: number;
          fastestRouteDurationSeconds: number;
          measuredExtraTimeSeconds: number;
          timeTargetOutcome: string;
          narrative: string;
          routeGenerationDiagnostics: {
            candidateEligibility: Array<{
              intendedTargetMinutes: number | null;
              actualAddedMinutes: number | null;
              routeShapeEligible: boolean | null;
              duplicateEligible: boolean | null;
              effectiveWaypointCount: number | null;
              effectiveWaypointForm: string | null;
              effectiveProgress: string | null;
              effectiveOrientation: string | null;
              refinementAttemptNumber: number | null;
              refinementStrategy: string | null;
              selected: boolean;
              evidenceEligible: boolean | null;
              qualityEligible: boolean | null;
              scenicScore: number | null;
            }>;
            durationRefinement: {
              providerRequestsStarted: number;
              stopReason: string;
            } | null;
          };
        }>
      )({
        data: {
          start_address: "Origin",
          end_address: "Destination",
          mood: "Peaceful",
          theme: "Forest",
          extra_minutes: 180,
          stops: ["Stop"],
        },
        context: { userId: "00000000-0000-4000-8000-000000000000", supabase: {} },
      });

      assert.deepEqual(
        result.scoringDiagnostics.explorationTargets.flatMap(
          (stage: { targetExtraMinutes: number[] }) => stage.targetExtraMinutes,
        ),
        [30, 60, 70, 135, 160],
      );
      assert.ok(placesCalls <= 15);
      assert.ok(scenicRouteCalls <= 6);
      assert.ok(result.scoringDiagnostics.scenicRouteRequestsAttempted <= 6);
      assert.ok(submittedWaypointCounts.some((count) => count === 1));
      assert.ok(submittedWaypointCounts.some((count) => count === 2));
      assert.ok(
        result.scoringDiagnostics.generatedCandidateOutcomes.some(
          (candidate: { addedMinutes: number; outcome: string }) =>
            candidate.addedMinutes === 70 && candidate.outcome === "ELIGIBLE",
        ),
        JSON.stringify(result.scoringDiagnostics.generatedCandidateOutcomes),
      );
      assert.ok(
        result.scoringDiagnostics.generatedCandidateOutcomes.some(
          (candidate: { outcome: string }) => candidate.outcome === "INCOHERENT_ROUTE",
        ),
      );
      assert.ok(result.scenic_score >= 60);
      assert.notEqual(result.selectedWinner, "fastest");
      assert.equal(result.directions.durationSeconds, result.selectedRouteDurationSeconds);
      assert.equal(
        returnedGeometryByDuration.get(result.selectedRouteDurationSeconds),
        result.directions.encodedPolyline,
      );
      assert.equal(
        result.measuredExtraTimeSeconds,
        result.selectedRouteDurationSeconds - result.fastestRouteDurationSeconds,
      );
      assert.equal(result.timeTargetOutcome, "TARGET_MET");
      assert.match(result.narrative, /larger time allowance unlocked/i);
      assert.equal(diagnosticLogs.length, 1);
      assert.ok(diagnosticLogs[0].length < 8_000);
      for (const forbidden of [
        "Fictional origin",
        "Fictional required stop",
        "Fictional destination",
        "fixture-evidence",
        "fixture-collision-place",
        result.directions.encodedPolyline,
        "00000000-0000-4000-8000-000000000000",
      ])
        assert.equal(diagnosticLogs[0].includes(forbidden), false);
      const summary = JSON.parse(diagnosticLogs[0].slice("scenik-route-summary-v3 ".length));
      assert.deepEqual(summary.plannedTargets, [30, 60, 70, 135, 160]);
      assert.deepEqual(summary.processedTargets, [30, 60, 70, 135, 160]);
      assert.deepEqual(summary.intendedTargets, [30, 60, 70, 135, 160]);
      assert.deepEqual(summary.constructions, {
        scheduled: 5,
        processed: 5,
        distinct: 4,
        collisions: 1,
        noPlan: 0,
      });
      assert.ok(summary.candidates.recorded >= 1);
      assert.equal(summary.refinement.stopReason, "TARGET_REACHED");
      assert.equal(summary.selected.band, "target");
      assert.ok(Math.abs(summary.selected.addedSeconds - result.measuredExtraTimeSeconds) < 6);

      activeFixture = "30";
      placesCalls = 0;
      scenicRouteCalls = 0;
      submittedWaypointCounts.length = 0;
      returnedGeometryByDuration.clear();
      diagnosticLogs.length = 0;
      const downward = await (
        planScenicRoute as unknown as (input: {
          data: {
            start_address: string;
            end_address: string;
            mood: string;
            theme: string;
            extra_minutes: number;
            stops: string[];
          };
          context: { userId: string; supabase: object };
        }) => Promise<typeof result>
      )({
        data: {
          start_address: "Origin",
          end_address: "Destination",
          mood: "Peaceful",
          theme: "Forest",
          extra_minutes: 30,
          stops: ["Stop"],
        },
        context: { userId: "00000000-0000-4000-8000-000000000000", supabase: {} },
      });
      assert.deepEqual(
        downward.scoringDiagnostics.explorationTargets.flatMap(
          (stage: { targetExtraMinutes: number[] }) => stage.targetExtraMinutes,
        ),
        [15, 23, 27],
      );
      assert.equal(scenicRouteCalls, 5);
      assert.ok(placesCalls <= 15);
      assert.equal(downward.scoringDiagnostics.scenicRouteRequestsAttempted, 5);
      assert.equal(downward.selectedWinner, "scenik");
      assert.equal(downward.timeTargetOutcome, "TARGET_MET");
      assert.equal(downward.measuredExtraTimeSeconds, 27 * 60);
      const liveStyleSafeUpper = downward.routeGenerationDiagnostics.candidateEligibility.find(
        (candidate) =>
          candidate.intendedTargetMinutes === 27 && candidate.actualAddedMinutes === 79.6,
      );
      assert.ok(liveStyleSafeUpper);
      assert.equal(liveStyleSafeUpper.routeShapeEligible, true);
      assert.equal(liveStyleSafeUpper.duplicateEligible, true);
      assert.equal(liveStyleSafeUpper.effectiveWaypointCount, 2);
      assert.equal(liveStyleSafeUpper.effectiveWaypointForm, "two-waypoint-arc");
      assert.notEqual(liveStyleSafeUpper.effectiveProgress, null);
      assert.notEqual(liveStyleSafeUpper.effectiveOrientation, null);
      assert.equal(
        downward.routeGenerationDiagnostics.candidateEligibility.some(
          (candidate) =>
            candidate.effectiveWaypointCount === 2 &&
            (candidate.effectiveWaypointForm == null ||
              candidate.effectiveProgress == null ||
              candidate.effectiveOrientation == null),
        ),
        false,
      );
      assert.equal(
        downward.routeGenerationDiagnostics.durationRefinement?.providerRequestsStarted,
        2,
      );
      assert.equal(
        downward.routeGenerationDiagnostics.candidateEligibility.some(
          (candidate) => candidate.refinementStrategy === "BASELINE_ZERO_BRACKET",
        ),
        true,
      );
      assert.equal(
        downward.routeGenerationDiagnostics.durationRefinement?.stopReason,
        "TARGET_REACHED",
      );
      const selectedRefinement = downward.routeGenerationDiagnostics.candidateEligibility.find(
        (candidate) => candidate.selected && candidate.refinementAttemptNumber != null,
      );
      assert.ok(selectedRefinement);
      assert.equal(selectedRefinement.actualAddedMinutes, 27);
      assert.equal(selectedRefinement.evidenceEligible, true);
      assert.equal(selectedRefinement.qualityEligible, true);
      assert.ok((selectedRefinement.scenicScore ?? 0) >= 60);
      assert.equal(
        returnedGeometryByDuration.get(downward.selectedRouteDurationSeconds),
        downward.directions.encodedPolyline,
      );
      assert.equal(diagnosticLogs.length, 1);
      const downwardSummary = JSON.parse(
        diagnosticLogs[0].slice("scenik-route-summary-v3 ".length),
      );
      assert.deepEqual(downwardSummary.plannedTargets, [15, 23, 27]);
      assert.deepEqual(downwardSummary.processedTargets, [15, 23, 27]);
      assert.deepEqual(downwardSummary.intendedTargets, [15, 23, 27]);
      assert.equal(downwardSummary.refinement.attemptsUsed, 2);
      assert.equal(downwardSummary.refinement.stopReason, "TARGET_REACHED");
      assert.equal(downwardSummary.selected.band, "target");
    } finally {
      console.info = originalInfo;
      mock.restore();
    }
  });
});
