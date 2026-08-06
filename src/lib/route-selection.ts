import type { ComputedDirections } from "./google-maps.server";

export type ScoredRouteCandidate<TScore> = {
  directions: ComputedDirections;
  score: number;
  scoreResult: TScore;
  originalIndex: number;
};

export type RouteSelection<TScore> = {
  selected: ScoredRouteCandidate<TScore>;
  candidates: ScoredRouteCandidate<TScore>[];
  eligible: ScoredRouteCandidate<TScore>[];
  fastestDurationSeconds: number;
  measuredExtraTimeSeconds: number;
  requestedExtraTimeBudgetSeconds: number;
};

const EQUIVALENT_DURATION_TOLERANCE_SECONDS = 30;

function validMetric(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
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
      const closeMetrics =
        Math.abs(prior.directions.durationSeconds - candidate.directions.durationSeconds) <= 30 &&
        Math.abs(prior.directions.distanceMeters - candidate.directions.distanceMeters) <= 100;
      return (
        prior.directions.encodedPolyline === candidate.directions.encodedPolyline || closeMetrics
      );
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
  const ceiling =
    fastestDurationSeconds +
    (requestedExtraTimeBudgetSeconds === 0
      ? EQUIVALENT_DURATION_TOLERANCE_SECONDS
      : requestedExtraTimeBudgetSeconds);
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
