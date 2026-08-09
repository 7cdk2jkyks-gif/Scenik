import {
  haversineDistanceMeters,
  planScenicWaypointsWithDiagnostics,
  type LatLng,
  type ScenicPlace,
  type ScenicWaypointPlan,
} from "./scenic-waypoint";

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
      { radiusMeters: 900, sampleCap: 2, cumulativePlaceCap: 14, cumulativeRouteCap: 1 },
      { radiusMeters: 1_500, sampleCap: 3, cumulativePlaceCap: 24, cumulativeRouteCap: 2 },
    ];
  }
  if (extraMinutes <= 30) {
    return [
      { radiusMeters: 1_200, sampleCap: 3, cumulativePlaceCap: 20, cumulativeRouteCap: 1 },
      { radiusMeters: 2_300, sampleCap: 4, cumulativePlaceCap: 34, cumulativeRouteCap: 2 },
      { radiusMeters: 3_500, sampleCap: 5, cumulativePlaceCap: 45, cumulativeRouteCap: 4 },
    ];
  }
  return [
    { radiusMeters: 1_500, sampleCap: 3, cumulativePlaceCap: 24, cumulativeRouteCap: 2 },
    { radiusMeters: 3_500, sampleCap: 5, cumulativePlaceCap: 48, cumulativeRouteCap: 4 },
    { radiusMeters: 6_000, sampleCap: 7, cumulativePlaceCap: 70, cumulativeRouteCap: 6 },
  ];
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
    for (const waypoint of waypoints.slice(0, 2)) {
      if (proposals.some((plan) => plan.signature === waypoint.id)) continue;
      proposals.push({
        kind,
        reason: CORRIDOR_REASON[kind],
        waypoints: [waypoint],
        estimatedDetourMeters: waypoint.estimatedDetourMeters,
        signature: waypoint.id,
      });
    }
  }

  const attempted = input.attemptedSignatures ?? new Set<string>();
  const attemptedKinds = input.attemptedKinds ?? new Set<ScenicCorridorKind>();
  return {
    ...planning,
    plans: proposals
      .filter((plan) => !attempted.has(plan.signature))
      .sort((a, b) => Number(attemptedKinds.has(a.kind)) - Number(attemptedKinds.has(b.kind)))
      .slice(0, input.maximumPlans),
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
  return utilisation >= 0.7 && utilisation <= 1;
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
    100 - input.bestScore <= Math.max(0, threshold) && input.bestQualityEquivalentUtilisation >= 0.7
  );
}
