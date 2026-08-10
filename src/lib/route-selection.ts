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
  timeTargetOutcome:
    | "ZERO_TARGET"
    | "TARGET_MET"
    | "LONGER_WEAKENED_QUALITY"
    | "NO_TARGET_BAND_ROUTE";
};

export type CandidateSelectionDiagnostic = {
  originalIndex: number;
  source: ScoredRouteCandidate<unknown>["source"];
  durationSeconds: number;
  addedMinutes: number;
  allowanceUtilisation: number;
  score: number;
  evidenceStrength: number | null;
  evidence: ScenicEvidenceCounts | null;
  duplicate: boolean;
  eligible: boolean;
  selected: boolean;
  rejectionReason:
    | "INVALID_ROUTE_METRICS"
    | "DUPLICATE_ROUTE"
    | "OVER_TIME_BUDGET"
    | "BELOW_QUALITY_GUARDRAIL"
    | "LOWER_UTILISATION_OR_TIEBREAK"
    | null;
  selectionReason:
    | "ZERO_MINUTE_BUDGET"
    | "ONLY_ELIGIBLE_ROUTE"
    | "TARGET_BAND_HIGHEST_SCENIC_QUALITY"
    | "BELOW_TARGET_BEST_BALANCE"
    | null;
};

/** A deliberate time choice is considered fulfilled from 75% of the requested addition. */
export const MIN_TARGET_UTILISATION = 0.75;
/** Evidence-rich fixtures begin around 60; lower target routes are not strong enough to prefer. */
export const MIN_ACCEPTABLE_TARGET_SCORE = 60;
/** Never trade more than six Scenic Score points solely to consume the requested time. */
export const TIME_TARGET_SCENIC_QUALITY_GUARDRAIL = 6;

export type BudgetUtilisationBand = "none" | "weak" | "acceptable" | "strong" | "near-full";

export function candidateBudgetUtilisation(
  fastestDurationSeconds: number,
  candidateDurationSeconds: number,
  requestedExtraMinutes: number,
): number {
  const budgetSeconds = Math.max(0, requestedExtraMinutes * 60);
  if (budgetSeconds === 0) return 0;
  return Math.max(
    0,
    Math.min(1, (candidateDurationSeconds - fastestDurationSeconds) / budgetSeconds),
  );
}

export function budgetUtilisationBand(utilisation: number): BudgetUtilisationBand {
  if (utilisation <= 0) return "none";
  if (utilisation < 0.35) return "weak";
  if (utilisation < 0.6) return "acceptable";
  if (utilisation < 0.85) return "strong";
  return "near-full";
}

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
  const highestEligibleScore = Math.max(...eligible.map((candidate) => candidate.score));
  const qualityGuardrailScore = highestEligibleScore - TIME_TARGET_SCENIC_QUALITY_GUARDRAIL;
  const targetBandCandidates = eligible.filter(
    (candidate) =>
      candidateBudgetUtilisation(
        fastestDurationSeconds,
        candidate.directions.durationSeconds,
        requestedExtraMinutes,
      ) >= MIN_TARGET_UTILISATION,
  );
  const acceptableTargetBandCandidates = targetBandCandidates.filter(
    (candidate) =>
      candidate.score >= MIN_ACCEPTABLE_TARGET_SCORE && candidate.score >= qualityGuardrailScore,
  );

  const deterministicTargetSort = (
    a: ScoredRouteCandidate<TScore>,
    b: ScoredRouteCandidate<TScore>,
  ) =>
    b.score - a.score ||
    candidateBudgetUtilisation(
      fastestDurationSeconds,
      b.directions.durationSeconds,
      requestedExtraMinutes,
    ) -
      candidateBudgetUtilisation(
        fastestDurationSeconds,
        a.directions.durationSeconds,
        requestedExtraMinutes,
      ) ||
    a.directions.distanceMeters - b.directions.distanceMeters ||
    a.originalIndex - b.originalIndex;

  const deterministicFallbackSort = (
    a: ScoredRouteCandidate<TScore>,
    b: ScoredRouteCandidate<TScore>,
  ) =>
    candidateBudgetUtilisation(
      fastestDurationSeconds,
      b.directions.durationSeconds,
      requestedExtraMinutes,
    ) -
      candidateBudgetUtilisation(
        fastestDurationSeconds,
        a.directions.durationSeconds,
        requestedExtraMinutes,
      ) ||
    b.score - a.score ||
    a.directions.durationSeconds - b.directions.durationSeconds ||
    a.directions.distanceMeters - b.directions.distanceMeters ||
    a.originalIndex - b.originalIndex;

  const selected =
    requestedExtraTimeBudgetSeconds === 0
      ? baseline
      : (() => {
          if (acceptableTargetBandCandidates.length > 0)
            return [...acceptableTargetBandCandidates].sort(deterministicTargetSort)[0];
          const qualityEquivalent = eligible.filter(
            (candidate) =>
              candidateBudgetUtilisation(
                fastestDurationSeconds,
                candidate.directions.durationSeconds,
                requestedExtraMinutes,
              ) < MIN_TARGET_UTILISATION && candidate.score >= qualityGuardrailScore,
          );
          return [...qualityEquivalent].sort(deterministicFallbackSort)[0] ?? baseline;
        })();

  const timeTargetOutcome =
    requestedExtraTimeBudgetSeconds === 0
      ? "ZERO_TARGET"
      : acceptableTargetBandCandidates.some(
            (candidate) => candidate.originalIndex === selected.originalIndex,
          )
        ? "TARGET_MET"
        : targetBandCandidates.length > 0
          ? "LONGER_WEAKENED_QUALITY"
          : "NO_TARGET_BAND_ROUTE";

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
    timeTargetOutcome,
  };
}

export function candidateSelectionDiagnostics<TScore>(
  inputCandidates: ScoredRouteCandidate<TScore>[],
  selection: RouteSelection<TScore>,
  requestedExtraMinutes: number,
): CandidateSelectionDiagnostic[] {
  const ceiling = maximumAllowedDurationSeconds(
    selection.fastestDurationSeconds,
    requestedExtraMinutes,
  );
  const highestEligibleScore = Math.max(...selection.eligible.map((candidate) => candidate.score));
  return inputCandidates.map((candidate, index) => {
    const directions = candidate.directions;
    const invalid =
      !validMetric(directions.durationSeconds) ||
      directions.durationSeconds === 0 ||
      !validMetric(directions.distanceMeters) ||
      !directions.encodedPolyline;
    const duplicate =
      !invalid &&
      inputCandidates
        .slice(0, index)
        .some((prior) => routesAreNearIdentical(prior.directions, directions));
    const eligible = !invalid && !duplicate && directions.durationSeconds <= ceiling;
    const selected = candidate.originalIndex === selection.selected.originalIndex;
    const scoreDifference = highestEligibleScore - candidate.score;
    const utilisation = candidateBudgetUtilisation(
      selection.fastestDurationSeconds,
      directions.durationSeconds,
      requestedExtraMinutes,
    );
    const belowTargetQualityGuardrail =
      utilisation >= MIN_TARGET_UTILISATION &&
      (candidate.score < MIN_ACCEPTABLE_TARGET_SCORE ||
        scoreDifference > TIME_TARGET_SCENIC_QUALITY_GUARDRAIL);
    const rejectionReason = selected
      ? null
      : invalid
        ? "INVALID_ROUTE_METRICS"
        : duplicate
          ? "DUPLICATE_ROUTE"
          : !eligible
            ? "OVER_TIME_BUDGET"
            : belowTargetQualityGuardrail || scoreDifference > TIME_TARGET_SCENIC_QUALITY_GUARDRAIL
              ? "BELOW_QUALITY_GUARDRAIL"
              : "LOWER_UTILISATION_OR_TIEBREAK";
    const evidenceStrength = candidate.evidence
      ? Object.values(candidate.evidence).reduce((sum, count) => sum + count, 0)
      : null;
    const selectionReason = !selected
      ? null
      : requestedExtraMinutes <= 0
        ? "ZERO_MINUTE_BUDGET"
        : selection.eligible.length === 1
          ? "ONLY_ELIGIBLE_ROUTE"
          : candidateBudgetUtilisation(
                selection.fastestDurationSeconds,
                candidate.directions.durationSeconds,
                requestedExtraMinutes,
              ) >= MIN_TARGET_UTILISATION
            ? "TARGET_BAND_HIGHEST_SCENIC_QUALITY"
            : "BELOW_TARGET_BEST_BALANCE";
    return {
      originalIndex: candidate.originalIndex,
      source: candidate.source,
      durationSeconds: directions.durationSeconds,
      addedMinutes:
        Math.round(
          (Math.max(0, directions.durationSeconds - selection.fastestDurationSeconds) / 60) * 10,
        ) / 10,
      allowanceUtilisation: utilisation,
      score: candidate.score,
      evidenceStrength,
      evidence: candidate.evidence ?? null,
      duplicate,
      eligible,
      selected,
      rejectionReason,
      selectionReason,
    };
  });
}
