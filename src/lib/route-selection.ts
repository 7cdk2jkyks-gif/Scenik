import type { ComputedDirections } from "./google-maps.server";
import type { ScenicEvidenceCounts } from "./scenic-waypoint";

export type ScoredRouteCandidate<TScore> = {
  directions: ComputedDirections;
  score: number;
  scoreResult: TScore;
  originalIndex: number;
  source?: "fastest" | "google" | "scenik";
  selectedWaypointReason?: string | null;
  evidence?: ScenicEvidenceCounts;
};

export type RouteSelection<TScore> = {
  selected: ScoredRouteCandidate<TScore>;
  candidates: ScoredRouteCandidate<TScore>[];
  eligible: ScoredRouteCandidate<TScore>[];
  fastestDurationSeconds: number;
  measuredExtraTimeSeconds: number;
  requestedExtraTimeBudgetSeconds: number;
};

export function maximumAllowedDurationSeconds(
  fastestDurationSeconds: number,
  requestedExtraMinutes: number,
): number {
  const baseline = Math.max(1, Math.round(fastestDurationSeconds));
  const budgetSeconds = Math.max(0, Math.min(14_400, Math.round(requestedExtraMinutes * 60)));
  return baseline + budgetSeconds;
}

function validMetric(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function routesAreNearIdentical(
  first: ComputedDirections,
  second: ComputedDirections,
): boolean {
  return (
    first.encodedPolyline === second.encodedPolyline ||
    (Math.abs(first.durationSeconds - second.durationSeconds) <= 30 &&
      Math.abs(first.distanceMeters - second.distanceMeters) <= 100)
  );
}

export function routesAreMeaningfullyDifferent(
  first: ComputedDirections,
  second: ComputedDirections,
): boolean {
  const points = (directions: ComputedDirections) =>
    directions.steps.flatMap((step) =>
      Number.isFinite(step.endLat) && Number.isFinite(step.endLng)
        ? [{ lat: step.endLat!, lng: step.endLng! }]
        : [],
    );
  const radians = (value: number) => (value * Math.PI) / 180;
  const distance = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
    const dLat = radians(b.lat - a.lat);
    const dLng = radians(b.lng - a.lng);
    const value =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 6_371_000 * 2 * Math.asin(Math.sqrt(value));
  };
  const firstPoints = points(first);
  const secondPoints = points(second);
  const hasSeparatedGeometry =
    firstPoints.length > 0 &&
    secondPoints.length > 0 &&
    [...firstPoints, ...secondPoints].some((point, index) => {
      const comparison = index < firstPoints.length ? secondPoints : firstPoints;
      return Math.min(...comparison.map((other) => distance(point, other))) >= 1_000;
    });
  return (
    first.encodedPolyline !== second.encodedPolyline &&
    (hasSeparatedGeometry ||
      Math.abs(first.durationSeconds - second.durationSeconds) >= 120 ||
      Math.abs(first.distanceMeters - second.distanceMeters) >= 1_500)
  );
}

export function deduplicateCandidates<TScore>(
  candidates: ScoredRouteCandidate<TScore>[],
): ScoredRouteCandidate<TScore>[] {
  return candidates.filter((candidate, index, all) => {
    if (
      !validMetric(candidate.directions.durationSeconds) ||
      candidate.directions.durationSeconds === 0 ||
      !validMetric(candidate.directions.distanceMeters) ||
      !candidate.directions.encodedPolyline
    ) {
      return false;
    }
    return !all.slice(0, index).some((prior) => {
      return routesAreNearIdentical(prior.directions, candidate.directions);
    });
  });
}

export function selectRouteCandidate<TScore>(
  inputCandidates: ScoredRouteCandidate<TScore>[],
  requestedExtraMinutes: number,
): RouteSelection<TScore> {
  const candidates = deduplicateCandidates(inputCandidates);
  const baseline = candidates.find((candidate) => candidate.originalIndex === 0);
  if (!baseline) throw new Error("BASELINE_ROUTE_UNAVAILABLE");

  const fastestDurationSeconds = Math.max(1, Math.round(baseline.directions.durationSeconds));
  const requestedExtraTimeBudgetSeconds = Math.max(
    0,
    Math.min(14_400, Math.round(requestedExtraMinutes * 60)),
  );
  const ceiling = maximumAllowedDurationSeconds(fastestDurationSeconds, requestedExtraMinutes);
  const eligible = candidates.filter(
    (candidate) => candidate.directions.durationSeconds <= ceiling,
  );

  const selected =
    requestedExtraTimeBudgetSeconds === 0
      ? baseline
      : ([...eligible].sort(
          (a, b) =>
            b.score - a.score ||
            a.directions.durationSeconds - b.directions.durationSeconds ||
            a.directions.distanceMeters - b.directions.distanceMeters ||
            a.originalIndex - b.originalIndex,
        )[0] ?? baseline);

  return {
    selected,
    candidates,
    eligible: eligible.length ? eligible : [baseline],
    fastestDurationSeconds,
    measuredExtraTimeSeconds: Math.max(
      0,
      Math.round(selected.directions.durationSeconds - fastestDurationSeconds),
    ),
    requestedExtraTimeBudgetSeconds,
  };
}
