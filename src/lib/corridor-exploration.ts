import {
  haversineDistanceMeters,
  isValidLatLng,
  planScenicWaypointsWithDiagnostics,
  type LatLng,
  type ScenicPlace,
  type ScenicWaypointPlan,
} from "./scenic-waypoint";
import { MIN_TARGET_UTILISATION } from "./route-selection";

export type ScenicCorridorKind =
  | "forest"
  | "coastline"
  | "viewpoints"
  | "historic"
  | "towns"
  | "national-parks"
  | "lakes"
  | "other";

export type ScenicCorridorPlan = {
  kind: ScenicCorridorKind;
  reason: string;
  waypoints: ScenicWaypointPlan[];
  estimatedDetourMeters: number;
  signature: string;
};

export type ExplorationStage = {
  radiusMeters: number;
  sampleCap: number;
  cumulativePlaceCap: number;
  cumulativeRouteCap: number;
  planningBudgetMinutes: number;
  targetExtraMinutes: number[];
  attemptRoles: PositiveAllowanceAttemptRole[];
};

export type PositiveAllowanceAttemptRole = {
  targetExtraMinutes: number;
  side: "left" | "right" | "alternating-arc";
  progress: "early" | "middle" | "late" | "distributed";
  waypointForm: "one-waypoint" | "two-waypoint-arc";
  evidencePreference: "preference-match" | "overall-scenic" | "alternate-cluster";
};

export type DurationTargetClassification =
  | "SEVERE_UNDERSHOOT"
  | "MODERATE_UNDERSHOOT"
  | "TARGET_BAND"
  | "OVER_BUDGET";

export type DurationAwareCorridorSample = {
  center: LatLng;
  targetExtraMinutes: number;
  lateralDisplacementMeters: number;
  journeyProgress: number;
};

export type OrdinaryPlanningOutcome = "PLANNED" | "EFFECTIVE_COLLISION" | "NO_PLAN";

export type OrdinaryPlanningCounts = {
  scheduled: number;
  processed: number;
  distinct: number;
  collisions: number;
  noPlan: number;
};

export function createOrdinaryPlanningCounter(scheduledTargets: number) {
  const scheduled = Math.max(0, Math.floor(scheduledTargets));
  const counts: OrdinaryPlanningCounts = {
    scheduled,
    processed: 0,
    distinct: 0,
    collisions: 0,
    noPlan: 0,
  };
  return {
    record(outcome: OrdinaryPlanningOutcome): void {
      if (counts.processed >= counts.scheduled) return;
      counts.processed += 1;
      if (outcome === "PLANNED") counts.distinct += 1;
      else if (outcome === "EFFECTIVE_COLLISION") counts.collisions += 1;
      else counts.noPlan += 1;
    },
    snapshot(): OrdinaryPlanningCounts {
      return { ...counts };
    },
  };
}

export function effectivePlanningOutcome(input: {
  plans: ScenicCorridorPlan[];
  rejectedEffectiveCollision: number;
}): { outcome: OrdinaryPlanningOutcome; plan: ScenicCorridorPlan | null } {
  const plan = input.plans[0] ?? null;
  if (plan) return { outcome: "PLANNED", plan };
  return {
    outcome: input.rejectedEffectiveCollision > 0 ? "EFFECTIVE_COLLISION" : "NO_PLAN",
    plan: null,
  };
}

export const EXPLORATION_SCORE_IMPROVEMENT_THRESHOLD = 3;

const MAX_ORDINARY_SCENIC_ROUTE_ATTEMPTS = 5;

const CORRIDOR_ORDER: ScenicCorridorKind[] = [
  "forest",
  "coastline",
  "viewpoints",
  "historic",
  "towns",
  "national-parks",
  "lakes",
  "other",
];

const CORRIDOR_REASON: Record<ScenicCorridorKind, string> = {
  forest: "Forest corridor",
  coastline: "Coastal corridor",
  viewpoints: "Viewpoint corridor",
  historic: "Historic corridor",
  towns: "Town corridor",
  "national-parks": "National park corridor",
  lakes: "Lakeside corridor",
  other: "Scenic corridor",
};

function uniqueIncreasingTargets(targets: number[], maximum: number): number[] {
  return [...new Set(targets.map((target) => Math.max(1, Math.min(maximum, Math.round(target)))))]
    .sort((a, b) => a - b)
    .slice(0, MAX_ORDINARY_SCENIC_ROUTE_ATTEMPTS);
}

function roundToFive(minutes: number): number {
  return Math.max(1, Math.round(minutes / 5) * 5);
}

/**
 * Five ordinary attempts are the maximum: the sixth scenic Routes request is
 * deliberately left available for duration refinement. Small allowances use
 * integer targets; larger allowances use five-minute construction increments.
 */
export function positiveAllowanceTargetLadder(extraMinutes: number): number[] {
  const maximum = Math.max(0, Math.min(240, Math.floor(extraMinutes)));
  if (maximum <= 0) return [];
  if (maximum <= 10) {
    return uniqueIncreasingTargets([Math.ceil(maximum * 0.75), Math.round(maximum * 0.9)], maximum);
  }
  if (maximum <= 30) {
    return uniqueIncreasingTargets(
      [Math.round(maximum * 0.5), Math.ceil(maximum * 0.75), Math.round(maximum * 0.9)],
      maximum,
    );
  }
  if (maximum < 60) {
    return uniqueIncreasingTargets(
      [30, roundToFive(maximum * 0.75), roundToFive(maximum * 0.9)],
      maximum,
    );
  }
  if (maximum < 90)
    return uniqueIncreasingTargets([30, 45, 60, 70, roundToFive(maximum * 0.9)], maximum);
  return uniqueIncreasingTargets(
    [30, 60, 70, roundToFive(maximum * 0.75), roundToFive(maximum * 0.9)],
    maximum,
  );
}

export function positiveAllowanceAttemptRoles(targets: number[]): PositiveAllowanceAttemptRole[] {
  const templates: Omit<PositiveAllowanceAttemptRole, "targetExtraMinutes">[] = [
    {
      side: "left",
      progress: "middle",
      waypointForm: "one-waypoint",
      evidencePreference: "preference-match",
    },
    {
      side: "right",
      progress: "middle",
      waypointForm: "one-waypoint",
      evidencePreference: "alternate-cluster",
    },
    {
      side: "alternating-arc",
      progress: "distributed",
      waypointForm: "two-waypoint-arc",
      evidencePreference: "overall-scenic",
    },
    {
      side: "left",
      progress: "distributed",
      waypointForm: "two-waypoint-arc",
      evidencePreference: "preference-match",
    },
    {
      side: "right",
      progress: "distributed",
      waypointForm: "two-waypoint-arc",
      evidencePreference: "alternate-cluster",
    },
  ];
  return targets.map((targetExtraMinutes, index) => ({
    targetExtraMinutes,
    ...templates[Math.min(index, templates.length - 1)],
  }));
}

export function explorationStages(extraMinutes: number): ExplorationStage[] {
  if (extraMinutes <= 0) return [];
  const targets = positiveAllowanceTargetLadder(extraMinutes);
  if (extraMinutes <= 10) {
    return [
      {
        radiusMeters: 900,
        sampleCap: 2,
        cumulativePlaceCap: 14,
        cumulativeRouteCap: 1,
        planningBudgetMinutes: extraMinutes,
        targetExtraMinutes: targets.slice(0, 1),
        attemptRoles: positiveAllowanceAttemptRoles(targets).slice(0, 1),
      },
      {
        radiusMeters: 1_500,
        sampleCap: 3,
        cumulativePlaceCap: 24,
        cumulativeRouteCap: targets.length,
        planningBudgetMinutes: extraMinutes,
        targetExtraMinutes: targets.slice(1, 2),
        attemptRoles: positiveAllowanceAttemptRoles(targets).slice(1, 2),
      },
    ].filter((stage) => stage.targetExtraMinutes.length > 0);
  }
  if (extraMinutes <= 30) {
    return [
      {
        radiusMeters: 1_200,
        sampleCap: 3,
        cumulativePlaceCap: 20,
        cumulativeRouteCap: 1,
        planningBudgetMinutes: extraMinutes,
        targetExtraMinutes: targets.slice(0, 1),
        attemptRoles: positiveAllowanceAttemptRoles(targets).slice(0, 1),
      },
      {
        radiusMeters: 2_300,
        sampleCap: 4,
        cumulativePlaceCap: 34,
        cumulativeRouteCap: 2,
        planningBudgetMinutes: extraMinutes,
        targetExtraMinutes: targets.slice(1, 2),
        attemptRoles: positiveAllowanceAttemptRoles(targets).slice(1, 2),
      },
      {
        radiusMeters: 3_500,
        sampleCap: 5,
        cumulativePlaceCap: 45,
        cumulativeRouteCap: targets.length,
        planningBudgetMinutes: extraMinutes,
        targetExtraMinutes: targets.slice(2, 3),
        attemptRoles: positiveAllowanceAttemptRoles(targets).slice(2, 3),
      },
    ].filter((stage) => stage.targetExtraMinutes.length > 0);
  }
  const stageDefinitions = [
    {
      radiusMeters: 1_200,
      sampleCap: 3,
      cumulativePlaceCap: 20,
    },
    {
      radiusMeters: 2_300,
      sampleCap: 4,
      cumulativePlaceCap: 34,
    },
    {
      radiusMeters: 3_500,
      sampleCap: 5,
      cumulativePlaceCap: 45,
    },
    {
      radiusMeters: 10_000,
      sampleCap: 3,
      cumulativePlaceCap: 70,
    },
  ];
  const stageCount = Math.min(stageDefinitions.length, targets.length);
  const definitions =
    stageCount === 3
      ? [stageDefinitions[0], stageDefinitions[1], stageDefinitions[3]]
      : stageDefinitions.slice(0, stageCount);
  return definitions.map((definition, index) => {
    const isFinal = index === definitions.length - 1;
    const targetExtraMinutes = isFinal ? targets.slice(index) : targets.slice(index, index + 1);
    return {
      ...definition,
      cumulativeRouteCap: isFinal ? targets.length : index + 1,
      planningBudgetMinutes: extraMinutes,
      targetExtraMinutes,
      attemptRoles: positiveAllowanceAttemptRoles(targets).filter((role) =>
        targetExtraMinutes.includes(role.targetExtraMinutes),
      ),
    };
  });
}

export function classifyDurationTargetResult(
  intendedExtraMinutes: number,
  actualExtraMinutes: number,
  maximumExtraMinutes: number,
): DurationTargetClassification {
  if (actualExtraMinutes > maximumExtraMinutes) return "OVER_BUDGET";
  const utilisation = actualExtraMinutes / Math.max(1, intendedExtraMinutes);
  if (utilisation < 0.5) return "SEVERE_UNDERSHOOT";
  if (utilisation < MIN_TARGET_UTILISATION) return "MODERATE_UNDERSHOOT";
  return "TARGET_BAND";
}

export function adaptiveDurationTargetMinutes(input: {
  nextTargetMinutes: number;
  priorIntendedMinutes: number;
  priorActualMinutes: number;
  maximumExtraMinutes: number;
}): number {
  const boundedNextTarget = Math.max(
    0,
    Math.min(input.maximumExtraMinutes, input.nextTargetMinutes),
  );
  const classification = classifyDurationTargetResult(
    input.priorIntendedMinutes,
    input.priorActualMinutes,
    input.maximumExtraMinutes,
  );
  if (classification === "TARGET_BAND" || classification === "OVER_BUDGET")
    return boundedNextTarget;
  const correction = Math.min(
    1.5,
    input.priorIntendedMinutes / Math.max(1, input.priorActualMinutes),
  );
  return Math.min(input.maximumExtraMinutes, Math.round(boundedNextTarget * correction));
}

export function targetLateralDisplacementMeters(input: {
  baselineDistanceMeters: number;
  baselineDurationSeconds: number;
  targetExtraMinutes: number;
}): number {
  const measuredSpeed = input.baselineDistanceMeters / Math.max(1, input.baselineDurationSeconds);
  const averageMetersPerSecond =
    Number.isFinite(measuredSpeed) && measuredSpeed >= 3 && measuredSpeed <= 45
      ? measuredSpeed
      : 16;
  const targetAdditionalDistance = averageMetersPerSecond * input.targetExtraMinutes * 60;
  return Math.round(Math.max(6_000, Math.min(70_000, targetAdditionalDistance * 0.5)));
}

const EARTH_RADIUS_METERS = 6_371_008.8;

function normaliseGeneratedLongitude(longitude: number): number {
  const normalised = ((((longitude + 180) % 360) + 360) % 360) - 180;
  return Object.is(normalised, -0) ? 0 : normalised;
}

/** A bounded spherical reach estimate. It is not an estimate of road distance. */
export function geographicDestinationPoint(
  point: LatLng,
  distanceMeters: number,
  bearingDegrees: number,
): LatLng | null {
  if (
    !isValidLatLng(point) ||
    !Number.isFinite(distanceMeters) ||
    distanceMeters < 0 ||
    distanceMeters > 70_000 ||
    !Number.isFinite(bearingDegrees)
  )
    return null;
  const normalisedPoint = { lat: point.lat, lng: normaliseGeneratedLongitude(point.lng) };
  if (distanceMeters === 0) return normalisedPoint;
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;
  const bearing = ((((bearingDegrees % 360) + 360) % 360) * Math.PI) / 180;
  const latitude = (point.lat * Math.PI) / 180;
  const longitude = (point.lng * Math.PI) / 180;
  const destinationLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance) +
      Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const destinationLongitude =
    longitude +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
      Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(destinationLatitude),
    );
  const result = {
    lat: (destinationLatitude * 180) / Math.PI,
    lng: normaliseGeneratedLongitude((destinationLongitude * 180) / Math.PI),
  };
  return isValidLatLng(result) ? result : null;
}

function initialBearingDegrees(from: LatLng, to: LatLng): number | null {
  if (!isValidLatLng(from) || !isValidLatLng(to)) return null;
  const fromLatitude = (from.lat * Math.PI) / 180;
  const toLatitude = (to.lat * Math.PI) / 180;
  const longitudeDelta = (normaliseGeneratedLongitude(to.lng - from.lng) * Math.PI) / 180;
  const y = Math.sin(longitudeDelta) * Math.cos(toLatitude);
  const x =
    Math.cos(fromLatitude) * Math.sin(toLatitude) -
    Math.sin(fromLatitude) * Math.cos(toLatitude) * Math.cos(longitudeDelta);
  if (Math.abs(x) < Number.EPSILON && Math.abs(y) < Number.EPSILON) return null;
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function offsetPerpendicular(
  point: LatLng,
  previous: LatLng,
  next: LatLng,
  meters: number,
): LatLng | null {
  const direction = initialBearingDegrees(previous, next);
  if (direction == null) return null;
  return geographicDestinationPoint(point, Math.abs(meters), direction + (meters < 0 ? 90 : -90));
}

function validRating(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 5
    ? value
    : null;
}

function validReviewCount(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

export function deterministicallyRankCorridorEvidence(
  places: ScenicPlace[],
  preferredTypes: ReadonlySet<string> = new Set(),
  evidencePreference: PositiveAllowanceAttemptRole["evidencePreference"] = "preference-match",
): ScenicPlace[] {
  return [...places].sort((a, b) => {
    const relevance = (place: ScenicPlace) =>
      Number(
        preferredTypes.has(place.primaryType) ||
          place.types.some((type) => preferredTypes.has(type)),
      );
    const ratingDifference = (validRating(b.rating) ?? -1) - (validRating(a.rating) ?? -1);
    const reviewDifference =
      (validReviewCount(b.userRatingCount) ?? -1) - (validReviewCount(a.userRatingCount) ?? -1);
    const preferenceDifference = relevance(b) - relevance(a);
    const roleDifference =
      evidencePreference === "overall-scenic"
        ? ratingDifference || reviewDifference || preferenceDifference
        : evidencePreference === "alternate-cluster"
          ? relevance(a) - relevance(b) || a.primaryType.localeCompare(b.primaryType)
          : preferenceDifference || ratingDifference || reviewDifference;
    return (
      roleDifference ||
      ratingDifference ||
      reviewDifference ||
      a.primaryType.localeCompare(b.primaryType) ||
      a.id.localeCompare(b.id)
    );
  });
}

export function durationAwareCorridorSamples(input: {
  samples: LatLng[];
  baselineDistanceMeters: number;
  baselineDurationSeconds: number;
  targetExtraMinutes: number[];
  attemptRoles?: PositiveAllowanceAttemptRole[];
}): DurationAwareCorridorSample[] {
  if (input.samples.length === 0 || input.targetExtraMinutes.length === 0) return [];
  return input.samples.flatMap((sample, index) => {
    const targetIndex = Math.min(
      input.targetExtraMinutes.length - 1,
      Math.floor(((index + 1) * input.targetExtraMinutes.length) / input.samples.length),
    );
    const targetExtraMinutes = input.targetExtraMinutes[targetIndex];
    const role = input.attemptRoles?.find(
      (candidate) => candidate.targetExtraMinutes === targetExtraMinutes,
    );
    const lateralDisplacementMeters = targetLateralDisplacementMeters({
      baselineDistanceMeters: input.baselineDistanceMeters,
      baselineDurationSeconds: input.baselineDurationSeconds,
      targetExtraMinutes,
    });
    const center = offsetPerpendicular(
      sample,
      input.samples[Math.max(0, index - 1)],
      input.samples[Math.min(input.samples.length - 1, index + 1)],
      lateralDisplacementMeters *
        (role?.side === "right" || (role?.side === "alternating-arc" && index % 2 === 1) ? -1 : 1),
    );
    if (!center) return [];
    return [
      {
        center,
        targetExtraMinutes,
        lateralDisplacementMeters,
        journeyProgress: (index + 1) / (input.samples.length + 1),
      },
    ];
  });
}

function coordinateKey(point: LatLng): string {
  return `${normaliseGeneratedLongitude(point.lng).toFixed(6)},${point.lat.toFixed(6)}`;
}

export function effectiveRoutePlanSignature(
  plan: ScenicCorridorPlan,
  anchors: LatLng[] = [],
): string {
  const ordered = [...plan.waypoints].sort(
    (a, b) =>
      a.insertionIndex - b.insertionIndex ||
      (anchors[a.insertionIndex]
        ? haversineDistanceMeters(anchors[a.insertionIndex], a) -
            haversineDistanceMeters(anchors[b.insertionIndex], b) ||
          coordinateKey(a).localeCompare(coordinateKey(b))
        : coordinateKey(a).localeCompare(coordinateKey(b))),
  );
  return `${ordered.length}|${ordered
    .map((waypoint) => `${waypoint.insertionIndex}:${coordinateKey(waypoint)}`)
    .join("|")}`;
}

/** Ephemeral, coordinate-free equivalence check for a single stage. Equal
 * displacement vectors imply equal offset centres for the same validated
 * baseline samples, even when the requested minute labels differ. */
export function distinctDurationTargetsBySearchGeometry(input: {
  samples: LatLng[];
  baselineDistanceMeters: number;
  baselineDurationSeconds: number;
  targetExtraMinutes: number[];
  attemptRoles?: PositiveAllowanceAttemptRole[];
}): { targets: number[]; distinctGeometryCount: number; collisionCount: number } {
  const signatures = new Set<string>();
  const targets: number[] = [];
  for (const targetExtraMinutes of input.targetExtraMinutes) {
    const planned = durationAwareCorridorSamples({
      samples: input.samples,
      baselineDistanceMeters: input.baselineDistanceMeters,
      baselineDurationSeconds: input.baselineDurationSeconds,
      targetExtraMinutes: [targetExtraMinutes],
      attemptRoles: input.attemptRoles?.filter(
        (role) => role.targetExtraMinutes === targetExtraMinutes,
      ),
    });
    const role = input.attemptRoles?.find(
      (candidate) => candidate.targetExtraMinutes === targetExtraMinutes,
    );
    const signature = `${role?.side ?? "left"}:${role?.progress ?? "distributed"}:${role?.waypointForm ?? "one-waypoint"}:${planned.length}:${planned
      .map((sample) => Math.round(sample.lateralDisplacementMeters / 100) * 100)
      .join(":")}`;
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    targets.push(targetExtraMinutes);
  }
  return {
    targets,
    distinctGeometryCount: signatures.size,
    collisionCount: input.targetExtraMinutes.length - targets.length,
  };
}

export function createPositiveAllowanceProductionCoordinator<TCandidate>(input: {
  candidates: TCandidate[];
  maximumPlacesRequests?: number;
  maximumRouteRequests?: number;
  onPlacesRequested?: (count: number) => void;
  onRouteRequested?: () => void;
}) {
  const maximumPlacesRequests = input.maximumPlacesRequests ?? 15;
  const maximumRouteRequests = input.maximumRouteRequests ?? 6;
  let placesRequestsStarted = 0;
  let routeRequestsStarted = 0;

  return {
    prepareStage(stage: {
      samples: LatLng[];
      baselineDistanceMeters: number;
      baselineDurationSeconds: number;
      targetExtraMinutes: number[];
      attemptRoles?: PositiveAllowanceAttemptRole[];
    }) {
      const collision = distinctDurationTargetsBySearchGeometry(stage);
      return {
        ...collision,
        samples: durationAwareCorridorSamples({
          ...stage,
          targetExtraMinutes: collision.targets,
          attemptRoles: stage.attemptRoles?.filter((role) =>
            collision.targets.includes(role.targetExtraMinutes),
          ),
        }),
      };
    },
    prepareRoutePlan(
      planning: Parameters<typeof prepareRoleSpecificCorridorPlan>[0],
    ): ReturnType<typeof prepareRoleSpecificCorridorPlan> {
      return prepareRoleSpecificCorridorPlan(planning);
    },
    async collectPlaces<TPlace>(
      centres: LatLng[],
      search: (centre: LatLng) => Promise<TPlace[]>,
    ): Promise<PromiseSettledResult<TPlace[]>[]> {
      if (placesRequestsStarted + centres.length > maximumPlacesRequests)
        throw new Error("PLACES_REQUEST_CAPACITY_EXHAUSTED");
      placesRequestsStarted += centres.length;
      input.onPlacesRequested?.(centres.length);
      return Promise.allSettled(centres.map((centre) => search(centre)));
    },
    requestRoute<TResult>(request: () => Promise<TResult>): Promise<TResult> {
      if (routeRequestsStarted >= maximumRouteRequests)
        return Promise.reject(new Error("ROUTE_REQUEST_CAPACITY_EXHAUSTED"));
      routeRequestsStarted += 1;
      input.onRouteRequested?.();
      return Promise.resolve().then(request);
    },
    recordCandidate(candidate: TCandidate): void {
      input.candidates.push(candidate);
    },
    finalise<TResult>(select: (candidates: TCandidate[]) => TResult): TResult {
      return select(input.candidates);
    },
    counts() {
      return {
        placesRequestsStarted,
        routeRequestsStarted,
        remainingRouteRequests: Math.max(0, maximumRouteRequests - routeRequestsStarted),
      };
    },
  };
}

export function selectPlansForDetourTargets(
  plans: ScenicCorridorPlan[],
  targetDetourMeters: number[],
  maximumPlans: number,
): ScenicCorridorPlan[] {
  const remaining = [...plans];
  const selected: ScenicCorridorPlan[] = [];
  for (const target of targetDetourMeters) {
    if (selected.length >= maximumPlans || remaining.length === 0) break;
    remaining.sort(
      (a, b) =>
        Math.abs(a.estimatedDetourMeters - target) - Math.abs(b.estimatedDetourMeters - target) ||
        a.estimatedDetourMeters - b.estimatedDetourMeters ||
        a.signature.localeCompare(b.signature),
    );
    selected.push(remaining.shift()!);
  }
  return selected.concat(remaining).slice(0, Math.max(0, maximumPlans));
}

export function corridorKindForPlace(place: ScenicPlace): ScenicCorridorKind {
  const types = new Set([place.primaryType, ...place.types]);
  if (["woods", "nature_preserve"].some((type) => types.has(type))) return "forest";
  if (["beach", "marina"].some((type) => types.has(type))) return "coastline";
  if (["scenic_spot", "observation_deck"].some((type) => types.has(type))) return "viewpoints";
  if (
    ["historical_place", "historical_landmark", "castle", "history_museum", "museum"].some((type) =>
      types.has(type),
    )
  )
    return "historic";
  if (types.has("locality")) return "towns";
  if (["national_park", "state_park"].some((type) => types.has(type))) return "national-parks";
  if (["lake", "river"].some((type) => types.has(type))) return "lakes";
  return "other";
}

export function buildCorridorPlans(input: {
  places: ScenicPlace[];
  anchors: LatLng[];
  maximumEstimatedDetourMeters: number;
  maximumPlans: number;
  attemptedSignatures?: ReadonlySet<string>;
  attemptedKinds?: ReadonlySet<ScenicCorridorKind>;
  targetDetourMeters?: number[];
  attemptRole?: PositiveAllowanceAttemptRole;
}): {
  plans: ScenicCorridorPlan[];
  considered: number;
  rejectedDuplicate: number;
  rejectedBacktracking: number;
  rejectedEffectiveCollision: number;
} {
  const planning = planScenicWaypointsWithDiagnostics(
    input.places,
    input.anchors,
    input.maximumEstimatedDetourMeters,
    input.places.length,
  );
  const groups = new Map<ScenicCorridorKind, ScenicWaypointPlan[]>();
  for (const waypoint of planning.plans) {
    const kind = corridorKindForPlace(waypoint);
    const group = groups.get(kind) ?? [];
    group.push(waypoint);
    groups.set(kind, group);
  }

  const proposals: ScenicCorridorPlan[] = [];
  for (const kind of CORRIDOR_ORDER) {
    const waypoints = groups.get(kind) ?? [];
    if (waypoints.length === 0) continue;
    const pair = waypoints.slice(0, 2);
    if (
      pair.length === 2 &&
      pair[0].estimatedDetourMeters + pair[1].estimatedDetourMeters <=
        input.maximumEstimatedDetourMeters
    ) {
      const proposal = {
        kind,
        reason: CORRIDOR_REASON[kind],
        waypoints: pair,
        estimatedDetourMeters: pair.reduce(
          (sum, waypoint) => sum + waypoint.estimatedDetourMeters,
          0,
        ),
        signature: "",
      };
      proposal.signature = effectiveRoutePlanSignature(proposal, input.anchors);
      proposals.push(proposal);
    } else {
      const waypoint = waypoints[0];
      const proposal = {
        kind,
        reason: CORRIDOR_REASON[kind],
        waypoints: [waypoint],
        estimatedDetourMeters: waypoint.estimatedDetourMeters,
        signature: "",
      };
      proposal.signature = effectiveRoutePlanSignature(proposal, input.anchors);
      proposals.push(proposal);
    }
  }
  for (const kind of CORRIDOR_ORDER) {
    const waypoints = groups.get(kind) ?? [];
    for (const waypoint of waypoints.slice(
      0,
      input.targetDetourMeters?.length ? waypoints.length : 2,
    )) {
      const proposal = {
        kind,
        reason: CORRIDOR_REASON[kind],
        waypoints: [waypoint],
        estimatedDetourMeters: waypoint.estimatedDetourMeters,
        signature: "",
      };
      proposal.signature = effectiveRoutePlanSignature(proposal, input.anchors);
      if (proposals.some((plan) => plan.signature === proposal.signature)) continue;
      proposals.push(proposal);
    }
    if (input.targetDetourMeters?.length) {
      for (let first = 0; first < waypoints.length; first += 1) {
        for (let second = first + 1; second < waypoints.length; second += 1) {
          const pair = [waypoints[first], waypoints[second]];
          const estimatedDetourMeters = pair.reduce(
            (sum, waypoint) => sum + waypoint.estimatedDetourMeters,
            0,
          );
          if (
            pair[0].insertionIndex === pair[1].insertionIndex ||
            haversineDistanceMeters(pair[0], pair[1]) < 1_000 ||
            estimatedDetourMeters > input.maximumEstimatedDetourMeters
          )
            continue;
          const proposal = {
            kind,
            reason: CORRIDOR_REASON[kind],
            waypoints: pair,
            estimatedDetourMeters,
            signature: "",
          };
          proposal.signature = effectiveRoutePlanSignature(proposal, input.anchors);
          if (proposals.some((plan) => plan.signature === proposal.signature)) continue;
          proposals.push(proposal);
        }
      }
    }
  }

  const attempted = input.attemptedSignatures ?? new Set<string>();
  const attemptedKinds = input.attemptedKinds ?? new Set<ScenicCorridorKind>();
  const requestedFormPlans = input.attemptRole
    ? proposals.filter((plan) =>
        input.attemptRole?.waypointForm === "two-waypoint-arc"
          ? plan.waypoints.length === 2 &&
            plan.waypoints[0].insertionIndex !== plan.waypoints[1].insertionIndex
          : plan.waypoints.length === 1,
      )
    : proposals;
  const formPlans =
    requestedFormPlans.length > 0 || input.attemptRole?.waypointForm !== "two-waypoint-arc"
      ? requestedFormPlans
      : proposals.filter((plan) => plan.waypoints.length === 1);
  const progressPlans = input.attemptRole
    ? formPlans.filter((plan) => {
        const progress = plan.waypoints.map(
          (waypoint) => (waypoint.insertionIndex + 0.5) / Math.max(1, input.anchors.length - 1),
        );
        if (input.attemptRole?.progress === "early") return progress.every((value) => value <= 0.5);
        if (input.attemptRole?.progress === "late") return progress.every((value) => value >= 0.5);
        if (input.attemptRole?.progress === "middle")
          return progress.every((value) => value >= 0.25 && value <= 0.75);
        return Math.min(...progress) < 0.5 && Math.max(...progress) > 0.5;
      })
    : formPlans;
  // A missing role-specific cluster safely falls back to the requested waypoint
  // form; it never invents an arbitrary coordinate or reorders required stops.
  const rolePlans = progressPlans.length > 0 ? progressPlans : formPlans;
  const availablePlans = rolePlans
    .filter((plan) => !attempted.has(plan.signature))
    .sort((a, b) => Number(attemptedKinds.has(a.kind)) - Number(attemptedKinds.has(b.kind)));
  const rejectedEffectiveCollision =
    rolePlans.length > 0 &&
    availablePlans.length === 0 &&
    rolePlans.some((plan) => attempted.has(plan.signature))
      ? 1
      : 0;
  return {
    ...planning,
    rejectedEffectiveCollision,
    plans:
      input.targetDetourMeters?.length && input.maximumPlans > 0
        ? selectPlansForDetourTargets(availablePlans, input.targetDetourMeters, input.maximumPlans)
        : availablePlans.slice(0, input.maximumPlans),
  };
}

/** Production preparation boundary between returned Places evidence and a Routes request. */
export function prepareRoleSpecificCorridorPlan(input: {
  places: ScenicPlace[];
  preferredTypes: ReadonlySet<string>;
  anchors: LatLng[];
  maximumEstimatedDetourMeters: number;
  attemptedSignatures: ReadonlySet<string>;
  attemptedKinds: ReadonlySet<ScenicCorridorKind>;
  targetDetourMeters: number[];
  attemptRole: PositiveAllowanceAttemptRole;
}): ReturnType<typeof buildCorridorPlans> {
  return buildCorridorPlans({
    places: deterministicallyRankCorridorEvidence(
      input.places,
      input.preferredTypes,
      input.attemptRole.evidencePreference,
    ),
    anchors: input.anchors,
    maximumEstimatedDetourMeters: input.maximumEstimatedDetourMeters,
    maximumPlans: 1,
    attemptedSignatures: input.attemptedSignatures,
    attemptedKinds: input.attemptedKinds,
    targetDetourMeters: input.targetDetourMeters,
    attemptRole: input.attemptRole,
  });
}

export function corridorWaypointsWithRequiredStops(
  requiredStops: LatLng[],
  anchors: LatLng[],
  plan: ScenicCorridorPlan,
): LatLng[] {
  const inserted = [...plan.waypoints].sort(
    (a, b) =>
      a.insertionIndex - b.insertionIndex ||
      haversineDistanceMeters(anchors[a.insertionIndex], a) -
        haversineDistanceMeters(anchors[b.insertionIndex], b) ||
      coordinateKey(a).localeCompare(coordinateKey(b)),
  );
  const result = [...requiredStops];
  inserted.forEach((waypoint, offset) => {
    result.splice(waypoint.insertionIndex + offset, 0, { lat: waypoint.lat, lng: waypoint.lng });
  });
  return result;
}

export function budgetUtilisation(
  baselineDurationSeconds: number,
  candidateDurationSeconds: number,
  extraMinutes: number,
): number {
  if (extraMinutes <= 0) return 0;
  return Math.max(
    0,
    (candidateDurationSeconds - baselineDurationSeconds) / Math.max(1, extraMinutes * 60),
  );
}

export function isTargetBudgetCandidate(utilisation: number): boolean {
  return utilisation >= MIN_TARGET_UTILISATION && utilisation <= 1;
}

export function didCompleteFullAllowanceSearch(input: {
  explorationExhausted: boolean;
  candidateRequestFailed: boolean;
  scenicRouteRequestsAttempted: number;
  intendedScenicRouteRequests: number;
  longerEligibleCandidateEvaluated: boolean;
}): boolean {
  return (
    input.explorationExhausted &&
    !input.candidateRequestFailed &&
    input.scenicRouteRequestsAttempted >= input.intendedScenicRouteRequests &&
    input.longerEligibleCandidateEvaluated
  );
}

export function explorationShouldStop(input: {
  bestScore: number;
  bestHighUtilisationScore: number;
  bestQualityEquivalentUtilisation: number;
  requestedExtraMinutes: number;
  stagesExplored: number;
  stagesRemaining: number;
  scoreImprovementThreshold?: number;
}): boolean {
  if (input.stagesRemaining <= 0) return true;
  if (input.requestedExtraMinutes > 30 && input.bestQualityEquivalentUtilisation < 0.5)
    return false;
  const hasStrongQualityEquivalentCandidate =
    input.bestHighUtilisationScore >= input.bestScore - EXPLORATION_SCORE_IMPROVEMENT_THRESHOLD;
  if (hasStrongQualityEquivalentCandidate && input.stagesExplored >= 2) return true;
  const threshold = input.scoreImprovementThreshold ?? EXPLORATION_SCORE_IMPROVEMENT_THRESHOLD;
  return (
    100 - input.bestScore <= Math.max(0, threshold) &&
    input.bestQualityEquivalentUtilisation >= MIN_TARGET_UTILISATION
  );
}
