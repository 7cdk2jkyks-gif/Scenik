import {
  haversineDistanceMeters,
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

export const EXPLORATION_SCORE_IMPROVEMENT_THRESHOLD = 3;

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

export function explorationStages(extraMinutes: number): ExplorationStage[] {
  if (extraMinutes <= 0) return [];
  if (extraMinutes <= 10) {
    return [
      {
        radiusMeters: 900,
        sampleCap: 2,
        cumulativePlaceCap: 14,
        cumulativeRouteCap: 1,
        planningBudgetMinutes: extraMinutes,
        targetExtraMinutes: [extraMinutes],
      },
      {
        radiusMeters: 1_500,
        sampleCap: 3,
        cumulativePlaceCap: 24,
        cumulativeRouteCap: 2,
        planningBudgetMinutes: extraMinutes,
        targetExtraMinutes: [extraMinutes],
      },
    ];
  }
  if (extraMinutes <= 30) {
    return [
      {
        radiusMeters: 1_200,
        sampleCap: 3,
        cumulativePlaceCap: 20,
        cumulativeRouteCap: 1,
        planningBudgetMinutes: extraMinutes,
        targetExtraMinutes: [extraMinutes],
      },
      {
        radiusMeters: 2_300,
        sampleCap: 4,
        cumulativePlaceCap: 34,
        cumulativeRouteCap: 2,
        planningBudgetMinutes: extraMinutes,
        targetExtraMinutes: [extraMinutes],
      },
      {
        radiusMeters: 3_500,
        sampleCap: 5,
        cumulativePlaceCap: 45,
        cumulativeRouteCap: 4,
        planningBudgetMinutes: extraMinutes,
        targetExtraMinutes: [extraMinutes],
      },
    ];
  }
  const roundToFive = (minutes: number) => Math.max(1, Math.round(minutes / 5) * 5);
  const intermediateTarget = Math.max(35, roundToFive(extraMinutes * 0.58));
  const upperTarget = Math.max(40, roundToFive(extraMinutes * 0.82));
  return [
    ...explorationStages(30),
    {
      radiusMeters: 10_000,
      sampleCap: 3,
      cumulativePlaceCap: 70,
      cumulativeRouteCap: 6,
      planningBudgetMinutes: extraMinutes,
      targetExtraMinutes: [intermediateTarget, upperTarget],
    },
  ];
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
  const averageMetersPerSecond =
    input.baselineDistanceMeters / Math.max(1, input.baselineDurationSeconds);
  const targetAdditionalDistance = averageMetersPerSecond * input.targetExtraMinutes * 60;
  const routeLengthCap = Math.max(6_000, Math.min(70_000, input.baselineDistanceMeters * 0.15));
  return Math.round(Math.max(6_000, Math.min(routeLengthCap, targetAdditionalDistance * 0.5)));
}

function offsetPerpendicular(
  point: LatLng,
  previous: LatLng,
  next: LatLng,
  meters: number,
): LatLng {
  const latitudeMeters = 111_320;
  const longitudeMeters = Math.max(1, latitudeMeters * Math.cos((point.lat * Math.PI) / 180));
  const north = (next.lat - previous.lat) * latitudeMeters;
  const east = (next.lng - previous.lng) * longitudeMeters;
  const length = Math.hypot(north, east);
  if (length <= 0) return point;
  const offsetNorth = (-east / length) * meters;
  const offsetEast = (north / length) * meters;
  return {
    lat: point.lat + offsetNorth / latitudeMeters,
    lng: point.lng + offsetEast / longitudeMeters,
  };
}

export function durationAwareCorridorSamples(input: {
  samples: LatLng[];
  baselineDistanceMeters: number;
  baselineDurationSeconds: number;
  targetExtraMinutes: number[];
}): DurationAwareCorridorSample[] {
  if (input.samples.length === 0 || input.targetExtraMinutes.length === 0) return [];
  return input.samples.map((sample, index) => {
    const targetIndex = Math.min(
      input.targetExtraMinutes.length - 1,
      Math.floor(((index + 1) * input.targetExtraMinutes.length) / input.samples.length),
    );
    const targetExtraMinutes = input.targetExtraMinutes[targetIndex];
    const lateralDisplacementMeters = targetLateralDisplacementMeters({
      baselineDistanceMeters: input.baselineDistanceMeters,
      baselineDurationSeconds: input.baselineDurationSeconds,
      targetExtraMinutes,
    });
    return {
      center: offsetPerpendicular(
        sample,
        input.samples[Math.max(0, index - 1)],
        input.samples[Math.min(input.samples.length - 1, index + 1)],
        lateralDisplacementMeters,
      ),
      targetExtraMinutes,
      lateralDisplacementMeters,
      journeyProgress: (index + 1) / (input.samples.length + 1),
    };
  });
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
}): {
  plans: ScenicCorridorPlan[];
  considered: number;
  rejectedDuplicate: number;
  rejectedBacktracking: number;
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
      const signature = pair
        .map((waypoint) => waypoint.id)
        .sort()
        .join(":");
      proposals.push({
        kind,
        reason: CORRIDOR_REASON[kind],
        waypoints: pair,
        estimatedDetourMeters: pair.reduce(
          (sum, waypoint) => sum + waypoint.estimatedDetourMeters,
          0,
        ),
        signature,
      });
    } else {
      const waypoint = waypoints[0];
      proposals.push({
        kind,
        reason: CORRIDOR_REASON[kind],
        waypoints: [waypoint],
        estimatedDetourMeters: waypoint.estimatedDetourMeters,
        signature: waypoint.id,
      });
    }
  }
  for (const kind of CORRIDOR_ORDER) {
    const waypoints = groups.get(kind) ?? [];
    for (const waypoint of waypoints.slice(
      0,
      input.targetDetourMeters?.length ? waypoints.length : 2,
    )) {
      if (proposals.some((plan) => plan.signature === waypoint.id)) continue;
      proposals.push({
        kind,
        reason: CORRIDOR_REASON[kind],
        waypoints: [waypoint],
        estimatedDetourMeters: waypoint.estimatedDetourMeters,
        signature: waypoint.id,
      });
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
          const signature = pair
            .map((waypoint) => waypoint.id)
            .sort()
            .join(":");
          if (proposals.some((plan) => plan.signature === signature)) continue;
          proposals.push({
            kind,
            reason: CORRIDOR_REASON[kind],
            waypoints: pair,
            estimatedDetourMeters,
            signature,
          });
        }
      }
    }
  }

  const attempted = input.attemptedSignatures ?? new Set<string>();
  const attemptedKinds = input.attemptedKinds ?? new Set<ScenicCorridorKind>();
  const availablePlans = proposals
    .filter((plan) => !attempted.has(plan.signature))
    .sort((a, b) => Number(attemptedKinds.has(a.kind)) - Number(attemptedKinds.has(b.kind)));
  return {
    ...planning,
    plans:
      input.targetDetourMeters?.length && input.maximumPlans > 0
        ? selectPlansForDetourTargets(availablePlans, input.targetDetourMeters, input.maximumPlans)
        : availablePlans.slice(0, input.maximumPlans),
  };
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
      a.id.localeCompare(b.id),
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
