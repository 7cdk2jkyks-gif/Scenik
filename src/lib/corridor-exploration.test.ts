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

  it("does not stop remaining ordinary attempts for a provisional score-50 target", () => {
    assert.equal(
      explorationShouldStop({
        bestScore: 50,
        bestHighUtilisationScore: 50,
        bestQualityEquivalentUtilisation: 135 / 165,
        requestedExtraMinutes: 165,
        stagesExplored: 3,
        stagesRemaining: 1,
      }),
      false,
    );
    assert.equal(
      explorationShouldStop({
        bestScore: 65,
        bestHighUtilisationScore: 65,
        bestQualityEquivalentUtilisation: 130 / 165,
        requestedExtraMinutes: 165,
        stagesExplored: 3,
        stagesRemaining: 1,
      }),
      true,
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
    const actualRouteCoherence = await import("./route-coherence");
    const actualSafeEvaluateRouteCoherenceWithAnchors =
      actualRouteCoherence.safeEvaluateRouteCoherenceWithAnchors;
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
    const familylessStart = { lat: 89.5, lng: -10, formatted: "Fictional polar origin" };
    const familylessStop = { lat: 89.5, lng: 0, formatted: "Fictional polar stop" };
    const familylessEnd = { lat: 89.5, lng: 10, formatted: "Fictional polar destination" };
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
    let recoveryBaselineReturned = true;
    let activeFixture:
      | "180"
      | "165"
      | "165-meaningful"
      | "30"
      | "30-live"
      | "30-live-familyless"
      | "65-live"
      | "recovery-65-live"
      | "invalid-index-spur"
      | "recovery"
      | "recovery-over"
      | "recovery-under"
      | "recovery-invalid"
      | "recovery-provider-failure" = "180";
    const submittedWaypointCounts: number[] = [];
    const submittedShapingWaypoints: Array<Array<{ lat: number; lng: number }>> = [];
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
    mock.module("./route-coherence", () => ({
      ...actualRouteCoherence,
      safeEvaluateRouteCoherenceWithAnchors: (
        ...args: Parameters<typeof actualSafeEvaluateRouteCoherenceWithAnchors>
      ) => {
        const result = actualSafeEvaluateRouteCoherenceWithAnchors(...args);
        if (
          activeFixture === "recovery-65-live" &&
          scenicRouteCalls >= 1 &&
          scenicRouteCalls <= 4
        ) {
          const affectedWaypointIndex = scenicRouteCalls <= 3 ? 0 : 1;
          return {
            ...result,
            routeShapeEligible: false,
            routeShapeRejectionReason: "WAYPOINT_SPUR" as const,
            waypointSpurDetected: true,
            affectedWaypointIndex,
          };
        }
        return activeFixture === "invalid-index-spur"
          ? {
              ...result,
              routeShapeEligible: false,
              routeShapeRejectionReason: "WAYPOINT_SPUR" as const,
              waypointSpurDetected: true,
              affectedWaypointIndex: args[1].length,
            }
          : result;
      },
    }));
    mock.module("./google-maps.server", () => ({
      ...actualGoogleMaps,
      geocodeAddress: async (address: string) => {
        const fixtureStart = activeFixture === "30-live-familyless" ? familylessStart : start;
        const fixtureStop = activeFixture === "30-live-familyless" ? familylessStop : requiredStop;
        const fixtureEnd = activeFixture === "30-live-familyless" ? familylessEnd : end;
        return address === "Origin" ? fixtureStart : address === "Stop" ? fixtureStop : fixtureEnd;
      },
      searchNearbyScenicPlaces: async ({ center }: { center: { lat: number; lng: number } }) => {
        placesCalls += 1;
        if (activeFixture === "180" && placesCalls <= 7) return [fixedCollisionPlace];
        if (activeFixture === "65-live" || activeFixture === "recovery-65-live")
          return [
            {
              id: "sixty-five-left-woods",
              lat: 51.04,
              lng: -0.5,
              primaryType: "woods",
              types: ["woods", "nature_preserve"],
              displayName: "Fictional western woodland",
              rating: 4.8,
              userRatingCount: 100,
            },
            ...(placesCalls > 3
              ? [
                  {
                    id: "sixty-five-right-history",
                    lat: 50.96,
                    lng: 0.5,
                    primaryType: "historical_place",
                    types: ["historical_place"],
                    displayName: "Fictional eastern history",
                    rating: 4.6,
                    userRatingCount: 80,
                  },
                  ...Array.from({ length: 3 }, (_, index) => ({
                    id: `sixty-five-right-woods-${index}`,
                    lat: 50.96,
                    lng: 0.5,
                    primaryType: "woods",
                    types:
                      index === 0
                        ? ["woods", "nature_preserve", "wildlife_refuge"]
                        : ["woods", "nature_preserve"],
                    displayName: `Fictional eastern woodland ${index}`,
                    rating: 4.5,
                    userRatingCount: 70 - index,
                  })),
                ]
              : []),
            ...(placesCalls > 7
              ? [
                  {
                    id: "sixty-five-middle-view",
                    lat: 50.96,
                    lng: 0.96,
                    primaryType: "scenic_spot",
                    types: ["scenic_spot"],
                    displayName: "Fictional middle viewpoint",
                    rating: 4.7,
                    userRatingCount: 90,
                  },
                  ...Array.from({ length: 1 }, (_, index) => ({
                    id: `sixty-five-middle-woods-${index}`,
                    lat: 50.96,
                    lng: 0.96,
                    primaryType: "woods",
                    types: ["woods", "nature_preserve"],
                    displayName: `Fictional terminal woodland ${index}`,
                    rating: 4.5,
                    userRatingCount: 60 - index,
                  })),
                ]
              : []),
            ...(placesCalls > 12
              ? [
                  {
                    id: "sixty-five-left-woods-east",
                    lat: 51.04,
                    lng: 0.5,
                    primaryType: "woods",
                    types: ["woods", "nature_preserve"],
                    displayName: "Fictional eastern woodland",
                    rating: 4.7,
                    userRatingCount: 90,
                  },
                ]
              : []),
          ];
        if (activeFixture === "30-live")
          return [
            {
              id: "live-thirty-west",
              lat: 51.04,
              lng: -0.5,
              primaryType: "woods",
              types: ["woods", "nature_preserve"],
              displayName: "Fictional western woodland",
              rating: 4.5,
              userRatingCount: 50,
            },
            {
              id: "live-thirty-east",
              lat: 51.04,
              lng: 0.5,
              primaryType: "woods",
              types: ["woods", "nature_preserve"],
              displayName: "Fictional eastern woodland",
              rating: 4.5,
              userRatingCount: 50,
            },
          ];
        if (activeFixture === "30-live-familyless")
          return [
            {
              id: "familyless-west",
              lat: 89.49,
              lng: -5,
              primaryType: "woods",
              types: ["woods", "nature_preserve"],
              displayName: "Fictional polar woodland",
              rating: 4.5,
              userRatingCount: 50,
            },
            {
              id: "familyless-east",
              lat: 89.49,
              lng: 5,
              primaryType: "woods",
              types: ["woods", "nature_preserve"],
              displayName: "Fictional polar viewpoint",
              rating: 4.5,
              userRatingCount: 50,
            },
          ];
        if (activeFixture.startsWith("165"))
          return [
            {
              id: "commitment-woods-west",
              lat: 51.04,
              lng: -0.5,
              primaryType: "woods",
              types: ["woods", "nature_preserve"],
              displayName: "Fictional western woodland",
              rating: 4.8,
              userRatingCount: 100,
            },
            {
              id: "commitment-woods-east",
              lat: 51.04,
              lng: 0.5,
              primaryType: "woods",
              types: ["woods", "nature_preserve"],
              displayName: "Fictional eastern woodland",
              rating: 4.7,
              userRatingCount: 90,
            },
            {
              id: "commitment-history",
              lat: 50.6,
              lng: -0.4,
              primaryType: "historical_place",
              types: ["historical_place"],
              displayName: "Fictional history",
              rating: 4.3,
              userRatingCount: 40,
            },
            {
              id: "commitment-view",
              lat: 50.6,
              lng: 0,
              primaryType:
                placesCalls >= 13 && placesCalls <= 14 ? "scenic_spot" : "farmers_market",
              types: [placesCalls >= 13 && placesCalls <= 14 ? "scenic_spot" : "farmers_market"],
              displayName: "Fictional viewpoint",
              rating: 4.2,
              userRatingCount: 30,
            },
            {
              id: "commitment-coast",
              lat: 50.6,
              lng: 0.4,
              primaryType: "beach",
              types: ["beach"],
              displayName: "Fictional coast",
              rating: 4.1,
              userRatingCount: 20,
            },
            {
              id: `commitment-distinct-${placesCalls}`,
              lat: center.lat,
              lng: center.lng,
              primaryType: "scenic_spot",
              types: ["scenic_spot"],
              displayName: `Fictional distinct point ${placesCalls}`,
              rating: 3.5,
              userRatingCount: 5,
            },
            {
              id: `commitment-distinct-history-${placesCalls}`,
              lat: center.lat - 0.5,
              lng: center.lng,
              primaryType: "historical_place",
              types: ["historical_place"],
              displayName: `Fictional distinct history ${placesCalls}`,
              rating: 3.4,
              userRatingCount: 4,
            },
          ];
        return safePlaceTypes.map((primaryType, index) => ({
          id: `fixture-evidence-${placesCalls}-${index}`,
          lat:
            activeFixture !== "180"
              ? 51.04 + (index % 3) * 0.004
              : center.lat + (index - 2.5) * 0.002,
          lng:
            activeFixture !== "180"
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
        alternatives?: boolean;
      }) => {
        const fixtureBaselineDurationSeconds =
          activeFixture === "65-live"
            ? 24_157
            : activeFixture === "recovery-65-live"
              ? 24_762
              : baselineDurationSeconds;
        const fixtureStart = activeFixture === "30-live-familyless" ? familylessStart : start;
        const fixtureStop = activeFixture === "30-live-familyless" ? familylessStop : requiredStop;
        const fixtureEnd = activeFixture === "30-live-familyless" ? familylessEnd : end;
        if (
          (!recoveryBaselineReturned && input.alternatives !== true) ||
          (scenicRouteCalls === 0 &&
            (input.waypoints?.length ?? 0) === (activeFixture === "30-live" ? 0 : 1))
        ) {
          if (activeFixture === "recovery-65-live") recoveryBaselineReturned = true;
          scenicRouteCalls = -1;
          const fastest = computed(
            [fixtureStart, fixtureStop, fixtureEnd],
            fixtureBaselineDurationSeconds,
            140_000,
          );
          if (activeFixture.startsWith("30-live")) {
            const liveFastest = computed(
              [
                fixtureStart,
                activeFixture === "30-live-familyless"
                  ? { lat: 89.5, lng: -9 }
                  : { lat: 51, lng: -0.9 },
                fixtureEnd,
              ],
              fixtureBaselineDurationSeconds,
              160_000,
            );
            liveFastest.steps[0].distanceMeters = 500;
            liveFastest.steps[1].distanceMeters = 159_500;
            return liveFastest;
          }
          return activeFixture.startsWith("165")
            ? {
                ...fastest,
                steps: fastest.steps.map((step) => ({ ...step, distanceMeters: 500 })),
              }
            : fastest;
        }
        if (activeFixture.startsWith("30-live") && input.alternatives)
          return computed(
            [
              fixtureStart,
              activeFixture === "30-live-familyless"
                ? { lat: 89.5, lng: -9 }
                : { lat: 51, lng: -0.9 },
              fixtureEnd,
            ],
            fixtureBaselineDurationSeconds,
            160_000,
          );
        scenicRouteCalls = Math.max(0, scenicRouteCalls) + 1;
        const ordinal = scenicRouteCalls;
        const waypoints = input.waypoints ?? [];
        submittedWaypointCounts.push(waypoints.length - 1);
        submittedShapingWaypoints.push(waypoints.slice(0, -1).map((waypoint) => ({ ...waypoint })));
        if (activeFixture === "180" && ordinal === 1) throw new Error("FICTIONAL_PROVIDER_FAILURE");
        if (activeFixture === "recovery-provider-failure" && ordinal === 4)
          throw new Error("FICTIONAL_RECOVERY_PROVIDER_FAILURE");
        const addedSecondsByOrdinal =
          activeFixture === "180"
            ? [0, 70 * 60 + 1, 145 * 60, 160 * 60 + 1]
            : activeFixture === "165"
              ? [32.1 * 60, 103 * 60, 135 * 60, 120 * 60, 125 * 60]
              : activeFixture === "165-meaningful"
                ? [32.1 * 60, 103 * 60, 60 * 60, 180 * 60, 125 * 60, 135 * 60]
                : activeFixture === "30"
                  ? [32.9 * 60, 31.9 * 60, 69.9 * 60, 35 * 60, 27 * 60]
                  : activeFixture === "65-live"
                    ? [58.3 * 60, 41.1 * 60, 78.3 * 60, 183.1 * 60, 59 * 60]
                    : activeFixture === "recovery-65-live"
                      ? [49.5 * 60, 49.5 * 60, 97.5 * 60, 146.5 * 60, 10.3 * 60, 59 * 60]
                      : activeFixture.startsWith("30-live")
                        ? [20.2 * 60, 59.9 * 60, 96.4 * 60, 27 * 60]
                        : activeFixture === "invalid-index-spur"
                          ? [32.9 * 60, 31.9 * 60, 69.9 * 60]
                          : activeFixture === "recovery-over"
                            ? [40 * 60, 55.9 * 60, 91 * 60, 40 * 60, 27 * 60]
                            : activeFixture === "recovery-under"
                              ? [40 * 60, 55.9 * 60, 91 * 60, 18 * 60, 27 * 60]
                              : activeFixture === "recovery-invalid"
                                ? [40 * 60, 55.9 * 60, 91 * 60, 45 * 60, 27 * 60]
                                : [40 * 60, 55.9 * 60, 91 * 60, 27 * 60, 27 * 60];
        const addedSeconds =
          addedSecondsByOrdinal[Math.min(ordinal, addedSecondsByOrdinal.length) - 1];
        const requestedPoints =
          activeFixture !== "180" &&
          ((activeFixture === "30" && ordinal >= 3) ||
            (activeFixture.startsWith("30-live") && ordinal >= 4) ||
            (activeFixture.startsWith("recovery") &&
              activeFixture !== "recovery-65-live" &&
              ordinal >= 4))
            ? [
                fixtureStart,
                ...[
                  ...waypoints,
                  activeFixture === "30-live-familyless"
                    ? { lat: 89.49, lng: -5 }
                    : { lat: 51.04, lng: -0.5 },
                  ...(activeFixture.startsWith("30-live")
                    ? [
                        activeFixture === "30-live-familyless"
                          ? { lat: 89.4, lng: 0 }
                          : { lat: 50.8, lng: 0 },
                      ]
                    : []),
                  activeFixture === "30-live-familyless"
                    ? { lat: 89.49, lng: 5 }
                    : { lat: 51.04, lng: 0.5 },
                ].sort((a, b) => a.lng - b.lng),
                fixtureEnd,
              ]
            : (activeFixture === "65-live" && ordinal >= 5) ||
                (activeFixture === "recovery-65-live" && ordinal === 6)
              ? [
                  fixtureStart,
                  ...[
                    ...waypoints,
                    ...(activeFixture === "recovery-65-live" ? [{ lat: 51.04, lng: -0.5 }] : []),
                    { lat: 50.96, lng: 0.5 },
                    { lat: 50.96, lng: 0.96 },
                  ].sort((a, b) => a.lng - b.lng),
                  fixtureEnd,
                ]
              : [fixtureStart, ...waypoints, fixtureEnd];
        const returnedPoints =
          activeFixture === "invalid-index-spur"
            ? [start, waypoints[0], start, ...waypoints.slice(1), end]
            : activeFixture === "65-live" && ordinal === 1
              ? [start, waypoints[0], start, ...waypoints.slice(1), end]
              : activeFixture === "65-live" && ordinal === 4
                ? [start, { lat: 51, lng: -0.7 }, { lat: 51, lng: -0.9 }, ...waypoints, end]
                : activeFixture === "recovery-65-live" && ordinal <= 2
                  ? [start, waypoints[0], start, ...waypoints.slice(1), end]
                  : activeFixture === "recovery-65-live" && ordinal <= 4
                    ? [start, ...waypoints, waypoints[1] ?? waypoints[0], end]
                    : activeFixture.startsWith("30-live") && ordinal === 1
                      ? [
                          fixtureStart,
                          ...[
                            ...waypoints,
                            activeFixture === "30-live-familyless"
                              ? { lat: 89.49, lng: -5 }
                              : { lat: 51.04, lng: -0.5 },
                            activeFixture === "30-live-familyless"
                              ? { lat: 89.49, lng: 5 }
                              : { lat: 51.04, lng: 0.5 },
                          ].sort((a, b) => a.lng - b.lng),
                          fixtureEnd,
                        ]
                      : activeFixture.startsWith("30-live") && ordinal === 2
                        ? [
                            fixtureStart,
                            waypoints[0],
                            fixtureStart,
                            ...waypoints.slice(1),
                            fixtureEnd,
                          ]
                        : activeFixture.startsWith("165") &&
                            (ordinal <= 2 ||
                              (ordinal >= 4 &&
                                !(
                                  activeFixture === "165-meaningful" &&
                                  (ordinal === 4 || ordinal === 6)
                                )))
                          ? [start, waypoints[0], start, ...waypoints.slice(1), end]
                          : activeFixture.startsWith("165") && (ordinal === 3 || ordinal === 6)
                            ? [
                                start,
                                ...[
                                  ...waypoints,
                                  { lat: 51.04, lng: -0.5 },
                                  { lat: 51.04, lng: 0.5 },
                                  ...(activeFixture === "165-meaningful" && ordinal === 6
                                    ? [
                                        { lat: 50.6, lng: -0.4 },
                                        { lat: 50.6, lng: 0 },
                                        { lat: 50.6, lng: 0.4 },
                                      ]
                                    : []),
                                ].sort((a, b) => a.lng - b.lng),
                                end,
                              ]
                            : activeFixture.startsWith("recovery") && ordinal === 1
                              ? [start, waypoints[0], start, ...waypoints.slice(1), end]
                              : activeFixture.startsWith("recovery") && ordinal === 2
                                ? [
                                    start,
                                    { lat: 51, lng: -0.7 },
                                    { lat: 51, lng: -0.9 },
                                    ...waypoints,
                                    end,
                                  ]
                                : activeFixture === "30" && ordinal === 2
                                  ? [
                                      start,
                                      { lat: 51, lng: -0.7 },
                                      { lat: 51, lng: -0.9 },
                                      ...waypoints,
                                      end,
                                    ]
                                  : activeFixture.startsWith("recovery") && ordinal === 3
                                    ? [start, ...waypoints, waypoints[1] ?? waypoints[0], end]
                                    : activeFixture === "recovery-invalid" && ordinal === 4
                                      ? [start, waypoints[0], start, ...waypoints.slice(1), end]
                                      : activeFixture === "recovery-invalid" && ordinal === 5
                                        ? [
                                            start,
                                            { lat: 51, lng: -0.7 },
                                            { lat: 51, lng: -0.9 },
                                            ...waypoints,
                                            end,
                                          ]
                                        : (activeFixture === "180" &&
                                              ordinal === 3 &&
                                              waypoints.length >= 2) ||
                                            (activeFixture === "30" &&
                                              ordinal <= 2 &&
                                              waypoints.length >= 2)
                                          ? [
                                              start,
                                              waypoints[1],
                                              waypoints[0],
                                              ...waypoints.slice(2),
                                              end,
                                            ]
                                          : requestedPoints;
        const directions = computed(
          returnedPoints,
          fixtureBaselineDurationSeconds + addedSeconds,
          activeFixture.startsWith("165") ? 140_000 : 150_000 + ordinal * 10_000,
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
            attemptsPlanned: number;
            attemptsCompleted: number;
            processedTargetMinutes: number[];
            finalSelectionReason: string | null;
            candidateEligibility: Array<{
              candidateSource: string;
              intendedTargetMinutes: number | null;
              actualAddedMinutes: number | null;
              routeShapeEligible: boolean | null;
              routeShapeRejectionReason: string | null;
              affectedWaypointIndex: number | null;
              duplicateEligible: boolean | null;
              budgetEligible: boolean | null;
              effectiveWaypointCount: number | null;
              effectiveWaypointForm: string | null;
              effectiveProgress: string | null;
              effectiveOrientation: string | null;
              refinementAttemptNumber: number | null;
              refinementStrategy: string | null;
              selected: boolean;
              evidenceEligible: boolean | null;
              qualityEligible: boolean | null;
              preferredQualityEligible: boolean | null;
              timeCommitmentEligible: boolean | null;
              baselineScoreImprovement: number | null;
              provisionalTimeCommitmentCandidate: boolean | null;
              finalSelectionReason: string | null;
              scenicScore: number | null;
              evidenceMatchedToGeometry: number | null;
              evidenceMatchedThroughWaypoints: number | null;
            }>;
            durationRefinement: {
              providerRequestsStarted: number;
              stopReason: string;
            } | null;
            constructionRecovery: {
              attempted: boolean;
              seedsConsidered: number;
              safeConstructionsProduced: number;
              providerRequestsStarted: number;
              providerResponsesReturned: number;
              providerRequestsFailed: number;
              responsesEvaluated: number;
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

      activeFixture = "65-live";
      placesCalls = 0;
      scenicRouteCalls = 0;
      submittedWaypointCounts.length = 0;
      submittedShapingWaypoints.length = 0;
      returnedGeometryByDuration.clear();
      diagnosticLogs.length = 0;
      const liveSixtyFive = await (
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
          extra_minutes: 65,
          stops: ["Stop"],
        },
        context: { userId: "00000000-0000-4000-8000-000000000000", supabase: {} },
      });
      assert.deepEqual(
        liveSixtyFive.scoringDiagnostics.explorationTargets.flatMap(
          (stage: { targetExtraMinutes: number[] }) => stage.targetExtraMinutes,
        ),
        [30, 45, 60, 65],
      );
      assert.equal(
        liveSixtyFive.routeGenerationDiagnostics.durationRefinement?.providerRequestsStarted,
        1,
        JSON.stringify(liveSixtyFive.routeGenerationDiagnostics),
      );
      assert.equal(
        scenicRouteCalls,
        5,
        JSON.stringify({
          placesCalls,
          submittedWaypointCounts,
          diagnostics: liveSixtyFive.routeGenerationDiagnostics,
        }),
      );
      assert.equal(
        liveSixtyFive.measuredExtraTimeSeconds,
        59 * 60,
        JSON.stringify(liveSixtyFive.routeGenerationDiagnostics),
      );
      assert.equal(liveSixtyFive.timeTargetOutcome, "TARGET_MET");
      assert.equal(liveSixtyFive.routeGenerationDiagnostics.constructionRecovery ?? null, null);
      const sixtyFiveOrdinary =
        liveSixtyFive.routeGenerationDiagnostics.candidateEligibility.filter((candidate) =>
          [58.3, 41.1, 78.3, 183.1].includes(candidate.actualAddedMinutes ?? -1),
        );
      assert.deepEqual(
        sixtyFiveOrdinary.map((candidate) => ({
          added: candidate.actualAddedMinutes,
          shape: candidate.routeShapeEligible,
          reason: candidate.routeShapeRejectionReason,
          budget: candidate.budgetEligible,
          selected: candidate.selected,
          waypointCount: candidate.effectiveWaypointCount,
          form: candidate.effectiveWaypointForm,
          progress: candidate.effectiveProgress,
          orientation: candidate.effectiveOrientation,
        })),
        [
          {
            added: 58.3,
            shape: false,
            reason: "WAYPOINT_SPUR",
            budget: true,
            selected: false,
            waypointCount: 1,
            form: "one-waypoint",
            progress: "middle",
            orientation: "left",
          },
          {
            added: 41.1,
            shape: true,
            reason: null,
            budget: true,
            selected: false,
            waypointCount: 1,
            form: "one-waypoint",
            progress: "middle",
            orientation: "right",
          },
          {
            added: 78.3,
            shape: true,
            reason: null,
            budget: false,
            selected: false,
            waypointCount: 1,
            form: "one-waypoint",
            progress: "middle",
            orientation: "right",
          },
          {
            added: 183.1,
            shape: false,
            reason: "MATERIAL_REVERSE_RETRACE",
            budget: false,
            selected: false,
            waypointCount: 2,
            form: "two-waypoint-arc",
            progress: "distributed",
            orientation: "left",
          },
        ],
      );
      const sixtyFiveMeaningful = sixtyFiveOrdinary.find(
        (candidate) => candidate.actualAddedMinutes === 41.1,
      );
      const sixtyFiveUpper = sixtyFiveOrdinary.find(
        (candidate) => candidate.actualAddedMinutes === 78.3,
      );
      assert.equal(sixtyFiveMeaningful?.scenicScore, 60);
      assert.equal(sixtyFiveMeaningful?.evidenceEligible, true);
      assert.equal(sixtyFiveUpper?.scenicScore, 46);
      assert.equal(sixtyFiveUpper?.evidenceEligible, true);
      assert.equal(sixtyFiveUpper?.duplicateEligible, true);
      assert.equal(sixtyFiveUpper?.budgetEligible, false);
      const selectedSixtyFive = liveSixtyFive.routeGenerationDiagnostics.candidateEligibility.find(
        (candidate) => candidate.selected,
      );
      assert.ok(selectedSixtyFive);
      const selectedSixtyFiveRefinement = selectedSixtyFive as typeof selectedSixtyFive & {
        adaptiveTargetMinutes: number | null;
        refinementBracketLowerMinutes: number | null;
        refinementBracketUpperMinutes: number | null;
      };
      assert.equal(selectedSixtyFive.actualAddedMinutes, 59);
      assert.equal(selectedSixtyFive.intendedTargetMinutes, 58.5);
      assert.equal(selectedSixtyFiveRefinement.adaptiveTargetMinutes, 58.5);
      assert.equal(selectedSixtyFive.refinementStrategy, "BASELINE_ZERO_BRACKET");
      assert.equal(selectedSixtyFiveRefinement.refinementBracketLowerMinutes, 0);
      assert.equal(selectedSixtyFiveRefinement.refinementBracketUpperMinutes, 78.3);
      assert.equal(selectedSixtyFive.routeShapeEligible, true);
      assert.equal(selectedSixtyFive.duplicateEligible, true);
      assert.equal(selectedSixtyFive.evidenceEligible, true);
      assert.equal(selectedSixtyFive.qualityEligible, true);
      assert.equal(selectedSixtyFive.scenicScore, 73);
      assert.equal(selectedSixtyFive.evidenceMatchedToGeometry, 6);
      assert.equal(selectedSixtyFive.evidenceMatchedThroughWaypoints, 0);
      assert.equal(
        liveSixtyFive.directions.encodedPolyline,
        returnedGeometryByDuration.get(24_157 + 59 * 60),
      );
      assert.equal(diagnosticLogs.length, 1);
      const sixtyFiveSummary = JSON.parse(
        diagnosticLogs[0].slice("scenik-route-summary-v3 ".length),
      );
      assert.equal(sixtyFiveSummary.refinement.stopReason, "TARGET_REACHED");
      assert.equal(sixtyFiveSummary.selected.addedSeconds, 59 * 60);

      activeFixture = "recovery-65-live";
      placesCalls = 0;
      scenicRouteCalls = 0;
      recoveryBaselineReturned = false;
      submittedWaypointCounts.length = 0;
      submittedShapingWaypoints.length = 0;
      returnedGeometryByDuration.clear();
      diagnosticLogs.length = 0;
      const recoveredSixtyFive = await (
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
          extra_minutes: 65,
          stops: ["Stop"],
        },
        context: { userId: "00000000-0000-4000-8000-000000000000", supabase: {} },
      });
      assert.equal(
        scenicRouteCalls,
        6,
        JSON.stringify(recoveredSixtyFive.routeGenerationDiagnostics),
      );
      assert.ok(
        recoveredSixtyFive.routeGenerationDiagnostics.constructionRecovery,
        JSON.stringify(recoveredSixtyFive.routeGenerationDiagnostics),
      );
      assert.deepEqual(
        recoveredSixtyFive.routeGenerationDiagnostics.constructionRecovery,
        {
          attempted: true,
          seedsConsidered: 4,
          safeConstructionsProduced: 2,
          providerRequestsStarted: 2,
          providerResponsesReturned: 2,
          providerRequestsFailed: 0,
          responsesEvaluated: 2,
          stopReason: "TARGET_REACHED",
        },
        JSON.stringify(recoveredSixtyFive.routeGenerationDiagnostics),
      );
      assert.equal(
        recoveredSixtyFive.routeGenerationDiagnostics.durationRefinement?.providerRequestsStarted ??
          0,
        0,
      );
      const firstRecovery = recoveredSixtyFive.routeGenerationDiagnostics.candidateEligibility.find(
        (candidate) => candidate.actualAddedMinutes === 10.3,
      );
      assert.ok(firstRecovery);
      assert.equal(firstRecovery.routeShapeEligible, true);
      assert.equal(firstRecovery.selected, false);
      assert.equal(firstRecovery.preferredQualityEligible, false);
      assert.equal(firstRecovery.timeCommitmentEligible, false);
      assert.ok((firstRecovery.allowanceUtilisation ?? 1) < 0.35);
      assert.ok((firstRecovery.scenicScore ?? 60) < 60);
      const secondRecovery =
        recoveredSixtyFive.routeGenerationDiagnostics.candidateEligibility.find(
          (candidate) => candidate.actualAddedMinutes === 59,
        );
      assert.ok(secondRecovery);
      assert.equal(secondRecovery.candidateId, "construction-recovery-6");
      assert.equal(secondRecovery.selected, true);
      assert.equal(secondRecovery.routeShapeEligible, true);
      assert.equal(secondRecovery.duplicateEligible, true);
      assert.equal(secondRecovery.budgetEligible, true);
      assert.equal(secondRecovery.evidenceEligible, true);
      assert.equal(secondRecovery.evidenceMatchedToGeometry, 7);
      assert.equal(secondRecovery.evidenceMatchedThroughWaypoints, 0);
      assert.equal(secondRecovery.scenicScore, 77);
      assert.equal(
        secondRecovery.qualityEligible,
        true,
        JSON.stringify(recoveredSixtyFive.routeGenerationDiagnostics),
      );
      assert.equal(recoveredSixtyFive.timeTargetOutcome, "TARGET_MET");
      assert.equal(recoveredSixtyFive.measuredExtraTimeSeconds, 59 * 60);
      assert.equal(
        recoveredSixtyFive.directions.encodedPolyline,
        returnedGeometryByDuration.get(24_762 + 59 * 60),
      );

      activeFixture = "165";
      placesCalls = 0;
      scenicRouteCalls = 0;
      submittedWaypointCounts.length = 0;
      submittedShapingWaypoints.length = 0;
      returnedGeometryByDuration.clear();
      diagnosticLogs.length = 0;
      const commitment = await (
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
          theme: "Wildlife",
          extra_minutes: 165,
          stops: ["Stop"],
        },
        context: { userId: "00000000-0000-4000-8000-000000000000", supabase: {} },
      });
      assert.deepEqual(
        commitment.scoringDiagnostics.explorationTargets.flatMap(
          (stage: { targetExtraMinutes: number[] }) => stage.targetExtraMinutes,
        ),
        [30, 60, 70, 125, 150],
      );
      assert.deepEqual(
        commitment.routeGenerationDiagnostics.processedTargetMinutes,
        [30, 60, 70, 125, 150],
      );
      assert.equal(commitment.routeGenerationDiagnostics.attemptsPlanned, 5);
      assert.equal(commitment.routeGenerationDiagnostics.attemptsCompleted, 5);
      assert.equal(scenicRouteCalls, 5);
      assert.equal(commitment.scoringDiagnostics.scenicRouteRequestsAttempted, 5);
      assert.ok(placesCalls <= 15);
      const commitmentCandidate = commitment.routeGenerationDiagnostics.candidateEligibility.find(
        (candidate) => candidate.actualAddedMinutes === 135,
      );
      assert.ok(commitmentCandidate);
      assert.equal(commitmentCandidate.routeShapeEligible, true);
      assert.equal(commitmentCandidate.duplicateEligible, true);
      assert.equal(commitmentCandidate.budgetEligible, true);
      assert.equal(commitmentCandidate.evidenceEligible, true);
      assert.equal(commitmentCandidate.preferredQualityEligible, false);
      assert.equal(commitmentCandidate.timeCommitmentEligible, true);
      assert.equal(commitmentCandidate.provisionalTimeCommitmentCandidate, true);
      assert.equal(commitmentCandidate.selected, true);
      assert.equal(commitmentCandidate.finalSelectionReason, "TIME_COMMITMENT_TARGET_FALLBACK");
      assert.equal(commitmentCandidate.scenicScore, 50);
      assert.equal(commitmentCandidate.baselineScoreImprovement, 19);
      assert.equal(commitment.selectedWinner, "scenik");
      assert.equal(commitment.scenic_score, 50);
      assert.equal(commitment.measuredExtraTimeSeconds, 135 * 60);
      assert.equal(commitment.measuredExtraTimeSeconds / (165 * 60), 135 / 165);
      assert.equal(commitment.timeTargetOutcome, "TIME_COMMITMENT_TARGET_FALLBACK");
      assert.equal(commitment.directions.durationSeconds, commitment.selectedRouteDurationSeconds);
      assert.equal(
        returnedGeometryByDuration.get(commitment.selectedRouteDurationSeconds),
        commitment.directions.encodedPolyline,
      );
      assert.deepEqual(
        timeBudgetExplanation(
          commitment.measuredExtraTimeSeconds,
          165,
          true,
          "TIME_COMMITMENT_TARGET_FALLBACK",
        ),
        {
          usedMinutes: 135,
          allowanceMinutes: 165,
          utilisation: 135 / 165,
          explanation: "Your larger allowance unlocked this route.",
        },
      );
      assert.equal(diagnosticLogs.length, 1);
      const commitmentSummary = JSON.parse(
        diagnosticLogs[0].slice("scenik-route-summary-v3 ".length),
      );
      assert.deepEqual(commitmentSummary.plannedTargets, [30, 60, 70, 125, 150]);
      assert.deepEqual(commitmentSummary.processedTargets, [30, 60, 70, 125, 150]);
      assert.equal(commitmentSummary.selected.band, "target");

      activeFixture = "165-meaningful";
      placesCalls = 0;
      scenicRouteCalls = 0;
      submittedWaypointCounts.length = 0;
      submittedShapingWaypoints.length = 0;
      returnedGeometryByDuration.clear();
      diagnosticLogs.length = 0;
      const refinedCommitment = await (
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
          theme: "Wildlife",
          extra_minutes: 165,
          stops: ["Stop"],
        },
        context: { userId: "00000000-0000-4000-8000-000000000000", supabase: {} },
      });
      assert.equal(
        scenicRouteCalls,
        6,
        JSON.stringify(refinedCommitment.routeGenerationDiagnostics),
      );
      assert.equal(refinedCommitment.scoringDiagnostics.scenicRouteRequestsAttempted, 6);
      assert.equal(
        refinedCommitment.routeGenerationDiagnostics.durationRefinement?.providerRequestsStarted,
        1,
      );
      assert.equal(
        refinedCommitment.measuredExtraTimeSeconds,
        135 * 60,
        JSON.stringify(refinedCommitment.routeGenerationDiagnostics),
      );
      assert.equal(refinedCommitment.timeTargetOutcome, "TIME_COMMITMENT_TARGET_FALLBACK");

      activeFixture = "30";
      placesCalls = 0;
      scenicRouteCalls = 0;
      submittedWaypointCounts.length = 0;
      submittedShapingWaypoints.length = 0;
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
      const ordinaryLiveResults = downward.routeGenerationDiagnostics.candidateEligibility
        .filter((candidate) => [32.9, 31.9, 69.9].includes(candidate.actualAddedMinutes ?? -1))
        .map((candidate) => ({
          added: candidate.actualAddedMinutes,
          budgetEligible: candidate.budgetEligible,
          routeShapeEligible: candidate.routeShapeEligible,
          routeShapeRejectionReason: candidate.routeShapeRejectionReason,
          duplicateEligible: candidate.duplicateEligible,
          selected: candidate.selected,
        }));
      assert.deepEqual(ordinaryLiveResults, [
        {
          added: 32.9,
          budgetEligible: false,
          routeShapeEligible: false,
          routeShapeRejectionReason: "WAYPOINT_SPUR",
          duplicateEligible: true,
          selected: false,
        },
        {
          added: 31.9,
          budgetEligible: false,
          routeShapeEligible: false,
          routeShapeRejectionReason: "MATERIAL_REVERSE_RETRACE",
          duplicateEligible: true,
          selected: false,
        },
        {
          added: 69.9,
          budgetEligible: false,
          routeShapeEligible: true,
          routeShapeRejectionReason: null,
          duplicateEligible: true,
          selected: false,
        },
      ]);
      const liveStyleSafeUpper = downward.routeGenerationDiagnostics.candidateEligibility.find(
        (candidate) =>
          candidate.intendedTargetMinutes === 27 && candidate.actualAddedMinutes === 69.9,
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
      assert.equal(downward.routeGenerationDiagnostics.constructionRecovery ?? null, null);

      activeFixture = "30-live";
      placesCalls = 0;
      scenicRouteCalls = 0;
      submittedWaypointCounts.length = 0;
      submittedShapingWaypoints.length = 0;
      returnedGeometryByDuration.clear();
      diagnosticLogs.length = 0;
      const liveThirty = await (
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
          stops: [],
        },
        context: { userId: "00000000-0000-4000-8000-000000000000", supabase: {} },
      });
      assert.equal(
        liveThirty.routeGenerationDiagnostics.durationRefinement?.providerRequestsStarted,
        1,
        JSON.stringify(liveThirty.routeGenerationDiagnostics),
      );
      assert.equal(
        liveThirty.measuredExtraTimeSeconds,
        27 * 60,
        JSON.stringify(liveThirty.routeGenerationDiagnostics),
      );
      assert.equal(
        liveThirty.timeTargetOutcome,
        "TIME_COMMITMENT_TARGET_FALLBACK",
        JSON.stringify(liveThirty.routeGenerationDiagnostics),
      );
      assert.equal(scenicRouteCalls, 4);
      const liveThirtyOrdinary = liveThirty.routeGenerationDiagnostics.candidateEligibility.filter(
        (candidate) => [20.2, 59.9, 96.4].includes(candidate.actualAddedMinutes ?? -1),
      );
      assert.deepEqual(
        liveThirtyOrdinary.map((candidate) => ({
          added: candidate.actualAddedMinutes,
          shape: candidate.routeShapeEligible,
          reason: candidate.routeShapeRejectionReason,
          affected: candidate.affectedWaypointIndex,
          waypointCount: candidate.effectiveWaypointCount,
          budget: candidate.budgetEligible,
          selected: candidate.selected,
        })),
        [
          {
            added: 20.2,
            shape: true,
            reason: null,
            affected: null,
            waypointCount: 1,
            budget: true,
            selected: false,
          },
          {
            added: 59.9,
            shape: false,
            reason: "WAYPOINT_SPUR",
            affected: 0,
            waypointCount: 1,
            budget: false,
            selected: false,
          },
          {
            added: 96.4,
            shape: true,
            reason: null,
            affected: null,
            waypointCount: 2,
            budget: false,
            selected: false,
          },
        ],
      );
      assert.equal(
        liveThirty.routeGenerationDiagnostics.candidateEligibility.find(
          (candidate) => candidate.candidateSource === "fastest",
        )?.scenicScore,
        31,
      );
      assert.equal(
        liveThirtyOrdinary.find((candidate) => candidate.actualAddedMinutes === 20.2)?.scenicScore,
        44,
      );
      const liveThirtyRefinement = liveThirty.routeGenerationDiagnostics.candidateEligibility.find(
        (candidate) => candidate.refinementAttemptNumber != null,
      );
      assert.ok(liveThirtyRefinement);
      assert.equal(liveThirtyRefinement.actualAddedMinutes, 27);
      assert.equal(liveThirtyRefinement.duplicateEligible, true);
      assert.equal(liveThirtyRefinement.evidenceEligible, true);
      assert.equal(liveThirtyRefinement.timeCommitmentEligible, true);
      assert.equal(liveThirtyRefinement.selected, true);
      assert.equal(liveThirty.routeGenerationDiagnostics.constructionRecovery ?? null, null);

      activeFixture = "30-live-familyless";
      // At this valid near-pole corridor, submitted-plan validation and spherical
      // effective/recovery metadata remain available, while the Production family
      // factory's planar projection fails closed below its longitude-scale floor.
      placesCalls = 0;
      scenicRouteCalls = 0;
      submittedWaypointCounts.length = 0;
      submittedShapingWaypoints.length = 0;
      returnedGeometryByDuration.clear();
      diagnosticLogs.length = 0;
      const familylessLiveThirty = await (
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
      assert.equal(
        familylessLiveThirty.routeGenerationDiagnostics.durationRefinement?.providerRequestsStarted,
        0,
      );
      assert.equal(
        familylessLiveThirty.routeGenerationDiagnostics.durationRefinement?.stopReason,
        "NO_RELATED_PLAN_FAMILY",
      );
      assert.deepEqual(familylessLiveThirty.routeGenerationDiagnostics.constructionRecovery, {
        attempted: true,
        seedsConsidered: 1,
        safeConstructionsProduced: 1,
        providerRequestsStarted: 1,
        providerResponsesReturned: 1,
        providerRequestsFailed: 0,
        responsesEvaluated: 1,
        stopReason: "TARGET_REACHED",
      });
      assert.equal(scenicRouteCalls, 4);
      assert.equal(familylessLiveThirty.measuredExtraTimeSeconds, 27 * 60);
      assert.equal(familylessLiveThirty.timeTargetOutcome, "TIME_COMMITMENT_TARGET_FALLBACK");
      const recoveredCandidate =
        familylessLiveThirty.routeGenerationDiagnostics.candidateEligibility.find(
          (candidate) => candidate.actualAddedMinutes === 27,
        );
      assert.ok(recoveredCandidate);
      assert.equal(recoveredCandidate.routeShapeEligible, true);
      assert.equal(recoveredCandidate.duplicateEligible, true);
      assert.equal(recoveredCandidate.evidenceEligible, true);
      assert.equal(recoveredCandidate.budgetEligible, true);
      assert.equal(recoveredCandidate.selected, true);

      activeFixture = "invalid-index-spur";
      placesCalls = 0;
      scenicRouteCalls = 0;
      submittedWaypointCounts.length = 0;
      submittedShapingWaypoints.length = 0;
      returnedGeometryByDuration.clear();
      diagnosticLogs.length = 0;
      const invalidIndexSpur = await (
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
      assert.equal(
        scenicRouteCalls,
        3,
        JSON.stringify(invalidIndexSpur.routeGenerationDiagnostics),
      );
      assert.equal(invalidIndexSpur.scoringDiagnostics.scenicRouteRequestsAttempted, 3);
      assert.equal(invalidIndexSpur.selectedWinner, "fastest");
      assert.deepEqual(invalidIndexSpur.routeGenerationDiagnostics.constructionRecovery, {
        attempted: false,
        seedsConsidered: 0,
        safeConstructionsProduced: 0,
        providerRequestsStarted: 0,
        providerResponsesReturned: 0,
        providerRequestsFailed: 0,
        responsesEvaluated: 0,
        stopReason: "NO_RECOVERABLE_SHAPE_SEED",
      });
      assert.equal(
        invalidIndexSpur.routeGenerationDiagnostics.durationRefinement?.providerRequestsStarted,
        0,
      );
      const invalidSpurs = invalidIndexSpur.routeGenerationDiagnostics.candidateEligibility.filter(
        (candidate) => candidate.routeShapeRejectionReason === "WAYPOINT_SPUR",
      );
      assert.equal(invalidSpurs.length, 3);
      assert.equal(
        invalidSpurs.every((candidate) => !candidate.selected),
        true,
      );
      assert.equal(
        invalidSpurs.every(
          (candidate) => candidate.affectedWaypointIndex === candidate.effectiveWaypointCount,
        ),
        true,
      );

      activeFixture = "recovery";
      placesCalls = 0;
      scenicRouteCalls = 0;
      submittedWaypointCounts.length = 0;
      submittedShapingWaypoints.length = 0;
      returnedGeometryByDuration.clear();
      diagnosticLogs.length = 0;
      const recovered = await (
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
      assert.equal(scenicRouteCalls, 4);
      assert.ok(placesCalls <= 15);
      assert.equal(recovered.scoringDiagnostics.scenicRouteRequestsAttempted, 4);
      assert.equal(recovered.selectedWinner, "scenik");
      assert.equal(recovered.timeTargetOutcome, "TARGET_MET");
      assert.equal(recovered.measuredExtraTimeSeconds, 27 * 60);
      assert.deepEqual(
        recovered.routeGenerationDiagnostics.candidateEligibility
          .filter((candidate) => [40, 55.9, 91].includes(candidate.actualAddedMinutes ?? -1))
          .map((candidate) => ({
            added: candidate.actualAddedMinutes,
            eligible: candidate.routeShapeEligible,
            reason: candidate.routeShapeRejectionReason,
            selected: candidate.selected,
            scenicScore: candidate.scenicScore,
            evidenceEligible: candidate.evidenceEligible,
            completeEffectiveMetadata:
              candidate.effectiveWaypointForm != null &&
              candidate.effectiveProgress != null &&
              candidate.effectiveOrientation != null,
          })),
        [
          {
            added: 40,
            eligible: false,
            reason: "WAYPOINT_SPUR",
            selected: false,
            scenicScore: null,
            evidenceEligible: false,
            completeEffectiveMetadata: true,
          },
          {
            added: 55.9,
            eligible: false,
            reason: "MATERIAL_REVERSE_RETRACE",
            selected: false,
            scenicScore: null,
            evidenceEligible: false,
            completeEffectiveMetadata: true,
          },
          {
            added: 91,
            eligible: false,
            reason: "WAYPOINT_SPUR",
            selected: false,
            scenicScore: null,
            evidenceEligible: false,
            completeEffectiveMetadata: true,
          },
        ],
      );
      const selectedRecovery = recovered.routeGenerationDiagnostics.candidateEligibility.find(
        (candidate) => candidate.selected && candidate.actualAddedMinutes === 27,
      );
      assert.ok(selectedRecovery);
      assert.equal(selectedRecovery.routeShapeEligible, true);
      assert.equal(selectedRecovery.duplicateEligible, true);
      assert.equal(selectedRecovery.budgetEligible, true);
      assert.equal(selectedRecovery.evidenceEligible, true);
      assert.equal(selectedRecovery.qualityEligible, true);
      assert.equal(Number.isFinite(selectedRecovery.scenicScore), true);
      assert.ok((selectedRecovery.scenicScore ?? 0) >= 60);
      assert.equal(
        recovered.measuredExtraTimeSeconds,
        recovered.selectedRouteDurationSeconds - recovered.fastestRouteDurationSeconds,
      );
      assert.equal(recovered.measuredExtraTimeSeconds / (30 * 60), 0.9);
      assert.deepEqual(recovered.routeGenerationDiagnostics.constructionRecovery, {
        attempted: true,
        seedsConsidered: 3,
        safeConstructionsProduced: 1,
        providerRequestsStarted: 1,
        providerResponsesReturned: 1,
        providerRequestsFailed: 0,
        responsesEvaluated: 1,
        stopReason: "TARGET_REACHED",
      });
      assert.equal(diagnosticLogs.length, 1);
      const recoverySummary = JSON.parse(
        diagnosticLogs[0].slice("scenik-route-summary-v3 ".length),
      );
      assert.deepEqual(
        recoverySummary.recovery,
        recovered.routeGenerationDiagnostics.constructionRecovery,
      );
      assert.equal(recoverySummary.selected.band, "target");

      const runRecoveryVariantPlan = planScenicRoute as unknown as (input: {
        data: {
          start_address: string;
          end_address: string;
          mood: string;
          theme: string;
          extra_minutes: number;
          stops: string[];
        };
        context: { userId: string; supabase: object };
      }) => Promise<typeof result>;
      const runRecoveryVariant = async (
        fixture:
          | "recovery-over"
          | "recovery-under"
          | "recovery-invalid"
          | "recovery-provider-failure",
      ) => {
        activeFixture = fixture;
        placesCalls = 0;
        scenicRouteCalls = 0;
        submittedWaypointCounts.length = 0;
        submittedShapingWaypoints.length = 0;
        returnedGeometryByDuration.clear();
        diagnosticLogs.length = 0;
        return (planScenicRoute as unknown as typeof runRecoveryVariantPlan)({
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
      };
      const safeOver = await runRecoveryVariant("recovery-over");
      assert.equal(scenicRouteCalls, 5);
      assert.equal(safeOver.measuredExtraTimeSeconds, 27 * 60);
      assert.equal(
        safeOver.routeGenerationDiagnostics.constructionRecovery?.stopReason,
        "SAFE_RESPONSE_DEFERRED_TO_REFINEMENT",
      );
      assert.equal(
        safeOver.routeGenerationDiagnostics.durationRefinement?.stopReason,
        "TARGET_REACHED",
      );

      const safeUnder = await runRecoveryVariant("recovery-under");
      assert.equal(scenicRouteCalls, 5);
      assert.equal(safeUnder.measuredExtraTimeSeconds, 27 * 60);
      assert.equal(
        safeUnder.routeGenerationDiagnostics.constructionRecovery?.stopReason,
        "RECOVERY_RESPONSE_RECORDED",
      );
      assert.equal(
        safeUnder.routeGenerationDiagnostics.durationRefinement?.stopReason,
        "TARGET_REACHED",
      );

      const invalidRecovery = await runRecoveryVariant("recovery-invalid");
      assert.equal(scenicRouteCalls, 5);
      assert.equal(invalidRecovery.selectedWinner, "fastest");
      assert.equal(
        invalidRecovery.routeGenerationDiagnostics.constructionRecovery?.stopReason,
        "RECOVERY_SHAPE_REJECTED",
      );
      const invalidRecoveryReasons = invalidRecovery.routeGenerationDiagnostics.candidateEligibility
        .filter((candidate) => [45, 27].includes(candidate.actualAddedMinutes ?? -1))
        .map((candidate) => candidate.routeShapeRejectionReason);
      assert.equal(invalidRecoveryReasons.includes("WAYPOINT_SPUR"), true);
      assert.equal(invalidRecoveryReasons.includes("MATERIAL_REVERSE_RETRACE"), true);
      const { sphericalPointToSegmentDistanceMeters } =
        await import("./route-evidence-association");
      const firstRecoveryWaypoint = submittedShapingWaypoints[3]?.[0];
      const secondRecoveryWaypoint = submittedShapingWaypoints[4]?.[0];
      assert.ok(firstRecoveryWaypoint);
      assert.ok(secondRecoveryWaypoint);
      const firstRecoveryOffset = sphericalPointToSegmentDistanceMeters(
        firstRecoveryWaypoint,
        start,
        requiredStop,
      );
      const secondRecoveryOffset = sphericalPointToSegmentDistanceMeters(
        secondRecoveryWaypoint,
        start,
        requiredStop,
      );
      assert.ok(
        Math.abs(secondRecoveryOffset / firstRecoveryOffset - (27 / 45) * 0.92 * 0.75) < 0.01,
      );

      const providerFailure = await runRecoveryVariant("recovery-provider-failure");
      assert.equal(scenicRouteCalls, 4);
      assert.equal(providerFailure.selectedWinner, "fastest");
      assert.deepEqual(providerFailure.routeGenerationDiagnostics.constructionRecovery, {
        attempted: true,
        seedsConsidered: 3,
        safeConstructionsProduced: 1,
        providerRequestsStarted: 1,
        providerResponsesReturned: 0,
        providerRequestsFailed: 1,
        responsesEvaluated: 0,
        stopReason: "PROVIDER_REQUEST_FAILED",
      });
    } finally {
      console.info = originalInfo;
      mock.restore();
    }
  });
});
