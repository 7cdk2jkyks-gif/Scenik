import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DERIVED_MOVEMENT_NUMERICAL_EPSILON_METERS,
  MIN_DERIVED_WAYPOINT_SEPARATION_METERS,
  MAX_SCENIC_ROUTE_ATTEMPTS,
  MAX_DERIVED_WAYPOINT_DISPLACEMENT_FROM_SOURCE_METERS,
  createRequestLocalPlanFamily,
  deriveRouteShapingPlan,
  executeDerivedRouteRequest,
  effectiveConstructionMetadata,
  isCalibrationSafeObservation,
  hasSafeDerivedWaypointSeparation,
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
    actualAddedSeconds: actualAddedMinutes * 60,
    constructionValue,
    withinBudget: actualAddedMinutes <= 30,
    routeShapeEligible: true,
    duplicate: false,
    qualityEligible: true,
    calibrationSafe: true,
    intendedTargetSeconds: actualAddedMinutes * 60,
    constructionTargetSeconds: actualAddedMinutes * 60,
    adaptiveTargetSeconds: null,
    requestedRole: null,
    effectiveConstruction: {
      waypointForm: "one-waypoint",
      insertionPositions: [0],
      progress: "middle",
      orientation: "left",
    },
    effectiveWaypointCount: 1,
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

  it("derives inward for one- and two-waypoint families while preserving topology", () => {
    const one = family();
    assert.ok(one);
    const inward = deriveRouteShapingPlan(one, one.currentDisplacementMeters * 0.5);
    assert.ok(inward);
    assert.equal(inward.waypoints.length, 1);
    assert.equal(inward.waypoints[0].id, sourcePlan.waypoints[0].id);
    assert.equal(inward.waypoints[0].insertionIndex, 0);
    assert.ok(Math.abs(inward.waypoints[0].lat) < Math.abs(sourcePlan.waypoints[0].lat));
    assert.equal(inward.waypoints.at(-1)?.lng, sourcePlan.waypoints.at(-1)?.lng);

    const twoPlan = {
      ...sourcePlan,
      waypoints: [
        { ...sourcePlan.waypoints[0], id: "evidence-1", lng: 0.25, insertionIndex: 0 },
        { ...sourcePlan.waypoints[0], id: "evidence-2", lng: 0.75, insertionIndex: 0 },
      ],
    };
    const two = family({ sourceWaypointIds: ["evidence-1", "evidence-2"], plan: twoPlan });
    assert.ok(two);
    const twoInward = deriveRouteShapingPlan(two, two.currentDisplacementMeters * 0.4);
    assert.ok(twoInward);
    assert.deepEqual(
      twoInward.waypoints.map(({ id, insertionIndex }) => ({ id, insertionIndex })),
      [
        { id: "evidence-1", insertionIndex: 0 },
        { id: "evidence-2", insertionIndex: 0 },
      ],
    );
    assert.ok(twoInward.waypoints.every((waypoint) => waypoint.lat > 0 && waypoint.lat < 0.01));
  });

  it("derives coordinate-free effective form, progress and orientation from the selected plan", () => {
    const one = effectiveConstructionMetadata(sourcePlan, [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
    ]);
    assert.deepEqual(one, {
      waypointForm: "one-waypoint",
      insertionPositions: [0],
      progress: "middle",
      orientation: "left",
    });
    assert.deepEqual(
      effectiveConstructionMetadata(
        {
          ...sourcePlan,
          waypoints: [{ ...sourcePlan.waypoints[0], lat: -0.01 }],
        },
        [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 1 },
        ],
      ),
      {
        waypointForm: "one-waypoint",
        insertionPositions: [0],
        progress: "middle",
        orientation: "right",
      },
    );
    const mixedPlan = {
      ...sourcePlan,
      waypoints: [
        { ...sourcePlan.waypoints[0], id: "evidence-1", lng: 0.5, insertionIndex: 0 },
        {
          ...sourcePlan.waypoints[0],
          id: "evidence-2",
          lat: -0.01,
          lng: 1.5,
          insertionIndex: 1,
        },
      ],
    };
    assert.deepEqual(
      effectiveConstructionMetadata(mixedPlan, [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 1 },
        { lat: 0, lng: 2 },
      ]),
      {
        waypointForm: "two-waypoint-arc",
        insertionPositions: [0, 1],
        progress: "distributed",
        orientation: "alternating-mixed",
      },
    );
    const submittedNearSegmentEnds = {
      ...sourcePlan,
      waypoints: [
        { ...sourcePlan.waypoints[0], id: "evidence-1", lat: 0.01, lng: 0.01, insertionIndex: 0 },
        {
          ...sourcePlan.waypoints[0],
          id: "evidence-2",
          lat: -0.01,
          lng: 1.99,
          insertionIndex: 1,
        },
      ],
    };
    assert.deepEqual(
      effectiveConstructionMetadata(submittedNearSegmentEnds, [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 1 },
        { lat: 0, lng: 2 },
      ]),
      {
        waypointForm: "two-waypoint-arc",
        insertionPositions: [0, 1],
        progress: "distributed",
        orientation: "alternating-mixed",
      },
    );
  });

  it("rejects an inward two-waypoint family that converges below the ordinary separation", async () => {
    const closeAnchors = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.01 },
      { lat: 0, lng: 0.02 },
    ];
    const convergingPlan = {
      ...sourcePlan,
      waypoints: [
        { ...sourcePlan.waypoints[0], id: "evidence-1", lat: 0.01, lng: 0.009, insertionIndex: 0 },
        { ...sourcePlan.waypoints[0], id: "evidence-2", lat: -0.01, lng: 0.011, insertionIndex: 1 },
      ],
    };
    const converging = family({
      destination: closeAnchors[2],
      requiredStops: [closeAnchors[1]],
      anchors: closeAnchors,
      sourceWaypointIds: ["evidence-1", "evidence-2"],
      plan: convergingPlan,
    });
    assert.ok(converging);
    assert.ok(
      haversineDistanceMeters(
        converging.sourcePlan.waypoints[0],
        converging.sourcePlan.waypoints[1],
      ) >= MIN_DERIVED_WAYPOINT_SEPARATION_METERS,
    );
    assert.equal(
      deriveRouteShapingPlan(converging, converging.currentDisplacementMeters * 0.1),
      null,
    );
    let providerCalls = 0;
    const execution = await executeDerivedRouteRequest({
      family: converging,
      targetDisplacementMeters: converging.currentDisplacementMeters * 0.1,
      request: async () => {
        providerCalls += 1;
        return {};
      },
      evaluate: () => observation("never", 1, 1),
    });
    assert.equal(execution.status, "NO_SAFE_CONSTRUCTION");
    assert.equal(providerCalls, 0);
  });

  it("applies an inclusive finite 1 km separation policy globally", () => {
    const base = sourcePlan.waypoints[0];
    let lower = 0;
    let upper = 0.02;
    for (let iteration = 0; iteration < 80; iteration += 1) {
      const midpoint = (lower + upper) / 2;
      if (haversineDistanceMeters({ lat: 0, lng: 0 }, { lat: midpoint, lng: 0 }) < 1_000)
        lower = midpoint;
      else upper = midpoint;
    }
    const exact = upper;
    assert.equal(
      hasSafeDerivedWaypointSeparation([
        { ...base, lat: 0, lng: 0 },
        { ...base, id: "evidence-2", lat: exact, lng: 0 },
      ]),
      true,
    );
    assert.equal(
      hasSafeDerivedWaypointSeparation([
        { ...base, lat: 0, lng: 0 },
        { ...base, id: "evidence-2", lat: exact + 1e-8, lng: 0 },
      ]),
      true,
    );
    assert.equal(
      hasSafeDerivedWaypointSeparation([
        { ...base, lat: 0, lng: 0 },
        { ...base, id: "evidence-2", lat: exact - 1e-8, lng: 0 },
      ]),
      false,
    );
    assert.equal(
      hasSafeDerivedWaypointSeparation([
        { ...base, lat: 10, lng: 179.999 },
        { ...base, id: "evidence-2", lat: 10.01, lng: -179.999 },
      ]),
      true,
    );
    assert.equal(
      hasSafeDerivedWaypointSeparation([
        { ...base, lat: 89.98, lng: -90 },
        { ...base, id: "evidence-2", lat: 89.98, lng: 90 },
      ]),
      true,
    );
    assert.equal(
      hasSafeDerivedWaypointSeparation([
        { ...base, lat: Number.NaN, lng: 0 },
        { ...base, id: "evidence-2", lat: 0, lng: 0 },
      ]),
      false,
    );
  });

  it("derives inward safely near the antimeridian and high latitude", () => {
    const polarPlan = {
      ...sourcePlan,
      waypoints: [{ ...sourcePlan.waypoints[0], lat: 84.01, lng: 179.9 }],
    };
    const polar = family({
      origin: { lat: 84, lng: 179.5 },
      destination: { lat: 84, lng: -179.5 },
      anchors: [
        { lat: 84, lng: 179.5 },
        { lat: 84, lng: -179.5 },
      ],
      plan: polarPlan,
    });
    assert.ok(polar);
    const inward = deriveRouteShapingPlan(polar, polar.currentDisplacementMeters * 0.5);
    assert.ok(inward);
    assert.ok(Number.isFinite(inward.waypoints[0].lat));
    assert.ok(inward.waypoints[0].lat <= 90 && inward.waypoints[0].lat >= -90);
    assert.ok(inward.waypoints[0].lng <= 180 && inward.waypoints[0].lng >= -180);
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

    const collision = await executeDerivedRouteRequest({
      family: exactFamily,
      targetDisplacementMeters: exactFamily.currentDisplacementMeters * 0.5,
      isEffectiveCollision: () => true,
      request: async () => {
        providerCalls += 1;
        return { durationSeconds: 1 };
      },
      evaluate: () => observation("never", 0, 0),
    });
    assert.deepEqual(collision, {
      status: "EFFECTIVE_COLLISION",
      providerRequested: false,
      observation: null,
    });
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
    assert.equal(requested.observation?.actualAddedSeconds, 26.2 * 60);
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
        expectedAnchors: [start, ...plan.waypoints, end],
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
    assert.equal(orchestration.initialPass.selection.timeTargetOutcome, "MEANINGFUL_FALLBACK");
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
      "MEANINGFUL_FALLBACK",
    );
  });

  it("executes the captured +30 downward fixture through Production recording and selection", async () => {
    const exactFamily = family();
    assert.ok(exactFamily);
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
    const evidencePlaces = [
      "woods",
      "historical_place",
      "scenic_spot",
      "beach",
      "wildlife_refuge",
      "farmers_market",
    ].map((primaryType, index) => ({
      id: `verified-downward-${index}`,
      lat: 0.004 + index * 0.0001,
      lng: 0.75,
      primaryType,
      types: [primaryType, "woods", "nature_preserve"],
      displayName: `Verified downward evidence ${index}`,
    }));
    const existingObservations = [
      observation("target-15-spur", 33.5, exactFamily.currentDisplacementMeters * 0.6, {
        relatedPlanKey: exactFamily.familyId,
        withinBudget: false,
        routeShapeEligible: false,
        calibrationSafe: false,
      }),
      observation("target-23-spur", 37.7, exactFamily.currentDisplacementMeters * 0.8, {
        relatedPlanKey: exactFamily.familyId,
        withinBudget: false,
        routeShapeEligible: false,
        calibrationSafe: false,
      }),
      observation("target-27-upper", 97.7, exactFamily.currentDisplacementMeters, {
        relatedPlanKey: exactFamily.familyId,
        withinBudget: false,
        qualityEligible: false,
      }),
    ];
    const constructionRatios: number[] = [];
    let calls = 3;
    let selectedGeometry = "";
    const result = await orchestrateDurationRefinement({
      candidates,
      relatedCandidates: [{ candidateId: "target-27-upper", family: exactFamily }],
      existingObservations,
      evidencePlaces,
      start,
      end,
      mood: "Peaceful",
      theme: "Forest",
      requestedExtraMinutes: 30,
      requiredStopCount: 0,
      attemptsAlreadyUsed: 3,
      maximumConstructionValue: 70_000,
      explorationStage: 2,
      request: (plan) => {
        calls += 1;
        constructionRatios.push(plan.estimatedDetourMeters / exactFamily.currentDisplacementMeters);
        const addedSeconds = calls === 4 ? 35 * 60 : 27 * 60;
        const directions = computed(
          [start, plan.waypoints[0], { lat: 0.004, lng: 0.75 }, end],
          baseline.durationSeconds + addedSeconds,
          118_000,
        );
        if (addedSeconds === 27 * 60) selectedGeometry = directions.encodedPolyline;
        return {
          candidateId: `duration-refinement-${calls - 3}`,
          expectedAnchors: [start, plan.waypoints[0], end],
          response: Promise.resolve(directions),
        };
      },
    });
    assert.equal(calls, 5);
    assert.ok(Math.abs(constructionRatios[0] - 27 / 97.7) < 0.001);
    assert.ok(constructionRatios[1] < constructionRatios[0]);
    assert.equal(result.controller.stopReason, "TARGET_REACHED");
    assert.equal(result.controller.stateCounts.providerRequestsStarted, 2);
    assert.equal(result.finalPass.selection.selected.candidateId, "duration-refinement-2");
    assert.equal(result.finalPass.selection.selected.directions.encodedPolyline, selectedGeometry);
    assert.equal(result.finalPass.selection.timeTargetOutcome, "TARGET_MET");
    const selected = result.finalPass.scoredCandidates.find(
      (candidate) => candidate.candidateId === "duration-refinement-2",
    );
    assert.ok(selected);
    assert.ok(selected.scoreResult.total >= 60);
    assert.equal(selected.evidenceAssociation.evidenceMatchedThroughWaypoints, 0);
    assert.equal(selected.evidenceAssociation.evidenceMatchedToGeometry, 6);
    assert.equal(
      candidates.some((candidate) => candidate.candidateId === "duration-refinement-1"),
      false,
    );
    assert.deepEqual(candidates.at(-1)?.refinementLineage, {
      parentCandidateId: "duration-refinement-1",
      familyId: exactFamily.familyId,
      attemptNumber: 2,
    });
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
    assert.equal(rejected.result.finalPass.selection.timeTargetOutcome, "MEANINGFUL_FALLBACK");

    const unusable = await run(async () =>
      computed([start, { lat: 0.01, lng: 0.5 }, end], Number.NaN, 118_000),
    );
    assert.equal(unusable.result.controller.stopReason, "PROVIDER_RESPONSE_REJECTED");
    assert.equal(unusable.result.controller.stateCounts.providerResponsesEvaluated, 1);
    assert.equal(unusable.candidates.length, 2);
    assert.equal(unusable.result.finalPass.selection.timeTargetOutcome, "MEANINGFUL_FALLBACK");

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
    assert.equal(boundary.result.finalPass.selection.timeTargetOutcome, "MEANINGFUL_FALLBACK");
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

  it("rejects returned geometry that violates the submitted anchor order", () => {
    const start = { lat: 0, lng: 0, formatted: "Start" };
    const required = { lat: 0, lng: 0.3 };
    const end = { lat: 0, lng: 1, formatted: "End" };
    const candidates: RouteCandidateForFinalScoring[] = [
      {
        candidateId: "baseline",
        explorationStage: null,
        directions: computed([start, required, end], 3_600, 111_000),
        source: "fastest",
        selectedWaypointReason: null,
        intendedAddedMinutes: null,
        constructionTargetMinutes: null,
        durationTargetClassification: null,
        scenicWaypoints: [],
        routeShapeEligible: true,
      },
    ];
    const reversed = recordRefinedProviderCandidate({
      candidates,
      candidateId: "invalid-order",
      parentCandidateId: "parent",
      familyId: "family",
      attemptNumber: 1,
      explorationStage: 1,
      directions: computed([start, required, sourcePlan.waypoints[0], end], 4_800, 120_000),
      shapingPlan: sourcePlan,
      evidencePlaces: [],
      start,
      end,
      mood: "",
      theme: "",
      requestedExtraMinutes: 30,
      requiredStopCount: 1,
      expectedAnchors: [start, sourcePlan.waypoints[0], required, end],
      intendedAddedMinutes: 27,
      constructionTargetMinutes: 27,
    });
    assert.equal(reversed.inserted, false);
    assert.equal(reversed.evaluation.routeShape.routeShapeRejectionReason, "ANCHOR_ORDER_INVALID");
    assert.equal(candidates.length, 1);
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
      assert.equal(calls.length, utilisation < 0.75 || utilisation > 1 ? 1 : 0);
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

  it("orders sub-six-second observations without display rounding", async () => {
    const lower = observation("lower", 0, 20_000);
    lower.actualAddedSeconds = 1_348;
    const nearer = observation("nearer", 0, 21_000);
    nearer.actualAddedSeconds = 1_349;
    const parents: string[] = [];
    const result = await runBoundedDurationRefinement({
      requestedExtraMinutes: 30,
      baselineDurationMinutes: 20,
      attemptsAlreadyUsed: 4,
      observations: [lower, nearer],
      maximumConstructionValue: 30_000,
      construct: async (input) => {
        parents.push(input.parentCandidateId);
        const target = observation("target", 0, input.constructionValue);
        target.actualAddedSeconds = 1_350;
        return evaluated(target);
      },
    });
    assert.deepEqual(parents, ["nearer"]);
    assert.equal(result.reachedTargetBand, true);
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

  it("uses baseline zero and a safe +97.7 upper for deterministic downward refinement", async () => {
    const constructions: number[] = [];
    const unsafeSpur = (candidateId: string, minutes: number, value: number) =>
      observation(candidateId, minutes, value, {
        withinBudget: false,
        routeShapeEligible: false,
        calibrationSafe: false,
      });
    const result = await runBoundedDurationRefinement({
      requestedExtraMinutes: 30,
      baselineDurationMinutes: 367.7,
      attemptsAlreadyUsed: 3,
      observations: [
        unsafeSpur("target-15-spur", 33.5, 6_000),
        unsafeSpur("target-23-spur", 37.7, 8_000),
        observation("target-27-upper", 97.7, 10_000, {
          withinBudget: false,
          qualityEligible: false,
        }),
      ],
      maximumConstructionValue: 70_000,
      construct: async (input) => {
        constructions.push(input.constructionValue);
        return evaluated(
          constructions.length === 1
            ? observation("first-refinement", 35, input.constructionValue, {
                withinBudget: false,
              })
            : observation("selected-refinement", 27, input.constructionValue),
        );
      },
    });
    assert.equal(result.reachedTargetBand, true);
    assert.equal(result.executions.length, 2);
    assert.equal(result.executions[0].strategy, "BASELINE_ZERO_BRACKET");
    assert.equal(result.executions[0].parentCandidateId, "target-27-upper");
    assert.ok(Math.abs(constructions[0] / 10_000 - 27 / 97.7) < 0.001);
    assert.ok(constructions[1] < constructions[0]);
    assert.deepEqual(result.stateCounts, {
      safeConstructionsProduced: 2,
      providerRequestsStarted: 2,
      providerResponsesReturned: 2,
      providerRequestsFailed: 0,
      providerResponsesEvaluated: 2,
    });
  });

  it("separates calibration safety from budget, evidence and score eligibility", () => {
    const safeOverBudget = observation("safe-upper", 97.7, 10_000, {
      withinBudget: false,
      qualityEligible: false,
    });
    const safeScore43 = observation("score-43", 77, 20_000, {
      qualityEligible: false,
    });
    assert.equal(isCalibrationSafeObservation(safeOverBudget), true);
    assert.equal(isCalibrationSafeObservation(safeScore43), true);
    for (const unsafe of [
      { calibrationSafe: false },
      { routeShapeEligible: false },
      { duplicate: true },
      { relatedPlanKey: "" },
      { effectiveWaypointCount: 3 },
    ]) {
      assert.equal(isCalibrationSafeObservation(observation("unsafe", 20, 10_000, unsafe)), false);
    }
  });

  it("uses coherent score-43 calibration for +80, +140 and +180 without selecting it", async () => {
    for (const requestedExtraMinutes of [80, 140, 180]) {
      const constructions: number[] = [];
      const result = await runBoundedDurationRefinement({
        requestedExtraMinutes,
        baselineDurationMinutes: 367.7,
        attemptsAlreadyUsed: 5,
        observations: [
          observation("score-43-lower", 77, 20_000, {
            withinBudget: true,
            qualityEligible: false,
          }),
        ],
        maximumConstructionValue: 70_000,
        construct: async (input) => {
          constructions.push(input.constructionValue);
          return evaluated(
            observation(
              "independently-qualified",
              requestedExtraMinutes * 0.9,
              input.constructionValue,
              { withinBudget: true },
            ),
          );
        },
      });
      assert.equal(result.executions[0].parentCandidateId, "score-43-lower");
      assert.equal(
        result.executions[0].strategy,
        requestedExtraMinutes === 80 ? "BASELINE_ZERO_BRACKET" : "BOUNDED_EXPANSION",
      );
      assert.equal(constructions[0] > 20_000, requestedExtraMinutes !== 80);
      assert.equal(result.reachedTargetBand, true);
    }
  });

  it("chooses the smallest safe upper then the simpler plan deterministically", async () => {
    let selectedParent = "";
    const result = await runBoundedDurationRefinement({
      requestedExtraMinutes: 30,
      baselineDurationMinutes: 300,
      attemptsAlreadyUsed: 5,
      observations: [
        observation("larger", 45, 9_000, { withinBudget: false }),
        observation("two-waypoint", 40, 8_000, {
          withinBudget: false,
          effectiveWaypointCount: 2,
        }),
        observation("one-waypoint", 40, 8_000, { withinBudget: false }),
      ],
      maximumConstructionValue: 70_000,
      construct: async (input) => {
        selectedParent = input.parentCandidateId;
        return evaluated(observation("target", 27, input.constructionValue));
      },
    });
    assert.equal(selectedParent, "one-waypoint");
    assert.equal(result.reachedTargetBand, true);
  });

  it("ranks complete real brackets globally by family before expansion or synthetic zero", async () => {
    const fixtures = [
      observation("family-a-high-lower", 26, 26_000, {
        relatedPlanKey: "family-a",
        qualityEligible: false,
      }),
      observation("family-b-lower", 20, 20_000, {
        relatedPlanKey: "family-b",
        qualityEligible: false,
        requestedRole: {
          targetExtraMinutes: 30,
          waypointForm: "two-waypoint-arc",
          progress: "distributed",
          side: "alternating-arc",
          evidencePreference: "alternate-cluster",
        },
      }),
      observation("family-b-upper", 30, 30_000, {
        relatedPlanKey: "family-b",
        withinBudget: true,
        qualityEligible: false,
      }),
      observation("family-c-lower", 18, 18_000, {
        relatedPlanKey: "family-c",
        qualityEligible: false,
      }),
      observation("family-c-upper", 40, 40_000, {
        relatedPlanKey: "family-c",
        withinBudget: false,
      }),
    ];
    const selections: string[] = [];
    for (const observations of [
      fixtures,
      [...fixtures].reverse(),
      [fixtures[2], fixtures[0], fixtures[4], fixtures[1], fixtures[3]],
    ]) {
      const result = await runBoundedDurationRefinement({
        requestedExtraMinutes: 30,
        baselineDurationMinutes: 300,
        attemptsAlreadyUsed: 5,
        observations,
        maximumConstructionValue: 50_000,
        construct: async (input) => {
          selections.push(
            `${input.relatedPlanKey}:${input.parentCandidateId}:${input.upperCandidateId}`,
          );
          return evaluated(
            observation("target", 27, input.constructionValue, {
              relatedPlanKey: input.relatedPlanKey,
            }),
          );
        },
      });
      assert.equal(result.executions[0].strategy, "RELATED_BRACKET");
      assert.equal(result.reachedTargetBand, true);
    }
    assert.deepEqual(selections, [
      "family-b:family-b-lower:family-b-upper",
      "family-b:family-b-lower:family-b-upper",
      "family-b:family-b-lower:family-b-upper",
    ]);
  });

  it("reports an effective derived collision without counting a provider request", async () => {
    let requests = 0;
    const result = await runBoundedDurationRefinement({
      requestedExtraMinutes: 30,
      baselineDurationMinutes: 300,
      attemptsAlreadyUsed: 3,
      observations: [observation("upper", 97.7, 10_000, { withinBudget: false })],
      maximumConstructionValue: 70_000,
      construct: async () => ({ status: "EFFECTIVE_COLLISION" as const }),
    });
    requests += result.stateCounts.providerRequestsStarted;
    assert.equal(result.stopReason, "NO_DISTINCT_DERIVED_CONSTRUCTION");
    assert.equal(result.attempted, false);
    assert.equal(requests, 0);
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

  it("never makes a seventh request and permits bounded disproportionate short-route refinement", async () => {
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
    assert.notEqual(disproportionate.stopReason, "ATTEMPT_CAPACITY_EXHAUSTED");
    assert.equal(calls, 1);
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
