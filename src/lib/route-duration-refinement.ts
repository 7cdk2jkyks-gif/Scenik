import {
  MIN_TARGET_UTILISATION,
  routesAreMeaningfullyDifferent,
  selectRouteCandidate,
} from "./route-selection";
import {
  classifyDurationTargetResult,
  effectiveRoutePlanSignature,
  type PositiveAllowanceAttemptRole,
  type ScenicCorridorPlan,
} from "./corridor-exploration";
import type { ComputedDirections, GeocodedLocation } from "./google-maps.server";
import { safeAssociateEvidenceWithRoute } from "./route-evidence-association";
import {
  safeEvaluateRouteCoherence,
  safeEvaluateRouteCoherenceWithAnchors,
} from "./route-coherence";
import { scoreScenicRoute } from "./scenic-score";
import {
  candidateFitsTimeBudget,
  haversineDistanceMeters,
  type LatLng,
  type ScenicPlace,
  type ScenicWaypointPlan,
} from "./scenic-waypoint";

export const MAX_SCENIC_ROUTE_ATTEMPTS = 6;
export const MAX_DURATION_REFINEMENT_ATTEMPTS = 2;
export const REFINEMENT_TARGET_UTILISATION = 0.9;
export const MAX_UNBRACKETED_EXPANSION_RATIO = 1.6;
/** Maximum outward movement from a verified source point. This is deliberately
 * below the existing 3.5 km ordinary-search radius; it shapes the route but
 * cannot turn refinement into a new evidence search. */
export const MAX_DERIVED_WAYPOINT_DISPLACEMENT_FROM_SOURCE_METERS = 2_500;
export const MIN_UNAMBIGUOUS_CORRIDOR_OFFSET_METERS = 50;
export const DERIVED_MOVEMENT_NUMERICAL_EPSILON_METERS = 0.01;
const MIN_SEGMENT_PROGRESS = 0.05;
const MAX_SEGMENT_PROGRESS = 0.95;
export const MIN_DERIVED_WAYPOINT_SEPARATION_METERS = 1_000;

export type DurationRefinementStrategy =
  | "RELATED_BRACKET"
  | "BASELINE_ZERO_BRACKET"
  | "BOUNDED_EXPANSION";
export type DurationRefinementStopReason =
  | "TARGET_REACHED"
  | "PROVIDER_REMAINED_BELOW_TARGET"
  | "NO_SAFE_REFINEMENT_BRACKET"
  | "NO_CALIBRATION_LOWER_BOUND"
  | "NO_SAFE_CALIBRATION_UPPER"
  | "NO_RELATED_PLAN_FAMILY"
  | "NO_DISTINCT_DERIVED_CONSTRUCTION"
  | "NO_CONSTRUCTION_HEADROOM"
  | "PROVIDER_REQUEST_FAILED"
  | "PROVIDER_RESPONSE_REJECTED"
  | "PROVIDER_EVALUATION_FAILED"
  | "REFINED_CANDIDATES_OVER_BUDGET"
  | "REFINED_CANDIDATES_INCOHERENT"
  | "ATTEMPT_CAPACITY_EXHAUSTED";

export type DurationConstructionObservation = {
  candidateId: string;
  relatedPlanKey: string;
  actualAddedSeconds: number;
  constructionValue: number;
  withinBudget: boolean;
  routeShapeEligible: boolean;
  duplicate: boolean;
  qualityEligible: boolean;
  calibrationSafe: boolean;
  intendedTargetSeconds: number | null;
  constructionTargetSeconds: number | null;
  adaptiveTargetSeconds: number | null;
  requestedRole: PositiveAllowanceAttemptRole | null;
  effectiveConstruction: EffectiveConstructionMetadata | null;
  effectiveWaypointCount: number;
};

export type EffectiveConstructionMetadata = {
  waypointForm: "one-waypoint" | "two-waypoint-arc";
  insertionPositions: number[];
  progress: "early" | "middle" | "late" | "distributed";
  orientation: "left" | "right" | "alternating-mixed";
};

export type RequestLocalPlanFamily = {
  familyId: string;
  structuralKey: string;
  sourcePlan: ScenicCorridorPlan;
  sourceWaypointIds: string[];
  insertionTopology: number[];
  anchors: LatLng[];
  origin: LatLng;
  destination: LatLng;
  requiredStops: LatLng[];
  sourceDisplacementMeters: number;
  currentDisplacementMeters: number;
};

function finiteCoordinate(point: LatLng): boolean {
  return (
    Number.isFinite(point.lat) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    Number.isFinite(point.lng) &&
    point.lng >= -180 &&
    point.lng <= 180
  );
}

function wrappedLongitudeDelta(from: number, to: number): number {
  return ((((to - from + 540) % 360) + 360) % 360) - 180;
}

function normaliseLongitude(value: number): number {
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

type CorridorProjection = {
  progress: number;
  signedOffsetMeters: number;
  projectedEastMeters: number;
  projectedNorthMeters: number;
  unitNormalEast: number;
  unitNormalNorth: number;
  reference: LatLng;
  longitudeMetersPerDegree: number;
};

function corridorProjection(segmentStart: LatLng, segmentEnd: LatLng, point: LatLng) {
  if (![segmentStart, segmentEnd, point].every(finiteCoordinate)) return null;
  const referenceLatitude = (segmentStart.lat + segmentEnd.lat) / 2;
  const longitudeMetersPerDegree = 111_320 * Math.cos((referenceLatitude * Math.PI) / 180);
  if (!Number.isFinite(longitudeMetersPerDegree) || Math.abs(longitudeMetersPerDegree) < 1_000)
    return null;
  const east = wrappedLongitudeDelta(segmentStart.lng, segmentEnd.lng) * longitudeMetersPerDegree;
  const north = (segmentEnd.lat - segmentStart.lat) * 111_320;
  const pointEast = wrappedLongitudeDelta(segmentStart.lng, point.lng) * longitudeMetersPerDegree;
  const pointNorth = (point.lat - segmentStart.lat) * 111_320;
  const squaredLength = east * east + north * north;
  if (!Number.isFinite(squaredLength) || squaredLength < 100 * 100) return null;
  const progress = (pointEast * east + pointNorth * north) / squaredLength;
  if (
    !Number.isFinite(progress) ||
    progress < MIN_SEGMENT_PROGRESS ||
    progress > MAX_SEGMENT_PROGRESS
  )
    return null;
  const projectedEastMeters = east * progress;
  const projectedNorthMeters = north * progress;
  const length = Math.sqrt(squaredLength);
  const unitNormalEast = -north / length;
  const unitNormalNorth = east / length;
  const signedOffsetMeters =
    (pointEast - projectedEastMeters) * unitNormalEast +
    (pointNorth - projectedNorthMeters) * unitNormalNorth;
  if (
    !Number.isFinite(signedOffsetMeters) ||
    Math.abs(signedOffsetMeters) < MIN_UNAMBIGUOUS_CORRIDOR_OFFSET_METERS
  )
    return null;
  return {
    progress,
    signedOffsetMeters,
    projectedEastMeters,
    projectedNorthMeters,
    unitNormalEast,
    unitNormalNorth,
    reference: segmentStart,
    longitudeMetersPerDegree,
  } satisfies CorridorProjection;
}

export function planFamilyStructuralKey(input: {
  origin: LatLng;
  destination: LatLng;
  requiredStops: LatLng[];
  sourceWaypointIds: string[];
  plan: ScenicCorridorPlan;
}): string | null {
  if (
    ![input.origin, input.destination, ...input.requiredStops].every(finiteCoordinate) ||
    input.plan.waypoints.length === 0 ||
    input.plan.waypoints.length > 2 ||
    input.sourceWaypointIds.length !== input.plan.waypoints.length ||
    new Set(input.sourceWaypointIds).size !== input.sourceWaypointIds.length ||
    input.sourceWaypointIds.some((id) => !/^evidence-\d+$/.test(id))
  )
    return null;
  return JSON.stringify({
    origin: input.origin,
    destination: input.destination,
    requiredStops: input.requiredStops,
    sourceWaypointIds: input.sourceWaypointIds,
    insertionTopology: input.plan.waypoints.map((waypoint) => waypoint.insertionIndex),
    kind: input.plan.kind,
    waypointCount: input.plan.waypoints.length,
    constructionParameter: "corridor-lateral-displacement-meters",
  });
}

function waypointDisplacement(waypoint: ScenicWaypointPlan, anchors: LatLng[]): number | null {
  const start = anchors[waypoint.insertionIndex];
  const end = anchors[waypoint.insertionIndex + 1];
  if (!start || !end) return null;
  const projection = corridorProjection(start, end, waypoint);
  return projection ? Math.abs(projection.signedOffsetMeters) : null;
}

export function effectiveConstructionMetadata(
  plan: ScenicCorridorPlan,
  anchors: LatLng[],
): EffectiveConstructionMetadata | null {
  if (plan.waypoints.length < 1 || plan.waypoints.length > 2) return null;
  if (plan.waypoints.length === 2 && !hasSafeDerivedWaypointSeparation(plan.waypoints)) return null;
  const sides = plan.waypoints.map((waypoint) => {
    const start = anchors[waypoint.insertionIndex];
    const end = anchors[waypoint.insertionIndex + 1];
    if (!start || !end || !finiteCoordinate(waypoint)) return null;
    const radians = (value: number) => (value * Math.PI) / 180;
    const angularDistance = haversineDistanceMeters(start, waypoint) / 6_371_008.8;
    const bearing = (from: LatLng, to: LatLng) => {
      const fromLatitude = radians(from.lat);
      const toLatitude = radians(to.lat);
      const longitudeDelta = radians(wrappedLongitudeDelta(from.lng, to.lng));
      return Math.atan2(
        Math.sin(longitudeDelta) * Math.cos(toLatitude),
        Math.cos(fromLatitude) * Math.sin(toLatitude) -
          Math.sin(fromLatitude) * Math.cos(toLatitude) * Math.cos(longitudeDelta),
      );
    };
    if (haversineDistanceMeters(start, end) < 100) return null;
    const signedCrossTrackMeters =
      -Math.asin(
        Math.max(
          -1,
          Math.min(
            1,
            Math.sin(angularDistance) * Math.sin(bearing(start, waypoint) - bearing(start, end)),
          ),
        ),
      ) * 6_371_008.8;
    return Number.isFinite(signedCrossTrackMeters) &&
      Math.abs(signedCrossTrackMeters) >= MIN_UNAMBIGUOUS_CORRIDOR_OFFSET_METERS
      ? Math.sign(signedCrossTrackMeters)
      : null;
  });
  if (sides.some((side) => side == null)) return null;
  const insertionPositions = plan.waypoints.map((waypoint) => waypoint.insertionIndex);
  const progressValues = insertionPositions.map(
    (position) => (position + 0.5) / Math.max(1, anchors.length - 1),
  );
  const progress =
    Math.min(...progressValues) < 0.5 && Math.max(...progressValues) > 0.5
      ? "distributed"
      : progressValues.every((value) => value >= 0.25 && value <= 0.75)
        ? "middle"
        : progressValues.every((value) => value <= 0.5)
          ? "early"
          : "late";
  const signs = sides as number[];
  const orientation = signs.every((sign) => sign > 0)
    ? "left"
    : signs.every((sign) => sign < 0)
      ? "right"
      : "alternating-mixed";
  return {
    waypointForm: plan.waypoints.length === 1 ? "one-waypoint" : "two-waypoint-arc",
    insertionPositions,
    progress,
    orientation,
  };
}

export function hasSafeDerivedWaypointSeparation(waypoints: ScenicWaypointPlan[]): boolean {
  if (waypoints.length !== 2) return waypoints.length === 1;
  const separation = haversineDistanceMeters(waypoints[0], waypoints[1]);
  return Number.isFinite(separation) && separation >= MIN_DERIVED_WAYPOINT_SEPARATION_METERS;
}

export function createRequestLocalPlanFamily(input: {
  familyId: string;
  origin: LatLng;
  destination: LatLng;
  requiredStops: LatLng[];
  anchors: LatLng[];
  sourceWaypointIds: string[];
  plan: ScenicCorridorPlan;
}): RequestLocalPlanFamily | null {
  const structuralKey = planFamilyStructuralKey(input);
  if (!structuralKey || !/^family-\d+$/.test(input.familyId)) return null;
  const displacements = input.plan.waypoints.map((waypoint) =>
    waypointDisplacement(waypoint, input.anchors),
  );
  if (displacements.some((value) => value == null || !finitePositive(value))) return null;
  return {
    familyId: input.familyId,
    structuralKey,
    sourcePlan: {
      ...input.plan,
      waypoints: input.plan.waypoints.map((waypoint) => ({ ...waypoint })),
    },
    sourceWaypointIds: [...input.sourceWaypointIds],
    insertionTopology: input.plan.waypoints.map((waypoint) => waypoint.insertionIndex),
    anchors: input.anchors.map((anchor) => ({ ...anchor })),
    origin: { ...input.origin },
    destination: { ...input.destination },
    requiredStops: input.requiredStops.map((stop) => ({ ...stop })),
    sourceDisplacementMeters: Math.max(...(displacements as number[])),
    currentDisplacementMeters: Math.max(...(displacements as number[])),
  };
}

export function deriveRouteShapingPlan(
  family: RequestLocalPlanFamily,
  targetDisplacementMeters: number,
): ScenicCorridorPlan | null {
  const movingInward = targetDisplacementMeters < family.currentDisplacementMeters;
  if (
    !finitePositive(targetDisplacementMeters) ||
    targetDisplacementMeters === family.currentDisplacementMeters ||
    targetDisplacementMeters > 70_000 ||
    (!movingInward &&
      targetDisplacementMeters - family.sourceDisplacementMeters >
        MAX_DERIVED_WAYPOINT_DISPLACEMENT_FROM_SOURCE_METERS) ||
    family.sourcePlan.waypoints.length !== family.sourceWaypointIds.length ||
    planFamilyStructuralKey({
      origin: family.origin,
      destination: family.destination,
      requiredStops: family.requiredStops,
      sourceWaypointIds: family.sourceWaypointIds,
      plan: family.sourcePlan,
    }) !== family.structuralKey
  )
    return null;
  const waypoints = family.sourcePlan.waypoints.map((source) => {
    const start = family.anchors[source.insertionIndex];
    const end = family.anchors[source.insertionIndex + 1];
    if (!start || !end) return null;
    const projection = corridorProjection(start, end, source);
    if (!projection) return null;
    const sourceOffset = Math.abs(projection.signedOffsetMeters);
    const derivedOffset = movingInward
      ? sourceOffset * (targetDisplacementMeters / family.currentDisplacementMeters)
      : sourceOffset + (targetDisplacementMeters - family.sourceDisplacementMeters);
    if (!Number.isFinite(derivedOffset) || derivedOffset < MIN_UNAMBIGUOUS_CORRIDOR_OFFSET_METERS)
      return null;
    const sign = Math.sign(projection.signedOffsetMeters);
    const east = projection.projectedEastMeters + projection.unitNormalEast * derivedOffset * sign;
    const north =
      projection.projectedNorthMeters + projection.unitNormalNorth * derivedOffset * sign;
    const coordinate = {
      lat: projection.reference.lat + north / 111_320,
      lng: normaliseLongitude(
        projection.reference.lng + east / projection.longitudeMetersPerDegree,
      ),
    };
    if (!finiteCoordinate(coordinate)) return null;
    const physicalMovementMeters = haversineDistanceMeters(source, coordinate);
    if (!Number.isFinite(physicalMovementMeters) || physicalMovementMeters < 50) return null;
    if (
      !movingInward &&
      physicalMovementMeters >
        MAX_DERIVED_WAYPOINT_DISPLACEMENT_FROM_SOURCE_METERS +
          DERIVED_MOVEMENT_NUMERICAL_EPSILON_METERS
    )
      return null;
    return {
      ...source,
      lat: coordinate.lat,
      lng: coordinate.lng,
      // This is construction metadata only. It is never used as evidence.
      estimatedDetourMeters: targetDisplacementMeters,
    };
  });
  if (waypoints.some((waypoint) => waypoint == null)) return null;
  if (!hasSafeDerivedWaypointSeparation(waypoints as ScenicWaypointPlan[])) return null;
  const derived = {
    ...family.sourcePlan,
    waypoints: waypoints as ScenicWaypointPlan[],
    estimatedDetourMeters: targetDisplacementMeters,
    signature: "",
  };
  derived.signature = effectiveRoutePlanSignature(derived, family.anchors);
  return derived;
}

/** Production-used boundary: construction failure occurs before `request` and
 * therefore cannot consume or be reported as a provider request. */
export type DerivedProviderResult<TObservation> =
  | { status: "NO_SAFE_CONSTRUCTION"; providerRequested: false; observation: null }
  | { status: "EFFECTIVE_COLLISION"; providerRequested: false; observation: null }
  | { status: "PROVIDER_REQUEST_FAILED"; providerRequested: true; observation: null }
  | { status: "PROVIDER_RESPONSE_REJECTED"; providerRequested: true; observation: null }
  | { status: "PROVIDER_EVALUATION_FAILED"; providerRequested: true; observation: null }
  | {
      status: "PROVIDER_RESPONSE_EVALUATED";
      providerRequested: true;
      observation: TObservation;
    };

export async function executeDerivedRouteRequest<TProviderResult, TObservation>(input: {
  family: RequestLocalPlanFamily;
  targetDisplacementMeters: number;
  request(plan: ScenicCorridorPlan): Promise<TProviderResult>;
  isEffectiveCollision?(plan: ScenicCorridorPlan): boolean;
  evaluate(
    plan: ScenicCorridorPlan,
    result: PromiseSettledResult<TProviderResult>,
  ): Promise<TObservation | null> | TObservation | null;
}): Promise<DerivedProviderResult<TObservation>> {
  const plan = deriveRouteShapingPlan(input.family, input.targetDisplacementMeters);
  if (!plan || !isSafeRefinementCorridorPlan(plan)) {
    return { status: "NO_SAFE_CONSTRUCTION", providerRequested: false, observation: null };
  }
  if (input.isEffectiveCollision?.(plan)) {
    return { status: "EFFECTIVE_COLLISION", providerRequested: false, observation: null };
  }
  const [result] = await Promise.allSettled([input.request(plan)]);
  if (result.status === "rejected") {
    return { status: "PROVIDER_REQUEST_FAILED", providerRequested: true, observation: null };
  }
  let observation: TObservation | null;
  try {
    observation = await input.evaluate(plan, result);
  } catch {
    return { status: "PROVIDER_EVALUATION_FAILED", providerRequested: true, observation: null };
  }
  if (observation == null) {
    return { status: "PROVIDER_RESPONSE_REJECTED", providerRequested: true, observation: null };
  }
  return {
    status: "PROVIDER_RESPONSE_EVALUATED",
    providerRequested: true,
    observation,
  };
}

export type RefinementCandidateLineage = {
  parentCandidateId: string;
  familyId: string;
  attemptNumber: number;
};

export type RouteCandidateForFinalScoring = {
  candidateId: string;
  explorationStage: number | null;
  directions: ComputedDirections;
  source: "fastest" | "google" | "scenik";
  selectedWaypointReason: string | null;
  intendedAddedMinutes: number | null;
  constructionTargetMinutes: number | null;
  durationTargetClassification:
    | "SEVERE_UNDERSHOOT"
    | "MODERATE_UNDERSHOOT"
    | "TARGET_BAND"
    | "OVER_BUDGET"
    | null;
  scenicWaypoints: ScenicWaypointPlan[];
  routeShapeEligible: boolean;
  requestedRole?: PositiveAllowanceAttemptRole | null;
  effectiveConstruction?: EffectiveConstructionMetadata | null;
  refinementLineage?: RefinementCandidateLineage;
};

/** Fixed server-side recording boundary shared by Production and its executable
 * fixture. It derives every eligibility field from provider output and inserts
 * no candidate unless the normal budget/duplicate/coherence gates pass. */
export function recordRefinedProviderCandidate(input: {
  candidates: RouteCandidateForFinalScoring[];
  candidateId: string;
  parentCandidateId: string;
  familyId: string;
  attemptNumber: number;
  explorationStage: number | null;
  directions: ComputedDirections;
  shapingPlan: ScenicCorridorPlan;
  evidencePlaces: ScenicPlace[];
  start: GeocodedLocation;
  end: GeocodedLocation;
  mood: string;
  theme: string;
  requestedExtraMinutes: number;
  requiredStopCount: number;
  expectedAnchors?: LatLng[];
  constructionAnchors?: LatLng[];
  intendedAddedMinutes: number;
  constructionTargetMinutes: number;
}) {
  const baseline = input.candidates[0]?.directions;
  if (!baseline) throw new Error("BASELINE_ROUTE_UNAVAILABLE");
  const evaluation = evaluateRefinedProviderCandidate({
    baseline,
    directions: input.directions,
    priorDirections: input.candidates.map((candidate) => candidate.directions),
    shapingPlan: input.shapingPlan,
    evidencePlaces: input.evidencePlaces,
    start: input.start,
    end: input.end,
    mood: input.mood,
    theme: input.theme,
    requestedExtraMinutes: input.requestedExtraMinutes,
    requiredStopCount: input.requiredStopCount,
    expectedAnchors: input.expectedAnchors,
  });
  const actualAddedSeconds = Math.max(
    0,
    input.directions.durationSeconds - baseline.durationSeconds,
  );
  const actualAddedMinutes = actualAddedSeconds / 60;
  const durationTargetClassification = Number.isFinite(actualAddedSeconds)
    ? classifyDurationTargetResult(
        input.requestedExtraMinutes,
        actualAddedMinutes,
        input.requestedExtraMinutes,
      )
    : null;
  const evidenceStrength = Object.values(evaluation.evidenceAssociation.evidence).reduce(
    (sum, count) => sum + count,
    0,
  );
  const qualityEligible = evaluation.scoreResult.total >= 60 && evidenceStrength > 0;
  const inserted =
    evaluation.withinBudget &&
    evaluation.meaningfullyDifferent &&
    evaluation.routeShape.routeShapeEligible;
  if (inserted) {
    input.candidates.push({
      candidateId: input.candidateId,
      explorationStage: input.explorationStage,
      directions: input.directions,
      source: "scenik",
      selectedWaypointReason: null,
      intendedAddedMinutes: input.intendedAddedMinutes,
      constructionTargetMinutes: input.constructionTargetMinutes,
      durationTargetClassification,
      scenicWaypoints: [],
      routeShapeEligible: true,
      requestedRole: null,
      effectiveConstruction: effectiveConstructionMetadata(
        input.shapingPlan,
        input.constructionAnchors ?? [input.start, input.end],
      ),
      refinementLineage: {
        parentCandidateId: input.parentCandidateId,
        familyId: input.familyId,
        attemptNumber: input.attemptNumber,
      },
    });
  }
  const observation: DurationConstructionObservation = {
    candidateId: input.candidateId,
    relatedPlanKey: input.familyId,
    actualAddedSeconds,
    constructionValue: input.shapingPlan.estimatedDetourMeters,
    withinBudget: evaluation.withinBudget,
    routeShapeEligible: evaluation.routeShape.routeShapeEligible,
    duplicate: !evaluation.meaningfullyDifferent,
    qualityEligible,
    calibrationSafe:
      Number.isFinite(actualAddedSeconds) &&
      actualAddedSeconds > 0 &&
      evaluation.routeShape.routeShapeEligible &&
      evaluation.meaningfullyDifferent,
    intendedTargetSeconds: input.intendedAddedMinutes * 60,
    constructionTargetSeconds: input.constructionTargetMinutes * 60,
    adaptiveTargetSeconds: input.constructionTargetMinutes * 60,
    requestedRole: null,
    effectiveConstruction: effectiveConstructionMetadata(
      input.shapingPlan,
      input.constructionAnchors ?? [input.start, input.end],
    ),
    effectiveWaypointCount: input.shapingPlan.waypoints.length,
  };
  return { evaluation, inserted, observation, durationTargetClassification };
}

/** Normal final evidence/scoring pass used immediately before Production route
 * selection. Derived shaping coordinates are absent from refined candidates. */
export function scoreAndSelectRouteCandidateCollection(input: {
  candidates: RouteCandidateForFinalScoring[];
  evidencePlaces: ScenicPlace[];
  start: GeocodedLocation;
  end: GeocodedLocation;
  mood: string;
  theme: string;
  requestedExtraMinutes: number;
  requiredStopCount: number;
  expectedAnchors?: LatLng[];
}) {
  const baseline = input.candidates[0]?.directions;
  if (!baseline) throw new Error("BASELINE_ROUTE_UNAVAILABLE");
  const failedCandidateIds: string[] = [];
  const scoredCandidates = input.candidates.flatMap((candidate, originalIndex) => {
    if (originalIndex !== 0 && !candidate.routeShapeEligible) return [];
    try {
      const evidenceAssociation = safeAssociateEvidenceWithRoute({
        encodedPolyline: candidate.directions.encodedPolyline,
        places: input.evidencePlaces,
        waypoints: candidate.scenicWaypoints,
        proximityMeters: 750,
      });
      const scoreResult = scoreScenicRoute({
        start: input.start,
        end: input.end,
        mood: input.mood,
        theme: input.theme,
        extraMinutes: input.requestedExtraMinutes,
        stopCount: input.requiredStopCount + candidate.scenicWaypoints.length,
        directions: candidate.directions,
        evidence: evidenceAssociation.evidence,
        fastestDurationSeconds: baseline.durationSeconds,
      });
      return [
        {
          ...candidate,
          score: scoreResult.total,
          scoreResult,
          originalIndex,
          evidence: evidenceAssociation.evidence,
          evidenceAssociation,
        },
      ];
    } catch {
      if (originalIndex === 0) throw new Error("SCORING_FAILED");
      failedCandidateIds.push(candidate.candidateId);
      return [];
    }
  });
  return {
    scoredCandidates,
    selection: selectRouteCandidate(scoredCandidates, input.requestedExtraMinutes),
    failedCandidateIds,
  };
}

/** Shared by Production and the executable orchestration fixture. Derived
 * shaping points participate in coherence only; evidence is associated solely
 * with returned travelled geometry. */
export function evaluateRefinedProviderCandidate(input: {
  baseline: ComputedDirections;
  directions: ComputedDirections;
  priorDirections: ComputedDirections[];
  shapingPlan: ScenicCorridorPlan;
  evidencePlaces: ScenicPlace[];
  start: GeocodedLocation;
  end: GeocodedLocation;
  mood: string;
  theme: string;
  requestedExtraMinutes: number;
  requiredStopCount: number;
  expectedAnchors?: LatLng[];
}) {
  const withinBudget = candidateFitsTimeBudget(
    input.baseline.durationSeconds,
    input.directions.durationSeconds,
    input.requestedExtraMinutes,
  );
  const meaningfullyDifferent = input.priorDirections.every((prior) =>
    routesAreMeaningfullyDifferent(prior, input.directions),
  );
  const routeShape = input.expectedAnchors
    ? safeEvaluateRouteCoherenceWithAnchors(
        input.directions.encodedPolyline,
        input.shapingPlan.waypoints,
        input.expectedAnchors,
      )
    : safeEvaluateRouteCoherence(input.directions.encodedPolyline, input.shapingPlan.waypoints);
  const evidenceAssociation = safeAssociateEvidenceWithRoute({
    encodedPolyline: input.directions.encodedPolyline,
    places: input.evidencePlaces,
    waypoints: [],
    proximityMeters: 750,
  });
  const scoreResult = scoreScenicRoute({
    start: input.start,
    end: input.end,
    mood: input.mood,
    theme: input.theme,
    extraMinutes: input.requestedExtraMinutes,
    stopCount: input.requiredStopCount,
    directions: input.directions,
    evidence: evidenceAssociation.evidence,
    fastestDurationSeconds: input.baseline.durationSeconds,
  });
  return {
    withinBudget,
    meaningfullyDifferent,
    routeShape,
    evidenceAssociation,
    scoreResult,
  };
}

type RelatedRefinementCandidate = {
  candidateId: string;
  family: RequestLocalPlanFamily;
};

function observationFromRelatedCandidate(input: {
  related: RelatedRefinementCandidate;
  candidates: RouteCandidateForFinalScoring[];
  evidencePlaces: ScenicPlace[];
  start: GeocodedLocation;
  end: GeocodedLocation;
  mood: string;
  theme: string;
  requestedExtraMinutes: number;
  requiredStopCount: number;
}): DurationConstructionObservation | null {
  const candidate = input.candidates.find(
    ({ candidateId }) => candidateId === input.related.candidateId,
  );
  const baseline = input.candidates[0]?.directions;
  if (!candidate || !baseline) return null;
  const evaluation = evaluateRefinedProviderCandidate({
    baseline,
    directions: candidate.directions,
    priorDirections: input.candidates
      .filter(({ candidateId }) => candidateId !== candidate.candidateId)
      .map(({ directions }) => directions),
    shapingPlan: input.related.family.sourcePlan,
    evidencePlaces: input.evidencePlaces,
    start: input.start,
    end: input.end,
    mood: input.mood,
    theme: input.theme,
    requestedExtraMinutes: input.requestedExtraMinutes,
    requiredStopCount: input.requiredStopCount,
  });
  const evidenceStrength = Object.values(evaluation.evidenceAssociation.evidence).reduce(
    (sum, count) => sum + count,
    0,
  );
  return {
    candidateId: candidate.candidateId,
    relatedPlanKey: input.related.family.familyId,
    actualAddedSeconds: Math.max(
      0,
      candidate.directions.durationSeconds - baseline.durationSeconds,
    ),
    constructionValue: input.related.family.currentDisplacementMeters,
    withinBudget: evaluation.withinBudget,
    routeShapeEligible: evaluation.routeShape.routeShapeEligible,
    duplicate: !evaluation.meaningfullyDifferent,
    qualityEligible: evaluation.scoreResult.total >= 60 && evidenceStrength > 0,
    calibrationSafe:
      Number.isFinite(candidate.directions.durationSeconds) &&
      candidate.directions.durationSeconds > baseline.durationSeconds &&
      evaluation.routeShape.routeShapeEligible &&
      evaluation.meaningfullyDifferent,
    intendedTargetSeconds:
      candidate.intendedAddedMinutes == null ? null : candidate.intendedAddedMinutes * 60,
    constructionTargetSeconds:
      candidate.constructionTargetMinutes == null ? null : candidate.constructionTargetMinutes * 60,
    adaptiveTargetSeconds: null,
    requestedRole: candidate.requestedRole ?? null,
    effectiveConstruction:
      candidate.effectiveConstruction ??
      effectiveConstructionMetadata(input.related.family.sourcePlan, input.related.family.anchors),
    effectiveWaypointCount: input.related.family.sourcePlan.waypoints.length,
  };
}

/** Server-owned Production orchestration for the complete refinement path. */
export async function orchestrateDurationRefinement(input: {
  candidates: RouteCandidateForFinalScoring[];
  relatedCandidates: RelatedRefinementCandidate[];
  existingObservations?: DurationConstructionObservation[];
  evidencePlaces: ScenicPlace[];
  start: GeocodedLocation;
  end: GeocodedLocation;
  mood: string;
  theme: string;
  requestedExtraMinutes: number;
  requiredStopCount: number;
  attemptsAlreadyUsed: number;
  maximumConstructionValue: number;
  explorationStage: number | null;
  request(
    plan: ScenicCorridorPlan,
    family: RequestLocalPlanFamily,
  ): {
    candidateId: string;
    response: Promise<ComputedDirections>;
    expectedAnchors?: LatLng[];
  };
  isEffectiveCollision?(plan: ScenicCorridorPlan): boolean;
  onRecorded?(input: {
    plan: ScenicCorridorPlan;
    result: PromiseSettledResult<ComputedDirections>;
    candidateId: string;
    family: RequestLocalPlanFamily;
    refinement: {
      parentCandidateId: string;
      upperCandidateId: string | null;
      attemptNumber: number;
      strategy: DurationRefinementStrategy;
      bracketLowerMinutes: number;
      bracketUpperMinutes: number | null;
      intendedTargetMinutes: number;
      adaptiveTargetMinutes: number;
    };
    recording: ReturnType<typeof recordRefinedProviderCandidate> | null;
  }): void;
  onProviderRejected?(input: {
    plan: ScenicCorridorPlan;
    candidateId: string;
    family: RequestLocalPlanFamily;
    refinement: {
      parentCandidateId: string;
      upperCandidateId: string | null;
      attemptNumber: number;
      strategy: DurationRefinementStrategy;
      bracketLowerMinutes: number;
      bracketUpperMinutes: number | null;
      intendedTargetMinutes: number;
      adaptiveTargetMinutes: number;
    };
  }): void;
}) {
  const initialPass = scoreAndSelectRouteCandidateCollection(input);
  let controllerInvocations = 0;
  const derivedObservations = input.relatedCandidates.flatMap((related) => {
    const observation = observationFromRelatedCandidate({ ...input, related });
    return observation ? [observation] : [];
  });
  const observations = input.existingObservations ?? derivedObservations;
  const controller = await runBoundedDurationRefinement({
    requestedExtraMinutes: input.requestedExtraMinutes,
    baselineDurationMinutes: input.candidates[0].directions.durationSeconds / 60,
    attemptsAlreadyUsed: input.attemptsAlreadyUsed,
    observations,
    maximumConstructionValue: input.maximumConstructionValue,
    construct: async (refinement) => {
      controllerInvocations += 1;
      const related = input.relatedCandidates.find(
        ({ family }) => family.familyId === refinement.relatedPlanKey,
      );
      if (!related) return { status: "NO_RELATED_PLAN_FAMILY" as const };
      let requestedCandidateId: string | null = null;
      let requestedExpectedAnchors: LatLng[] | undefined;
      const execution = await executeDerivedRouteRequest({
        family: related.family,
        targetDisplacementMeters: refinement.constructionValue,
        isEffectiveCollision: input.isEffectiveCollision,
        request: (plan) => {
          const requested = input.request(plan, related.family);
          requestedCandidateId = requested.candidateId;
          requestedExpectedAnchors = requested.expectedAnchors;
          return requested.response.catch((error: unknown) => {
            input.onProviderRejected?.({
              plan,
              candidateId: requested.candidateId,
              family: related.family,
              refinement,
            });
            throw error;
          });
        },
        evaluate: (plan, result) => {
          if (!requestedCandidateId || result.status !== "fulfilled") return null;
          if (
            !Number.isFinite(result.value.durationSeconds) ||
            typeof result.value.encodedPolyline !== "string" ||
            result.value.encodedPolyline.length === 0
          )
            return null;
          const recording = recordRefinedProviderCandidate({
            candidates: input.candidates,
            candidateId: requestedCandidateId,
            parentCandidateId: refinement.parentCandidateId,
            familyId: related.family.familyId,
            attemptNumber: refinement.attemptNumber,
            explorationStage: input.explorationStage,
            directions: result.value,
            shapingPlan: plan,
            evidencePlaces: input.evidencePlaces,
            start: input.start,
            end: input.end,
            mood: input.mood,
            theme: input.theme,
            requestedExtraMinutes: input.requestedExtraMinutes,
            requiredStopCount: input.requiredStopCount,
            expectedAnchors: requestedExpectedAnchors,
            constructionAnchors: related.family.anchors,
            intendedAddedMinutes: refinement.intendedTargetMinutes,
            constructionTargetMinutes: refinement.adaptiveTargetMinutes,
          });
          input.onRecorded?.({
            plan,
            result,
            candidateId: requestedCandidateId,
            family: related.family,
            refinement,
            recording,
          });
          return recording.observation;
        },
      });
      if (execution.status === "NO_SAFE_CONSTRUCTION") return execution;
      if (execution.status === "EFFECTIVE_COLLISION") return execution;
      if (execution.status === "PROVIDER_REQUEST_FAILED") return execution;
      if (execution.status === "PROVIDER_RESPONSE_REJECTED") return execution;
      if (execution.status === "PROVIDER_EVALUATION_FAILED") return execution;
      return { status: execution.status, observation: execution.observation };
    },
  });
  return {
    initialPass,
    finalPassWithoutRecordedCandidates: initialPass,
    controller,
    controllerInvocations,
    finalPass: scoreAndSelectRouteCandidateCollection(input),
  };
}

export type DurationRefinementExecution = {
  observation: DurationConstructionObservation | null;
  strategy: DurationRefinementStrategy;
  attemptNumber: number;
  parentCandidateId: string;
  upperCandidateId: string | null;
  intendedTargetMinutes: number;
  adaptiveTargetMinutes: number;
  bracketLowerMinutes: number;
  bracketUpperMinutes: number | null;
  constructionValue: number;
  providerResult:
    | "PROVIDER_REQUEST_FAILED"
    | "PROVIDER_RESPONSE_REJECTED"
    | "PROVIDER_EVALUATION_FAILED"
    | "PROVIDER_RESPONSE_EVALUATED";
};

export type DurationRefinementConstructionResult =
  | { status: "NO_RELATED_PLAN_FAMILY" }
  | { status: "NO_SAFE_CONSTRUCTION" }
  | { status: "EFFECTIVE_COLLISION" }
  | { status: "PROVIDER_REQUEST_FAILED" }
  | { status: "PROVIDER_RESPONSE_REJECTED" }
  | { status: "PROVIDER_EVALUATION_FAILED" }
  | { status: "PROVIDER_RESPONSE_EVALUATED"; observation: DurationConstructionObservation };

export type DurationRefinementResult = {
  attempted: boolean;
  reachedTargetBand: boolean;
  stopReason: DurationRefinementStopReason;
  executions: DurationRefinementExecution[];
  stateCounts: DurationRefinementStateCounts;
};

export type DurationRefinementStateCounts = {
  safeConstructionsProduced: number;
  providerRequestsStarted: number;
  providerResponsesReturned: number;
  providerRequestsFailed: number;
  providerResponsesEvaluated: number;
};

function refinementStateCounts(
  executions: DurationRefinementExecution[],
): DurationRefinementStateCounts {
  const failed = executions.filter(
    (execution) => execution.providerResult === "PROVIDER_REQUEST_FAILED",
  ).length;
  const evaluationFailed = executions.filter(
    (execution) => execution.providerResult === "PROVIDER_EVALUATION_FAILED",
  ).length;
  const evaluated = executions.length - failed - evaluationFailed;
  return {
    safeConstructionsProduced: executions.length,
    providerRequestsStarted: executions.length,
    providerResponsesReturned: evaluated + evaluationFailed,
    providerRequestsFailed: failed,
    providerResponsesEvaluated: evaluated,
  };
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function isSafeRefinementCorridorPlan(plan: ScenicCorridorPlan): boolean {
  return (
    finitePositive(plan.estimatedDetourMeters) &&
    plan.waypoints.length > 0 &&
    plan.waypoints.length <= 2 &&
    plan.waypoints.every(
      (waypoint) =>
        Number.isFinite(waypoint.lat) &&
        waypoint.lat >= -90 &&
        waypoint.lat <= 90 &&
        Number.isFinite(waypoint.lng) &&
        waypoint.lng >= -180 &&
        waypoint.lng <= 180 &&
        Number.isInteger(waypoint.insertionIndex) &&
        waypoint.insertionIndex >= 0,
    )
  );
}

export function isCalibrationSafeObservation(observation: DurationConstructionObservation) {
  return (
    observation.calibrationSafe &&
    observation.routeShapeEligible &&
    !observation.duplicate &&
    observation.actualAddedSeconds > 0 &&
    Number.isFinite(observation.actualAddedSeconds) &&
    finitePositive(observation.constructionValue) &&
    observation.relatedPlanKey.length > 0 &&
    observation.effectiveConstruction != null &&
    observation.effectiveConstruction.insertionPositions.length ===
      observation.effectiveWaypointCount &&
    (observation.effectiveWaypointCount === 1 || observation.effectiveWaypointCount === 2)
  );
}

function isCalibrationLower(observation: DurationConstructionObservation, desiredSeconds: number) {
  return (
    isCalibrationSafeObservation(observation) && observation.actualAddedSeconds < desiredSeconds
  );
}

function isSafeUpper(
  observation: DurationConstructionObservation,
  lower: DurationConstructionObservation,
  requestedExtraSeconds: number,
) {
  return (
    observation.relatedPlanKey === lower.relatedPlanKey &&
    observation.actualAddedSeconds > requestedExtraSeconds &&
    isCalibrationSafeObservation(observation) &&
    observation.constructionValue > lower.constructionValue
  );
}

function bracketConstructionValue(input: {
  lower: DurationConstructionObservation;
  upper: DurationConstructionObservation;
  desiredSeconds: number;
}): number | null {
  const durationSpan = input.upper.actualAddedSeconds - input.lower.actualAddedSeconds;
  const constructionSpan = input.upper.constructionValue - input.lower.constructionValue;
  if (!finitePositive(durationSpan) || !finitePositive(constructionSpan)) return null;
  const fraction = (input.desiredSeconds - input.lower.actualAddedSeconds) / durationSpan;
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) return null;
  const value = input.lower.constructionValue + constructionSpan * fraction;
  return finitePositive(value) &&
    value > input.lower.constructionValue &&
    value < input.upper.constructionValue
    ? value
    : null;
}

export async function runBoundedDurationRefinement(input: {
  requestedExtraMinutes: number;
  baselineDurationMinutes: number;
  attemptsAlreadyUsed: number;
  observations: DurationConstructionObservation[];
  maximumConstructionValue: number;
  construct(input: {
    strategy: DurationRefinementStrategy;
    attemptNumber: number;
    parentCandidateId: string;
    upperCandidateId: string | null;
    intendedTargetMinutes: number;
    adaptiveTargetMinutes: number;
    bracketLowerMinutes: number;
    bracketUpperMinutes: number | null;
    constructionValue: number;
    relatedPlanKey: string;
  }): Promise<DurationRefinementConstructionResult>;
}): Promise<DurationRefinementResult> {
  const requestedExtraSeconds = input.requestedExtraMinutes * 60;
  const targetMinimumSeconds = requestedExtraSeconds * MIN_TARGET_UTILISATION;
  const desiredSeconds = requestedExtraSeconds * REFINEMENT_TARGET_UTILISATION;
  if (
    input.observations.some(
      (observation) =>
        observation.withinBudget &&
        observation.routeShapeEligible &&
        !observation.duplicate &&
        observation.qualityEligible &&
        observation.actualAddedSeconds >= targetMinimumSeconds,
    )
  ) {
    return {
      attempted: false,
      reachedTargetBand: true,
      stopReason: "TARGET_REACHED",
      executions: [],
      stateCounts: refinementStateCounts([]),
    };
  }
  if (
    !finitePositive(input.requestedExtraMinutes) ||
    !finitePositive(input.baselineDurationMinutes)
  ) {
    return {
      attempted: false,
      reachedTargetBand: false,
      stopReason: "NO_SAFE_REFINEMENT_BRACKET",
      executions: [],
      stateCounts: refinementStateCounts([]),
    };
  }
  const remainingCapacity = Math.max(0, MAX_SCENIC_ROUTE_ATTEMPTS - input.attemptsAlreadyUsed);
  const maximumAttempts = Math.min(MAX_DURATION_REFINEMENT_ATTEMPTS, remainingCapacity);
  if (!finitePositive(input.maximumConstructionValue)) {
    return {
      attempted: false,
      reachedTargetBand: false,
      stopReason: "NO_CONSTRUCTION_HEADROOM",
      executions: [],
      stateCounts: refinementStateCounts([]),
    };
  }
  if (maximumAttempts === 0) {
    return {
      attempted: false,
      reachedTargetBand: false,
      stopReason: "ATTEMPT_CAPACITY_EXHAUSTED",
      executions: [],
      stateCounts: refinementStateCounts([]),
    };
  }
  const safeObservations = input.observations.filter(isCalibrationSafeObservation);
  const families = new Map<string, DurationConstructionObservation[]>();
  for (const observation of safeObservations) {
    const family = families.get(observation.relatedPlanKey) ?? [];
    family.push(observation);
    families.set(observation.relatedPlanKey, family);
  }
  const realBrackets = [...families.entries()].flatMap(([familyKey, observations]) => {
    const lowers = observations.filter((observation) =>
      isCalibrationLower(observation, desiredSeconds),
    );
    const uppers = observations.filter(
      (observation) => observation.actualAddedSeconds >= desiredSeconds,
    );
    return lowers.flatMap((lowerCandidate) =>
      uppers
        .filter(
          (upperCandidate) => upperCandidate.constructionValue > lowerCandidate.constructionValue,
        )
        .map((upperCandidate) => ({ familyKey, lower: lowerCandidate, upper: upperCandidate })),
    );
  });
  realBrackets.sort(
    (a, b) =>
      a.upper.actualAddedSeconds -
        a.lower.actualAddedSeconds -
        (b.upper.actualAddedSeconds - b.lower.actualAddedSeconds) ||
      desiredSeconds - a.lower.actualAddedSeconds - (desiredSeconds - b.lower.actualAddedSeconds) ||
      a.upper.actualAddedSeconds - desiredSeconds - (b.upper.actualAddedSeconds - desiredSeconds) ||
      a.upper.effectiveWaypointCount - b.upper.effectiveWaypointCount ||
      a.familyKey.localeCompare(b.familyKey) ||
      a.lower.candidateId.localeCompare(b.lower.candidateId) ||
      a.upper.candidateId.localeCompare(b.upper.candidateId),
  );
  const selectedBracket = realBrackets[0];
  let lower = selectedBracket?.lower;
  let upper = selectedBracket?.upper;
  let usesBaselineZero = false;
  if (!selectedBracket) {
    upper = safeObservations
      .filter((observation) => observation.actualAddedSeconds > desiredSeconds)
      .sort(
        (a, b) =>
          a.actualAddedSeconds - b.actualAddedSeconds ||
          a.effectiveWaypointCount - b.effectiveWaypointCount ||
          a.relatedPlanKey.localeCompare(b.relatedPlanKey) ||
          a.candidateId.localeCompare(b.candidateId),
      )[0];
    if (upper) usesBaselineZero = true;
    else
      lower = safeObservations
        .filter((observation) => isCalibrationLower(observation, desiredSeconds))
        .sort(
          (a, b) =>
            b.actualAddedSeconds - a.actualAddedSeconds ||
            a.effectiveWaypointCount - b.effectiveWaypointCount ||
            a.relatedPlanKey.localeCompare(b.relatedPlanKey) ||
            a.candidateId.localeCompare(b.candidateId),
        )[0];
  }
  if (!lower && !upper) {
    return {
      attempted: false,
      reachedTargetBand: false,
      stopReason: input.observations.some(
        (observation) => observation.actualAddedSeconds > desiredSeconds,
      )
        ? "NO_SAFE_CALIBRATION_UPPER"
        : "NO_CALIBRATION_LOWER_BOUND",
      executions: [],
      stateCounts: refinementStateCounts([]),
    };
  }
  if (!lower && upper) {
    lower = {
      ...upper,
      candidateId: "baseline-zero",
      actualAddedSeconds: 0,
      constructionValue: 0,
      withinBudget: true,
      qualityEligible: false,
      intendedTargetSeconds: null,
      constructionTargetSeconds: null,
      adaptiveTargetSeconds: null,
      requestedRole: null,
      effectiveWaypointCount: upper.effectiveWaypointCount,
    };
  }
  if (!lower) throw new Error("REFINEMENT_LOWER_INVARIANT");
  const executions: DurationRefinementExecution[] = [];
  let sawOverBudget = false;
  let sawIncoherent = false;
  let sawUnderTarget = false;

  for (let index = 0; index < maximumAttempts; index += 1) {
    let bracketValue = upper ? bracketConstructionValue({ lower, upper, desiredSeconds }) : null;
    if (
      upper &&
      bracketValue == null &&
      upper.constructionValue > lower.constructionValue &&
      upper.actualAddedSeconds > lower.actualAddedSeconds
    )
      bracketValue =
        lower.constructionValue + (upper.constructionValue - lower.constructionValue) / 2;
    const strategy: DurationRefinementStrategy = bracketValue
      ? usesBaselineZero && lower.actualAddedSeconds === 0
        ? "BASELINE_ZERO_BRACKET"
        : "RELATED_BRACKET"
      : "BOUNDED_EXPANSION";
    const expansionRatio = Math.min(
      MAX_UNBRACKETED_EXPANSION_RATIO,
      Math.max(1.1, desiredSeconds / Math.max(1, lower.actualAddedSeconds)),
    );
    const constructionValue = Math.min(
      input.maximumConstructionValue,
      bracketValue ?? lower.constructionValue * expansionRatio,
    );
    const boundedConstruction = upper
      ? constructionValue > lower.constructionValue && constructionValue < upper.constructionValue
      : constructionValue > lower.constructionValue;
    if (!finitePositive(constructionValue) || !boundedConstruction) {
      return {
        attempted: executions.length > 0,
        reachedTargetBand: false,
        stopReason: upper ? "NO_CONSTRUCTION_HEADROOM" : "NO_CALIBRATION_LOWER_BOUND",
        executions,
        stateCounts: refinementStateCounts(executions),
      };
    }
    const executionInput = {
      strategy,
      attemptNumber: index + 1,
      parentCandidateId:
        lower.candidateId === "baseline-zero" && upper ? upper.candidateId : lower.candidateId,
      upperCandidateId: upper?.candidateId ?? null,
      intendedTargetMinutes: desiredSeconds / 60,
      adaptiveTargetMinutes: desiredSeconds / 60,
      bracketLowerMinutes: lower.actualAddedSeconds / 60,
      bracketUpperMinutes: upper ? upper.actualAddedSeconds / 60 : null,
      constructionValue,
      relatedPlanKey: lower.relatedPlanKey,
    };
    const construction = await input.construct(executionInput);
    if (construction.status === "NO_RELATED_PLAN_FAMILY") {
      return {
        attempted: executions.length > 0,
        reachedTargetBand: false,
        stopReason: "NO_RELATED_PLAN_FAMILY",
        executions,
        stateCounts: refinementStateCounts(executions),
      };
    }
    if (construction.status === "NO_SAFE_CONSTRUCTION") {
      return {
        attempted: executions.length > 0,
        reachedTargetBand: false,
        stopReason: "NO_CONSTRUCTION_HEADROOM",
        executions,
        stateCounts: refinementStateCounts(executions),
      };
    }
    if (construction.status === "EFFECTIVE_COLLISION") {
      return {
        attempted: executions.length > 0,
        reachedTargetBand: false,
        stopReason: "NO_DISTINCT_DERIVED_CONSTRUCTION",
        executions,
        stateCounts: refinementStateCounts(executions),
      };
    }
    if (construction.status === "PROVIDER_REQUEST_FAILED") {
      executions.push({
        ...executionInput,
        observation: null,
        providerResult: "PROVIDER_REQUEST_FAILED",
      });
      return {
        attempted: true,
        reachedTargetBand: false,
        stopReason: "PROVIDER_REQUEST_FAILED",
        executions,
        stateCounts: refinementStateCounts(executions),
      };
    }
    if (construction.status === "PROVIDER_EVALUATION_FAILED") {
      executions.push({
        ...executionInput,
        observation: null,
        providerResult: "PROVIDER_EVALUATION_FAILED",
      });
      return {
        attempted: true,
        reachedTargetBand: false,
        stopReason: "PROVIDER_EVALUATION_FAILED",
        executions,
        stateCounts: refinementStateCounts(executions),
      };
    }
    if (construction.status === "PROVIDER_RESPONSE_REJECTED") {
      executions.push({
        ...executionInput,
        observation: null,
        providerResult: "PROVIDER_RESPONSE_REJECTED",
      });
      return {
        attempted: true,
        reachedTargetBand: false,
        stopReason: "PROVIDER_RESPONSE_REJECTED",
        executions,
        stateCounts: refinementStateCounts(executions),
      };
    }
    const observation = construction.observation;
    executions.push({
      ...executionInput,
      observation,
      providerResult: "PROVIDER_RESPONSE_EVALUATED",
    });
    if (!isCalibrationSafeObservation(observation)) {
      sawIncoherent = true;
      continue;
    }
    if (!observation.withinBudget) {
      sawOverBudget = true;
      if (isSafeUpper(observation, lower, desiredSeconds)) upper = observation;
      continue;
    }
    if (
      !observation.duplicate &&
      observation.qualityEligible &&
      observation.actualAddedSeconds >= targetMinimumSeconds
    ) {
      return {
        attempted: true,
        reachedTargetBand: true,
        stopReason: "TARGET_REACHED",
        executions,
        stateCounts: refinementStateCounts(executions),
      };
    }
    if (observation.actualAddedSeconds >= desiredSeconds) {
      if (isSafeUpper(observation, lower, desiredSeconds)) upper = observation;
      continue;
    }
    if (isCalibrationLower(observation, desiredSeconds)) {
      sawUnderTarget = true;
      lower = observation;
    }
  }

  return {
    attempted: executions.length > 0,
    reachedTargetBand: false,
    stopReason: sawIncoherent
      ? "REFINED_CANDIDATES_INCOHERENT"
      : sawOverBudget
        ? "REFINED_CANDIDATES_OVER_BUDGET"
        : sawUnderTarget
          ? "PROVIDER_REMAINED_BELOW_TARGET"
          : executions.length === 0
            ? "NO_SAFE_REFINEMENT_BRACKET"
            : "ATTEMPT_CAPACITY_EXHAUSTED",
    executions,
    stateCounts: refinementStateCounts(executions),
  };
}
