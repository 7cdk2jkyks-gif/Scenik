import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DERIVED_MOVEMENT_NUMERICAL_EPSILON_METERS,
  MAX_SCENIC_ROUTE_ATTEMPTS,
  MAX_DERIVED_WAYPOINT_DISPLACEMENT_FROM_SOURCE_METERS,
  createRequestLocalPlanFamily,
  deriveRouteShapingPlan,
  executeDerivedRouteRequest,
  isSafeRefinementCorridorPlan,
  orchestrateDurationRefinement,
  planFamilyStructuralKey,
  recordRefinedProviderCandidate,
  runBoundedDurationRefinement,
  scoreAndSelectRouteCandidateCollection,
  type DurationConstructionObservation,
  type RouteCandidateForFinalScoring,
} from "./route-duration-refinement";
import { haversineDistanceMeters } from "./scenic-waypoint";
import { selectRouteCandidate } from "./route-selection";
import type { ComputedDirections } from "./google-maps.server";

function encode(points: Array<{ lat: number; lng: number }>): string {
  let priorLat = 0;
  let priorLng = 0;
  const encodeDelta = (delta: number) => {
    let encoded = "";
    let shifted = delta < 0 ? ~(delta << 1) : delta << 1;
    while (shifted >= 0x20) {
      encoded += String.fromCharCode((0x20 | (shifted & 0x1f)) + 63);
      shifted >>= 5;
    }
    return encoded + String.fromCharCode(shifted + 63);
  };
  return points
    .map((point) => {
      const lat = Math.round(point.lat * 1e5);
      const lng = Math.round(point.lng * 1e5);
      const value = encodeDelta(lat - priorLat) + encodeDelta(lng - priorLng);
      priorLat = lat;
      priorLng = lng;
      return value;
    })
    .join("");
}

function computed(
  points: Array<{ lat: number; lng: number }>,
  durationSeconds: number,
  distanceMeters: number,
): ComputedDirections {
  return {
    encodedPolyline: encode(points),
    durationSeconds,
    distanceMeters,
    duration: `${Math.round(durationSeconds / 60)} min`,
    distance: `${distanceMeters} m`,
    steps: points.slice(1).map((point, index) => ({
      instruction: index % 2 ? "Turn right" : "Continue",
      maneuver: index % 2 ? "turn-right" : "straight",
      distance: "",
      duration: "",
      distanceMeters: Math.round(distanceMeters / (points.length - 1)),
      durationSeconds: Math.round(durationSeconds / (points.length - 1)),
      endLat: point.lat,
      endLng: point.lng,
    })),
  };
}

function observation(
  candidateId: string,
  actualAddedMinutes: number,
  constructionValue: number,
  overrides: Partial<DurationConstructionObservation> = {},
): DurationConstructionObservation {
  return {
    candidateId,
    relatedPlanKey: "forest:1",
    actualAddedMinutes,
    constructionValue,
    withinBudget: actualAddedMinutes <= 30,
    routeShapeEligible: true,
    duplicate: false,
    qualityEligible: true,
    ...overrides,
  };
}

function evaluated(value: DurationConstructionObservation) {
  return { status: "PROVIDER_RESPONSE_EVALUATED" as const, observation: value };
}

const productionGap = [
  observation("scenic-stage-5", 18.1, 18_000),
  observation("scenic-stage-6", 12.6, 13_000),
  observation("scenic-stage-7", 13.3, 14_000),
  observation("scenic-stage-4", 41.4, 42_000),
];

describe("bounded duration refinement", () => {
  const sourcePlan = {
    kind: "forest" as const,
    reason: "Forest corridor",
    estimatedDetourMeters: 1_113,
    signature: "provider-place-secret",
    waypoints: [
      {
        id: "provider-place-secret",
        lat: 0.01,
        lng: 0.5,
        primaryType: "woods",
        types: ["woods"],
        reason: "Woodland",
        insertionIndex: 0,
        estimatedDetourMeters: 1_113,
      },
    ],
  };

  function family(overrides: Partial<Parameters<typeof createRequestLocalPlanFamily>[0]> = {}) {
    return createRequestLocalPlanFamily({
      familyId: "family-1",
      origin: { lat: 0, lng: 0 },
      destination: { lat: 0, lng: 1 },
      requiredStops: [],
      anchors: [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 1 },
      ],
      sourceWaypointIds: ["evidence-1"],
      plan: sourcePlan,
      ...overrides,
    });
  }

  it("derives a monotonic same-side shaping coordinate without changing verified lineage", () => {
    const exactFamily = family();
    assert.ok(exactFamily);
    const target = exactFamily.currentDisplacementMeters + 1_000;
    const derived = deriveRouteShapingPlan(exactFamily, target);
    assert.ok(derived);
    assert.equal(derived.waypoints.length, 1);
    assert.equal(derived.waypoints[0].id, sourcePlan.waypoints[0].id);
    assert.equal(derived.waypoints[0].insertionIndex, 0);
    assert.ok(derived.waypoints[0].lat > sourcePlan.waypoints[0].lat);
    assert.notEqual(derived.waypoints[0].lat, sourcePlan.waypoints[0].lat);
    assert.equal(exactFamily.sourcePlan.waypoints[0].lat, sourcePlan.waypoints[0].lat);
    const next = deriveRouteShapingPlan(
      { ...exactFamily, currentDisplacementMeters: target },
      target + 500,
    );
    assert.ok(next);
    assert.ok(next.waypoints[0].lat > derived.waypoints[0].lat);
    assert.ok(
      haversineDistanceMeters(sourcePlan.waypoints[0], next.waypoints[0]) <=
        MAX_DERIVED_WAYPOINT_DISPLACEMENT_FROM_SOURCE_METERS +
          DERIVED_MOVEMENT_NUMERICAL_EPSILON_METERS,
    );
  });

  it("enforces the physical displacement cap exactly and fails beyond it", () => {
    const exactFamily = family();
    assert.ok(exactFamily);
    const atCap = deriveRouteShapingPlan(
      exactFamily,
      exactFamily.currentDisplacementMeters + MAX_DERIVED_WAYPOINT_DISPLACEMENT_FROM_SOURCE_METERS,
    );
    assert.ok(atCap);
    assert.ok(
      haversineDistanceMeters(sourcePlan.waypoints[0], atCap.waypoints[0]) <=
        MAX_DERIVED_WAYPOINT_DISPLACEMENT_FROM_SOURCE_METERS +
          DERIVED_MOVEMENT_NUMERICAL_EPSILON_METERS,
    );
    assert.equal(
      deriveRouteShapingPlan(
        exactFamily,
        exactFamily.currentDisplacementMeters +
          MAX_DERIVED_WAYPOINT_DISPLACEMENT_FROM_SOURCE_METERS +
          1,
      ),
      null,
    );
  });

  it("rejects projection-safe movement whose physical distance exceeds 2,500 metres", () => {
    const southernPlan = {
      ...sourcePlan,
      waypoints: [{ ...sourcePlan.waypoints[0], lat: -76.5, lng: 2.5 }],
    };
    const southern = family({
      origin: { lat: -75, lng: 0 },
      destination: { lat: -80, lng: 5 },
      anchors: [
        { lat: -75, lng: 0 },
        { lat: -80, lng: 5 },
      ],
      plan: southernPlan,
    });
    assert.ok(southern);
    assert.equal(
      deriveRouteShapingPlan(
        southern,
        southern.currentDisplacementMeters + MAX_DERIVED_WAYPOINT_DISPLACEMENT_FROM_SOURCE_METERS,
      ),
      null,
    );
    let lower = 1;
    let upper = MAX_DERIVED_WAYPOINT_DISPLACEMENT_FROM_SOURCE_METERS;
    let accepted = deriveRouteShapingPlan(southern, southern.currentDisplacementMeters + lower);
    for (let iteration = 0; iteration < 60; iteration += 1) {
      const midpoint = (lower + upper) / 2;
      const candidate = deriveRouteShapingPlan(
        southern,
        southern.currentDisplacementMeters + midpoint,
      );
      if (candidate) {
        lower = midpoint;
        accepted = candidate;
      } else {
        upper = midpoint;
      }
    }
    assert.ok(accepted);
    const acceptedDistance = haversineDistanceMeters(
      southern.sourcePlan.waypoints[0],
      accepted.waypoints[0],
    );
    assert.ok(acceptedDistance >= 2_499.999);
    assert.ok(
      acceptedDistance <=
        MAX_DERIVED_WAYPOINT_DISPLACEMENT_FROM_SOURCE_METERS +
          DERIVED_MOVEMENT_NUMERICAL_EPSILON_METERS,
    );
    assert.equal(
      deriveRouteShapingPlan(southern, southern.currentDisplacementMeters + upper),
      null,
    );
  });

  it("keeps structural lineage ordered and rejects malformed or unrelated families", () => {
    const base = {
      origin: { lat: 0, lng: 0 },
      destination: { lat: 0, lng: 1 },
      requiredStops: [
        { lat: 0, lng: 0.25 },
        { lat: 0, lng: 0.75 },
      ],
      sourceWaypointIds: ["evidence-1", "evidence-2"],
      plan: {
        ...sourcePlan,
        waypoints: [
          sourcePlan.waypoints[0],
          { ...sourcePlan.waypoints[0], id: "other", lng: 0.7, insertionIndex: 1 },
        ],
      },
    };
    const key = planFamilyStructuralKey(base);
    assert.ok(key);
    assert.notEqual(
      key,
      planFamilyStructuralKey({ ...base, sourceWaypointIds: ["evidence-2", "evidence-1"] }),
    );
    assert.notEqual(
      key,
      planFamilyStructuralKey({ ...base, requiredStops: [...base.requiredStops].reverse() }),
    );
    assert.notEqual(key, planFamilyStructuralKey({ ...base, origin: { lat: 0.1, lng: 0 } }));
    assert.notEqual(key, planFamilyStructuralKey({ ...base, destination: { lat: 0.1, lng: 1 } }));
    assert.equal(
      planFamilyStructuralKey({ ...base, sourceWaypointIds: ["evidence-1", "evidence-1"] }),
      null,
    );
  });

  it("fails closed for ambiguous, polar, invalid and topology-crossing derivations", () => {
    assert.equal(
      family({ plan: { ...sourcePlan, waypoints: [{ ...sourcePlan.waypoints[0], lat: 0 }] } }),
      null,
    );
    assert.equal(
      family({
        origin: { lat: 89.9999, lng: 0 },
        destination: { lat: 89.9999, lng: 1 },
        anchors: [
          { lat: 89.9999, lng: 0 },
          { lat: 89.9999, lng: 1 },
        ],
        plan: { ...sourcePlan, waypoints: [{ ...sourcePlan.waypoints[0], lat: 89.9998 }] },
      }),
      null,
    );
    assert.equal(family({ destination: { lat: Number.NaN, lng: 1 } }), null);
    assert.equal(
      family({ plan: { ...sourcePlan, waypoints: [{ ...sourcePlan.waypoints[0], lng: 0.01 }] } }),
      null,
    );
  });

  it("derives safely across the dateline and normalises longitude", () => {
    const dateline = family({
      origin: { lat: 10, lng: 179.5 },
      destination: { lat: 10, lng: -179.5 },
      anchors: [
        { lat: 10, lng: 179.5 },
        { lat: 10, lng: -179.5 },
      ],
      plan: {
        ...sourcePlan,
        waypoints: [{ ...sourcePlan.waypoints[0], lat: 10.01, lng: 179.9 }],
      },
    });
    assert.ok(dateline);
    const derived = deriveRouteShapingPlan(dateline, dateline.currentDisplacementMeters + 500);
    assert.ok(derived);
    assert.ok(derived.waypoints[0].lng >= -180 && derived.waypoints[0].lng <= 180);

    const westbound = family({
      origin: { lat: 10, lng: -179.5 },
      destination: { lat: 10, lng: 179.5 },
      anchors: [
        { lat: 10, lng: -179.5 },
        { lat: 10, lng: 179.5 },
      ],
      plan: {
        ...sourcePlan,
        waypoints: [{ ...sourcePlan.waypoints[0], lat: 10.01, lng: -179.9 }],
      },
    });
    assert.ok(westbound);
    const westboundDerived = deriveRouteShapingPlan(
      westbound,
      westbound.currentDisplacementMeters + 500,
    );
    assert.ok(westboundDerived);
    assert.ok(
      westboundDerived.waypoints[0].lng >= -180 && westboundDerived.waypoints[0].lng <= 180,
    );
  });

  it("supports bounded northern and southern high-latitude derivation", () => {
    for (const latitude of [65, -65]) {
      const highLatitude = family({
        origin: { lat: latitude, lng: 0 },
        destination: { lat: latitude, lng: 2 },
        anchors: [
          { lat: latitude, lng: 0 },
          { lat: latitude, lng: 2 },
        ],
        plan: {
          ...sourcePlan,
          waypoints: [{ ...sourcePlan.waypoints[0], lat: latitude + 0.01, lng: 1 }],
        },
      });
      assert.ok(highLatitude);
      const derived = deriveRouteShapingPlan(
        highLatitude,
        highLatitude.currentDisplacementMeters + 500,
      );
      assert.ok(derived);
      assert.ok(
        haversineDistanceMeters(highLatitude.sourcePlan.waypoints[0], derived.waypoints[0]) < 501,
      );
    }
  });

  it("counts only actual requests at the Production-used derived provider boundary", async () => {
    const exactFamily = family();
    assert.ok(exactFamily);
    let providerCalls = 0;
    const noDerivation = await executeDerivedRouteRequest({
      family: exactFamily,
      targetDisplacementMeters: exactFamily.currentDisplacementMeters,
      request: async () => {
        providerCalls += 1;
        return { durationSeconds: 1 };
      },
      evaluate: () => observation("never", 0, 0),
    });
    assert.equal(noDerivation.providerRequested, false);
    assert.equal(providerCalls, 0);

    const requested = await executeDerivedRouteRequest({
      family: exactFamily,
      targetDisplacementMeters: exactFamily.currentDisplacementMeters + 500,
      request: async (plan) => {
        providerCalls += 1;
        assert.notEqual(plan.waypoints[0].lat, sourcePlan.waypoints[0].lat);
        return { durationSeconds: 26.2 * 60 };
      },
      evaluate: (_plan, result) =>
        result.status === "fulfilled" ? observation("refined", 26.2, 1_600) : null,
    });
    assert.equal(requested.providerRequested, true);
    assert.equal(requested.observation?.actualAddedMinutes, 26.2);
    assert.equal(providerCalls, 1);

    const responseRejected = await executeDerivedRouteRequest({
      family: exactFamily,
      targetDisplacementMeters: exactFamily.currentDisplacementMeters + 550,
      request: async () => {
        providerCalls += 1;
        return { durationSeconds: Number.NaN };
      },
      evaluate: () => null,
    });
    assert.deepEqual(responseRejected, {
      status: "PROVIDER_RESPONSE_REJECTED",
      providerRequested: true,
      observation: null,
    });

    const rejected = await executeDerivedRouteRequest({
      family: exactFamily,
      targetDisplacementMeters: exactFamily.currentDisplacementMeters + 600,
      request: async () => {
        providerCalls += 1;
        throw new Error("provider failed");
      },
      evaluate: (_plan, result) => {
        assert.equal(result.status, "rejected");
        return null;
      },
    });
    assert.equal(rejected.providerRequested, true);
    assert.equal(providerCalls, 3);

    for (const failure of [
      new DOMException("timed out", "AbortError"),
      new Error("provider rejected"),
    ]) {
      const providerFailureResult: {
        status: string;
        providerRequested: boolean;
        observation: null;
      } = await executeDerivedRouteRequest({
        family: exactFamily,
        targetDisplacementMeters: exactFamily.currentDisplacementMeters + 700,
        request: async () => {
          throw failure;
        },
        evaluate: () => null,
      });
      assert.equal(providerFailureResult.status, "PROVIDER_REQUEST_FAILED");
    }

    const evaluationFailure = await executeDerivedRouteRequest({
      family: exactFamily,
      targetDisplacementMeters: exactFamily.currentDisplacementMeters + 800,
      request: async () => ({ durationSeconds: 1_572 }),
      evaluate: () => {
        throw new Error("private evaluator detail");
      },
    });
    assert.deepEqual(evaluationFailure, {
      status: "PROVIDER_EVALUATION_FAILED",
      providerRequested: true,
      observation: null,
    });
  });

  it("records a provider rejection as one attempted execution and stops", async () => {
    let calls = 0;
    const result = await runBoundedDurationRefinement({
      requestedExtraMinutes: 30,
      baselineDurationMinutes: 60,
      attemptsAlreadyUsed: 4,
      observations: [observation("lower", 18, 1_000)],
      maximumConstructionValue: 2_000,
      construct: async () => {
        calls += 1;
        return { status: "PROVIDER_REQUEST_FAILED" };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.attempted, true);
    assert.equal(result.executions.length, 1);
    assert.equal(result.executions[0].providerResult, "PROVIDER_REQUEST_FAILED");
    assert.equal(result.executions[0].observation, null);
    assert.equal(result.stopReason, "PROVIDER_REQUEST_FAILED");
    assert.deepEqual(result.stateCounts, {
      safeConstructionsProduced: 1,
      providerRequestsStarted: 1,
      providerResponsesReturned: 0,
      providerRequestsFailed: 1,
      providerResponsesEvaluated: 0,
    });

    const evaluatorFailed = await runBoundedDurationRefinement({
      requestedExtraMinutes: 30,
      baselineDurationMinutes: 60,
      attemptsAlreadyUsed: 4,
      observations: [observation("lower", 18, 1_000)],
      maximumConstructionValue: 2_000,
      construct: async () => ({ status: "PROVIDER_EVALUATION_FAILED" }),
    });
    assert.equal(evaluatorFailed.stopReason, "PROVIDER_EVALUATION_FAILED");
    assert.deepEqual(evaluatorFailed.stateCounts, {
      safeConstructionsProduced: 1,
      providerRequestsStarted: 1,
      providerResponsesReturned: 1,
      providerRequestsFailed: 0,
      providerResponsesEvaluated: 0,
    });

    const responseRejected = await runBoundedDurationRefinement({
      requestedExtraMinutes: 30,
      baselineDurationMinutes: 60,
      attemptsAlreadyUsed: 4,
      observations: [observation("lower", 18, 1_000)],
      maximumConstructionValue: 2_000,
      construct: async () => ({ status: "PROVIDER_RESPONSE_REJECTED" }),
    });
    assert.equal(responseRejected.stopReason, "PROVIDER_RESPONSE_REJECTED");
    assert.deepEqual(responseRejected.stateCounts, {
      safeConstructionsProduced: 1,
      providerRequestsStarted: 1,
      providerResponsesReturned: 1,
      providerRequestsFailed: 0,
      providerResponsesEvaluated: 1,
    });
  });

  it("executes derived provider geometry through Production evaluation and existing selection", async () => {
    const exactFamily = family();
    assert.ok(exactFamily);
    const start = { lat: 0, lng: 0, formatted: "Start" };
    const end = { lat: 0, lng: 1, formatted: "End" };
    const baseline = computed([start, end], 3_600, 111_000);
    const ordinary = computed([start, { lat: 0.01, lng: 0.5 }, end], 3_600 + 18.1 * 60, 114_000);
    const evidencePlaces = [
      ["woods", "nature_preserve"],
      ["historical_place", "museum"],
      ["scenic_spot", "observation_deck"],
      ["beach", "marina"],
      ["wildlife_refuge", "wildlife_park"],
      ["farmers_market", "locality"],
    ].map(([primaryType, secondaryType], index) => ({
      id: `verified-near-route-${index}`,
      lat: 0.004 + index * 0.0001,
      lng: 0.75,
      primaryType,
      types: [primaryType, secondaryType, "woods"],
      displayName: `Verified place ${index}`,
    }));
    const candidates: RouteCandidateForFinalScoring[] = [
      {
        candidateId: "baseline-0",
        explorationStage: null,
        directions: baseline,
        source: "fastest",
        selectedWaypointReason: null,
        intendedAddedMinutes: null,
        constructionTargetMinutes: null,
        durationTargetClassification: null,
        scenicWaypoints: [],
        routeShapeEligible: true,
      },
      {
        candidateId: "ordinary-lower",
        explorationStage: 1,
        directions: ordinary,
        source: "scenik",
        selectedWaypointReason: "Verified woodland",
        intendedAddedMinutes: null,
        constructionTargetMinutes: null,
        durationTargetClassification: null,
        scenicWaypoints: [],
        routeShapeEligible: true,
      },
    ];
    let providerCalls = 4;
    let providerDirections: ComputedDirections | null = null;
    const orchestration = await orchestrateDurationRefinement({
      candidates,
      relatedCandidates: [{ candidateId: "ordinary-lower", family: exactFamily }],
      evidencePlaces,
      start,
      end,
      mood: "Peaceful",
      theme: "Forest",
      requestedExtraMinutes: 30,
      requiredStopCount: 0,
      attemptsAlreadyUsed: 4,
      maximumConstructionValue: exactFamily.currentDisplacementMeters + 1_000,
      explorationStage: 2,
      request: (plan) => ({
        candidateId: "duration-refinement-2",
        response: (async () => {
          providerCalls += 1;
          assert.equal(providerCalls, 5);
          assert.notEqual(plan.waypoints[0].lat, exactFamily.sourcePlan.waypoints[0].lat);
          providerDirections = computed(
            [start, plan.waypoints[0], { lat: 0.004, lng: 0.75 }, end],
            3_600 + 26.2 * 60,
            118_000,
          );
          return providerDirections;
        })(),
      }),
    });
    assert.equal(orchestration.initialPass.selection.timeTargetOutcome, "NO_TARGET_BAND_ROUTE");
    assert.equal(orchestration.initialPass.selection.selected.candidateId, "ordinary-lower");
    assert.equal(orchestration.controllerInvocations, 1);
    assert.equal(orchestration.controller.executions.length, 1);
    assert.equal(orchestration.controller.executions[0].parentCandidateId, "ordinary-lower");
    assert.equal(orchestration.controller.executions[0].strategy, "BOUNDED_EXPANSION");
    assert.equal(orchestration.controller.stateCounts.providerRequestsStarted, 1);
    assert.equal(orchestration.controller.stateCounts.providerResponsesEvaluated, 1);
    assert.equal(orchestration.controller.stopReason, "TARGET_REACHED");
    assert.ok(providerDirections);
    assert.equal(candidates.length, 3);
    assert.deepEqual(candidates[2].refinementLineage, {
      parentCandidateId: "ordinary-lower",
      familyId: exactFamily.familyId,
      attemptNumber: 1,
    });
    const finalPass = orchestration.finalPass;
    const refined = finalPass.scoredCandidates.find(
      (candidate) => candidate.candidateId === "duration-refinement-2",
    );
    assert.ok(refined);
    assert.equal(refined.directions, providerDirections);
    assert.equal(refined.evidenceAssociation.evidenceMatchedThroughWaypoints, 0);
    assert.equal(refined.evidenceAssociation.evidenceMatchedToGeometry, 6);
    assert.equal(refined.scoreResult.total, 78);
    assert.equal(refined.durationTargetClassification, "TARGET_BAND");
    const after = finalPass.selection;
    assert.equal(after.selected.candidateId, "duration-refinement-2");
    assert.equal(after.timeTargetOutcome, "TARGET_MET");
    assert.equal(
      orchestration.finalPassWithoutRecordedCandidates.selection.timeTargetOutcome,
      "NO_TARGET_BAND_ROUTE",
    );
  });

  it("classifies full-chain provider failures and the one-second boundary", async () => {
    const start = { lat: 0, lng: 0, formatted: "Start" };
    const end = { lat: 0, lng: 1, formatted: "End" };
    const evidencePlaces = Array.from({ length: 6 }, (_, index) => ({
      id: `verified-near-route-${index}`,
      lat: 0.004 + index * 0.0001,
      lng: 0.75,
      primaryType: "woods",
      types: ["woods", "nature_preserve"],
      displayName: `Verified place ${index}`,
    }));
    const run = async (response: () => Promise<ComputedDirections>) => {
      const exactFamily = family();
      assert.ok(exactFamily);
      const baseline = computed([start, end], 3_600, 111_000);
      const candidates: RouteCandidateForFinalScoring[] = [
        {
          candidateId: "baseline-0",
          explorationStage: null,
          directions: baseline,
          source: "fastest",
          selectedWaypointReason: null,
          intendedAddedMinutes: null,
          constructionTargetMinutes: null,
          durationTargetClassification: null,
          scenicWaypoints: [],
          routeShapeEligible: true,
        },
        {
          candidateId: "ordinary-lower",
          explorationStage: 1,
          directions: computed(
            [start, exactFamily.sourcePlan.waypoints[0], end],
            3_600 + 18.1 * 60,
            114_000,
          ),
          source: "scenik",
          selectedWaypointReason: "Verified woodland",
          intendedAddedMinutes: null,
          constructionTargetMinutes: null,
          durationTargetClassification: null,
          scenicWaypoints: [],
          routeShapeEligible: true,
        },
      ];
      const result = await orchestrateDurationRefinement({
        candidates,
        relatedCandidates: [{ candidateId: "ordinary-lower", family: exactFamily }],
        evidencePlaces,
        start,
        end,
        mood: "Peaceful",
        theme: "Forest",
        requestedExtraMinutes: 30,
        requiredStopCount: 0,
        attemptsAlreadyUsed: 5,
        maximumConstructionValue: exactFamily.currentDisplacementMeters + 1_000,
        explorationStage: 2,
        request: () => ({ candidateId: "duration-refinement-failure", response: response() }),
      });
      return { result, candidates, baseline };
    };

    const rejected = await run(async () => {
      throw new Error("provider rejected");
    });
    assert.equal(rejected.result.controller.stopReason, "PROVIDER_REQUEST_FAILED");
    assert.equal(rejected.result.controller.stateCounts.providerRequestsFailed, 1);
    assert.equal(rejected.result.finalPass.selection.timeTargetOutcome, "NO_TARGET_BAND_ROUTE");

    const unusable = await run(async () =>
      computed([start, { lat: 0.01, lng: 0.5 }, end], Number.NaN, 118_000),
    );
    assert.equal(unusable.result.controller.stopReason, "PROVIDER_RESPONSE_REJECTED");
    assert.equal(unusable.result.controller.stateCounts.providerResponsesEvaluated, 1);
    assert.equal(unusable.candidates.length, 2);
    assert.equal(unusable.result.finalPass.selection.timeTargetOutcome, "NO_TARGET_BAND_ROUTE");

    const evaluationFailed = await run(async () => {
      const directions = computed([start, { lat: 0.01, lng: 0.5 }, end], 5_100, 118_000);
      Object.defineProperty(directions, "durationSeconds", {
        get() {
          throw new Error("private evaluator detail");
        },
      });
      return directions;
    });
    assert.equal(evaluationFailed.result.controller.stopReason, "PROVIDER_EVALUATION_FAILED");
    assert.equal(evaluationFailed.result.controller.stateCounts.providerResponsesEvaluated, 0);

    const boundary = await run(async () =>
      computed([start, { lat: 0.006, lng: 0.68 }, end], 3_600 + 30 * 60 * 0.75 - 1, 117_000),
    );
    const recorded = boundary.candidates.find(
      ({ candidateId }) => candidateId === "duration-refinement-failure",
    );
    assert.ok(recorded);
    assert.equal(recorded.durationTargetClassification, "MODERATE_UNDERSHOOT");
    assert.ok(boundary.result.controller.executions[0].observation);
    assert.equal(boundary.result.controller.reachedTargetBand, false);
    assert.equal(boundary.result.finalPass.selection.timeTargetOutcome, "NO_TARGET_BAND_ROUTE");
  });

  function recordConnectedNegative(directions: ComputedDirections) {
    const exactFamily = family();
    assert.ok(exactFamily);
    const shapingPlan = deriveRouteShapingPlan(
      exactFamily,
      exactFamily.currentDisplacementMeters + 500,
    );
    assert.ok(shapingPlan);
    const start = { lat: 0, lng: 0, formatted: "Start" };
    const end = { lat: 0, lng: 1, formatted: "End" };
    const baseline = computed([start, end], 3_600, 111_000);
    const candidates: RouteCandidateForFinalScoring[] = [
      {
        candidateId: "baseline-0",
        explorationStage: null,
        directions: baseline,
        source: "fastest",
        selectedWaypointReason: null,
        intendedAddedMinutes: null,
        constructionTargetMinutes: null,
        durationTargetClassification: null,
        scenicWaypoints: [],
        routeShapeEligible: true,
      },
    ];
    const recorded = recordRefinedProviderCandidate({
      candidates,
      candidateId: "duration-refinement-negative",
      parentCandidateId: "baseline-0",
      familyId: exactFamily.familyId,
      attemptNumber: 1,
      explorationStage: 2,
      directions,
      shapingPlan,
      evidencePlaces: [],
      start,
      end,
      mood: "Peaceful",
      theme: "Forest",
      requestedExtraMinutes: 30,
      requiredStopCount: 0,
      intendedAddedMinutes: 27,
      constructionTargetMinutes: 27,
    });
    return { candidates, recorded, baseline, shapingPlan, start, end };
  }

  it("rejects a duplicate parent route through the Production recorder", () => {
    const fixture = recordConnectedNegative(
      computed(
        [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 1 },
        ],
        3_600,
        111_000,
      ),
    );
    const duplicate = recordConnectedNegative(fixture.baseline);
    assert.equal(duplicate.recorded.evaluation.meaningfullyDifferent, false);
    assert.equal(duplicate.candidates.length, 1);
  });

  it("rejects a reversed-equivalent parent route through the Production recorder", () => {
    const fixture = recordConnectedNegative(
      computed(
        [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 1 },
        ],
        3_600,
        111_000,
      ),
    );
    const reversed = recordConnectedNegative({
      ...fixture.baseline,
      encodedPolyline: encode([fixture.end, fixture.start]),
      steps: [...fixture.baseline.steps].reverse(),
    });
    assert.equal(reversed.recorded.inserted, false);
  });

  it("rejects an over-budget provider route through the Production recorder", () => {
    const fixture = recordConnectedNegative(
      computed(
        [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 1 },
        ],
        3_600,
        111_000,
      ),
    );
    const overBudget = recordConnectedNegative(
      computed([fixture.start, fixture.shapingPlan.waypoints[0], fixture.end], 5_401, 118_000),
    );
    assert.equal(overBudget.recorded.evaluation.withinBudget, false);
    assert.equal(overBudget.candidates.length, 1);
  });

  it("rejects malformed duration with otherwise valid geometry", () => {
    const malformed = recordConnectedNegative(
      computed(
        [
          { lat: 0, lng: 0 },
          { lat: 0.01, lng: 0.5 },
          { lat: 0, lng: 1 },
        ],
        Number.NaN,
        118_000,
      ),
    );
    assert.equal(malformed.recorded.evaluation.withinBudget, false);
    assert.equal(malformed.candidates.length, 1);
  });

  it("rejects malformed geometry with otherwise valid duration", () => {
    const malformed = recordConnectedNegative({
      ...computed(
        [
          { lat: 0, lng: 0 },
          { lat: 0.01, lng: 0.5 },
          { lat: 0, lng: 1 },
        ],
        5_100,
        118_000,
      ),
      encodedPolyline: "malformed",
    });
    assert.equal(malformed.recorded.evaluation.routeShape.routeShapeEligible, false);
    assert.equal(malformed.candidates.length, 1);
  });

  it("rejects valid provider metrics when coherence evaluation fails", () => {
    const incoherent = recordConnectedNegative(
      computed(
        [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 0.45 },
          { lat: 0, lng: 0 },
          { lat: 0.02, lng: 0.5 },
          { lat: 0, lng: 1 },
        ],
        5_100,
        180_000,
      ),
    );
    assert.equal(incoherent.recorded.evaluation.withinBudget, true);
    assert.equal(incoherent.recorded.evaluation.routeShape.routeShapeEligible, false);
    assert.equal(incoherent.candidates.length, 1);
  });

  it("calculates zero associated evidence for an evidence-free route", () => {
    const fixture = recordConnectedNegative(
      computed(
        [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 1 },
        ],
        3_600,
        111_000,
      ),
    );
    const evidenceFree = recordConnectedNegative(
      computed(
        [fixture.start, fixture.shapingPlan.waypoints[0], { lat: 0.01, lng: 0.8 }, fixture.end],
        5_100,
        118_000,
      ),
    );
    assert.equal(evidenceFree.recorded.inserted, true);
    const finalPass = scoreAndSelectRouteCandidateCollection({
      candidates: evidenceFree.candidates,
      evidencePlaces: [],
      start: fixture.start,
      end: fixture.end,
      mood: "Peaceful",
      theme: "Forest",
      requestedExtraMinutes: 30,
      requiredStopCount: 0,
    });
    const refined = finalPass.scoredCandidates.find(
      (candidate) => candidate.candidateId === "duration-refinement-negative",
    );
    assert.ok(refined);
    assert.equal(refined.evidenceAssociation.evidenceMatchedToGeometry, 0);
  });

  it("keeps a naturally calculated sub-60 route out of final selection", () => {
    const fixture = recordConnectedNegative(
      computed(
        [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 1 },
        ],
        3_600,
        111_000,
      ),
    );
    const subSixty = recordConnectedNegative(
      computed(
        [fixture.start, fixture.shapingPlan.waypoints[0], { lat: 0.01, lng: 0.8 }, fixture.end],
        5_100,
        118_000,
      ),
    );
    const finalPass = scoreAndSelectRouteCandidateCollection({
      candidates: subSixty.candidates,
      evidencePlaces: [],
      start: fixture.start,
      end: fixture.end,
      mood: "Peaceful",
      theme: "Forest",
      requestedExtraMinutes: 30,
      requiredStopCount: 0,
    });
    const refined = finalPass.scoredCandidates.find(
      (candidate) => candidate.candidateId === "duration-refinement-negative",
    );
    assert.ok(refined);
    assert.ok(refined.scoreResult.total < 60);
    assert.equal(finalPass.selection.selected.candidateId, "baseline-0");
  });

  it("covers allowance, baseline, utilisation and expansion boundaries without non-finite targets", async () => {
    for (const requestedExtraMinutes of [0, 1, 5, 15, 30, 31, 70, 120]) {
      for (const baselineDurationMinutes of [0, 0.5, 1, 10, 60, 360, -1, Number.NaN, Infinity]) {
        const targets: number[] = [];
        const result = await runBoundedDurationRefinement({
          requestedExtraMinutes,
          baselineDurationMinutes,
          attemptsAlreadyUsed: 5,
          observations: [observation("lower", Math.max(0.1, requestedExtraMinutes * 0.5), 1_000)],
          maximumConstructionValue: 2_000,
          construct: async (input) => {
            targets.push(input.constructionValue);
            return evaluated(
              observation("result", requestedExtraMinutes * 0.75, input.constructionValue),
            );
          },
        });
        assert.ok(result.executions.length <= 1);
        assert.ok(targets.every((target) => Number.isFinite(target) && target > 0));
      }
    }
    for (const utilisation of [0.75 - 1e-6, 0.75, 0.75 + 1e-6, 1, 1 + 1e-6]) {
      const calls: number[] = [];
      await runBoundedDurationRefinement({
        requestedExtraMinutes: 30,
        baselineDurationMinutes: 60,
        attemptsAlreadyUsed: 5,
        observations: [
          observation("candidate", 30 * utilisation, 1_000, { withinBudget: utilisation <= 1 }),
        ],
        maximumConstructionValue: 1_600,
        construct: async (input) => {
          calls.push(input.constructionValue);
          return { status: "NO_SAFE_CONSTRUCTION" as const };
        },
      });
      assert.equal(calls.length, utilisation < 0.75 ? 1 : 0);
    }
  });

  it("uses authoritative seconds at the 75 and 100 percent selection boundaries", () => {
    const baseline = computed(
      [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 1 },
      ],
      3_600,
      100_000,
    );
    const outcomes = [
      { seconds: 4_949, target: false },
      { seconds: 4_950, target: true },
      { seconds: 4_951, target: true },
      { seconds: 5_400, target: true },
      { seconds: 5_401, target: false },
    ];
    for (const { seconds, target } of outcomes) {
      const route = computed(
        [
          { lat: 0, lng: 0 },
          { lat: 0.02, lng: 0.5 },
          { lat: 0, lng: 1 },
        ],
        seconds,
        110_000 + seconds,
      );
      const selection = selectRouteCandidate(
        [
          {
            candidateId: "baseline",
            directions: baseline,
            score: 70,
            scoreResult: {},
            originalIndex: 0,
          },
          {
            candidateId: "candidate",
            directions: route,
            score: 70,
            scoreResult: {},
            originalIndex: 1,
          },
        ],
        30,
      );
      assert.equal(selection.timeTargetOutcome === "TARGET_MET", target);
      assert.equal(
        selection.selected.candidateId,
        target ? "candidate" : seconds < 4_950 ? "candidate" : "baseline",
      );
    }
  });

  it("does not invalidate an existing target route for a disproportionate allowance", async () => {
    let calls = 0;
    const result = await runBoundedDurationRefinement({
      requestedExtraMinutes: 70,
      baselineDurationMinutes: 10,
      attemptsAlreadyUsed: 4,
      observations: [observation("already-target", 55, 10_000, { withinBudget: true })],
      maximumConstructionValue: 12_000,
      construct: async () => {
        calls += 1;
        return { status: "NO_SAFE_CONSTRUCTION" as const };
      },
    });
    assert.equal(result.stopReason, "TARGET_REACHED");
    assert.equal(result.reachedTargetBand, true);
    assert.equal(calls, 0);
  });
  it("uses a related observed bracket to fill the production-class 30-minute gap", async () => {
    const targets: number[] = [];
    const result = await runBoundedDurationRefinement({
      requestedExtraMinutes: 30,
      baselineDurationMinutes: 367.7,
      attemptsAlreadyUsed: 4,
      observations: productionGap,
      maximumConstructionValue: 50_000,
      construct: async (input) => {
        targets.push(input.constructionValue);
        return evaluated(observation("duration-refinement-8", 26.2, input.constructionValue));
      },
    });
    assert.equal(result.reachedTargetBand, true);
    assert.equal(result.executions.length, 1);
    assert.equal(result.executions[0].strategy, "RELATED_BRACKET");
    assert.equal(result.executions[0].parentCandidateId, "scenic-stage-5");
    assert.equal(result.executions[0].upperCandidateId, "scenic-stage-4");
    assert.ok(targets[0] > 18_000 && targets[0] < 42_000);
  });

  it("updates an undershooting lower bound before the second attempt", async () => {
    const parents: string[] = [];
    const result = await runBoundedDurationRefinement({
      requestedExtraMinutes: 30,
      baselineDurationMinutes: 300,
      attemptsAlreadyUsed: 4,
      observations: productionGap,
      maximumConstructionValue: 50_000,
      construct: async (input) => {
        parents.push(input.parentCandidateId);
        return evaluated(
          parents.length === 1
            ? observation("duration-refinement-8", 20, input.constructionValue)
            : observation("duration-refinement-9", 25, input.constructionValue),
        );
      },
    });
    assert.deepEqual(parents, ["scenic-stage-5", "duration-refinement-8"]);
    assert.equal(result.reachedTargetBand, true);
    assert.equal(result.executions.length, 2);
    assert.deepEqual(result.stateCounts, {
      safeConstructionsProduced: 2,
      providerRequestsStarted: 2,
      providerResponsesReturned: 2,
      providerRequestsFailed: 0,
      providerResponsesEvaluated: 2,
    });
  });

  it("updates a coherent over-budget upper bound before the second attempt", async () => {
    const upperIds: Array<string | null> = [];
    const result = await runBoundedDurationRefinement({
      requestedExtraMinutes: 30,
      baselineDurationMinutes: 300,
      attemptsAlreadyUsed: 4,
      observations: [observation("lower", 18, 18_000)],
      maximumConstructionValue: 50_000,
      construct: async (input) => {
        upperIds.push(input.upperCandidateId);
        return evaluated(
          upperIds.length === 1
            ? observation("refined-upper", 34, input.constructionValue, { withinBudget: false })
            : observation("target", 27, input.constructionValue),
        );
      },
    });
    assert.deepEqual(upperIds, [null, "refined-upper"]);
    assert.equal(result.reachedTargetBand, true);
  });

  it("stops after the fifth total attempt when the first refinement reaches target", async () => {
    let calls = 0;
    const result = await runBoundedDurationRefinement({
      requestedExtraMinutes: 30,
      baselineDurationMinutes: 300,
      attemptsAlreadyUsed: 4,
      observations: productionGap,
      maximumConstructionValue: 50_000,
      construct: async (input) => {
        calls += 1;
        return evaluated(observation("target", 27, input.constructionValue));
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.stopReason, "TARGET_REACHED");
  });

  it("does not refine when ordinary exploration already reached the target band", async () => {
    let calls = 0;
    const result = await runBoundedDurationRefinement({
      requestedExtraMinutes: 30,
      baselineDurationMinutes: 300,
      attemptsAlreadyUsed: 4,
      observations: [...productionGap, observation("ordinary-target", 24, 24_000)],
      maximumConstructionValue: 50_000,
      construct: async () => {
        calls += 1;
        return { status: "NO_SAFE_CONSTRUCTION" as const };
      },
    });
    assert.equal(result.reachedTargetBand, true);
    assert.equal(result.attempted, false);
    assert.equal(calls, 0);
  });

  it("uses bounded expansion when no coherent related upper exists", async () => {
    const result = await runBoundedDurationRefinement({
      requestedExtraMinutes: 30,
      baselineDurationMinutes: 300,
      attemptsAlreadyUsed: 4,
      observations: [
        observation("lower", 18, 18_000),
        observation("incoherent-upper", 41, 42_000, { routeShapeEligible: false }),
      ],
      maximumConstructionValue: 50_000,
      construct: async (input) => evaluated(observation("target", 26, input.constructionValue)),
    });
    assert.equal(result.executions[0].strategy, "BOUNDED_EXPANSION");
    assert.equal(result.executions[0].upperCandidateId, null);
    assert.ok(result.executions[0].constructionValue <= 18_000 * 1.6);
  });

  it("rejects incoherent and low-quality refinement outcomes without changing fallback", async () => {
    for (const overrides of [
      { routeShapeEligible: false },
      { qualityEligible: false },
      { duplicate: true },
    ]) {
      const result = await runBoundedDurationRefinement({
        requestedExtraMinutes: 30,
        baselineDurationMinutes: 300,
        attemptsAlreadyUsed: 5,
        observations: [observation("lower", 18, 18_000)],
        maximumConstructionValue: 50_000,
        construct: async (input) =>
          evaluated(observation("rejected", 27, input.constructionValue, overrides)),
      });
      assert.equal(result.reachedTargetBand, false);
    }
  });

  it("never makes a seventh request and classifies disproportionate short routes", async () => {
    let calls = 0;
    const exhausted = await runBoundedDurationRefinement({
      requestedExtraMinutes: 30,
      baselineDurationMinutes: 300,
      attemptsAlreadyUsed: MAX_SCENIC_ROUTE_ATTEMPTS,
      observations: productionGap,
      maximumConstructionValue: 50_000,
      construct: async () => {
        calls += 1;
        return { status: "NO_SAFE_CONSTRUCTION" as const };
      },
    });
    assert.equal(exhausted.stopReason, "ATTEMPT_CAPACITY_EXHAUSTED");
    const disproportionate = await runBoundedDurationRefinement({
      requestedExtraMinutes: 70,
      baselineDurationMinutes: 10,
      attemptsAlreadyUsed: 4,
      observations: [observation("lower", 12, 12_000)],
      maximumConstructionValue: 15_000,
      construct: async () => {
        calls += 1;
        return { status: "NO_SAFE_CONSTRUCTION" as const };
      },
    });
    assert.equal(disproportionate.stopReason, "DISPROPORTIONATE_TO_BASELINE");
    assert.equal(calls, 0);
  });

  it("fails closed for invalid construction bounds", async () => {
    for (const maximumConstructionValue of [Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      const result = await runBoundedDurationRefinement({
        requestedExtraMinutes: 30,
        baselineDurationMinutes: 300,
        attemptsAlreadyUsed: 4,
        observations: [observation("lower", 18, 18_000)],
        maximumConstructionValue,
        construct: async () => {
          throw new Error("must not execute");
        },
      });
      assert.equal(result.attempted, false);
    }
  });

  it("accepts dateline-safe existing plans and rejects malformed coordinates", () => {
    const plan = {
      kind: "forest" as const,
      reason: "Forest corridor",
      estimatedDetourMeters: 20_000,
      signature: "dateline",
      waypoints: [
        {
          id: "dateline-place",
          lat: 10,
          lng: 179.9,
          primaryType: "woods",
          types: ["woods"],
          reason: "Woodland",
          insertionIndex: 0,
          estimatedDetourMeters: 20_000,
        },
      ],
    };
    assert.equal(isSafeRefinementCorridorPlan(plan), true);
    assert.equal(
      isSafeRefinementCorridorPlan({
        ...plan,
        waypoints: [{ ...plan.waypoints[0], lng: Number.POSITIVE_INFINITY }],
      }),
      false,
    );
    assert.equal(
      isSafeRefinementCorridorPlan({
        ...plan,
        waypoints: [{ ...plan.waypoints[0], lng: -179.9 }],
      }),
      true,
    );
  });
});
