import type { ComputedDirections } from "./google-maps.server";
import type { ScenicEvidenceCounts } from "./scenic-waypoint";

export type ScoredRouteCandidate<TScore> = {
  candidateId?: string;
  directions: ComputedDirections;
  score: number;
  scoreResult: TScore;
  originalIndex: number;
  source?: "fastest" | "google" | "scenik";
  selectedWaypointReason?: string | null;
  evidence?: ScenicEvidenceCounts;
  routeShapeEligible?: boolean;
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
    | "MEANINGFUL_FALLBACK"
    | "WEAK_ROUTE_SELECTED"
    | "BASELINE_FALLBACK"
    | "LONGER_WEAKENED_QUALITY"
    | "NO_TARGET_BAND_ROUTE";
};

export type CandidateSelectionDiagnostic = {
  candidateId: string | null;
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
    | "INCOHERENT_ROUTE"
    | "EVIDENCE_FREE_ROUTE"
    | "BELOW_ABSOLUTE_QUALITY_FLOOR"
    | "BELOW_WEAK_QUALITY_GUARDRAIL"
    | "BELOW_QUALITY_GUARDRAIL"
    | "LOWER_UTILISATION_OR_TIEBREAK"
    | null;
  selectionReason:
    | "ZERO_MINUTE_BUDGET"
    | "ONLY_ELIGIBLE_ROUTE"
    | "TARGET_BAND_HIGHEST_SCENIC_QUALITY"
    | "MEANINGFUL_FALLBACK_HIGHEST_UTILISATION"
    | "WEAK_ROUTE_BEST_BALANCE"
    | "BASELINE_FALLBACK"
    | "BELOW_TARGET_BEST_BALANCE"
    | null;
};

/** A deliberate time choice is considered fulfilled from 75% of the requested addition. */
export const MIN_TARGET_UTILISATION = 0.75;
/** Evidence-rich fixtures begin around 60; lower target routes are not strong enough to prefer. */
export const MIN_ACCEPTABLE_TARGET_SCORE = 60;
/** Never trade more than six Scenic Score points solely to consume the requested time. */
export const TIME_TARGET_SCENIC_QUALITY_GUARDRAIL = 6;
export const MIN_MEANINGFUL_UTILISATION = 0.35;

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
  const stableCandidates = [...candidates].sort((a, b) => a.originalIndex - b.originalIndex);
  return stableCandidates.filter((candidate, index, all) => {
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
    (candidate) =>
      candidate.directions.durationSeconds <= ceiling && candidate.routeShapeEligible !== false,
  );
  const highestEligibleScore = Math.max(...eligible.map((candidate) => candidate.score));
  const qualityGuardrailScore = highestEligibleScore - TIME_TARGET_SCENIC_QUALITY_GUARDRAIL;
  const hasRequiredEvidence = (candidate: ScoredRouteCandidate<TScore>) =>
    candidate.source !== "scenik" ||
    (candidate.evidence != null &&
      Object.values(candidate.evidence).some((count) => Number.isFinite(count) && count > 0));
  const utilisation = (candidate: ScoredRouteCandidate<TScore>) =>
    candidateBudgetUtilisation(
      fastestDurationSeconds,
      candidate.directions.durationSeconds,
      requestedExtraMinutes,
    );
  const safeQualityCandidates = eligible.filter(
    (candidate) =>
      candidate.originalIndex !== baseline.originalIndex &&
      candidate.directions.durationSeconds > fastestDurationSeconds &&
      candidate.score >= MIN_ACCEPTABLE_TARGET_SCORE &&
      hasRequiredEvidence(candidate),
  );
  const targetBandCandidates = safeQualityCandidates.filter(
    (candidate) => utilisation(candidate) >= MIN_TARGET_UTILISATION,
  );
  const meaningfulFallbackCandidates = safeQualityCandidates.filter((candidate) => {
    const value = utilisation(candidate);
    return value >= MIN_MEANINGFUL_UTILISATION && value < MIN_TARGET_UTILISATION;
  });
  const weakCandidates = safeQualityCandidates.filter((candidate) => {
    const value = utilisation(candidate);
    return (
      value > 0 && value < MIN_MEANINGFUL_UTILISATION && candidate.score >= qualityGuardrailScore
    );
  });

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
          if (targetBandCandidates.length > 0)
            return [...targetBandCandidates].sort(deterministicTargetSort)[0];
          if (meaningfulFallbackCandidates.length > 0)
            return [...meaningfulFallbackCandidates].sort(deterministicFallbackSort)[0];
          if (weakCandidates.length > 0)
            return [...weakCandidates].sort(deterministicFallbackSort)[0];
          return baseline;
        })();

  const timeTargetOutcome =
    requestedExtraTimeBudgetSeconds === 0
      ? "ZERO_TARGET"
      : targetBandCandidates.some((candidate) => candidate.originalIndex === selected.originalIndex)
        ? "TARGET_MET"
        : meaningfulFallbackCandidates.some(
              (candidate) => candidate.originalIndex === selected.originalIndex,
            )
          ? "MEANINGFUL_FALLBACK"
          : weakCandidates.some((candidate) => candidate.originalIndex === selected.originalIndex)
            ? "WEAK_ROUTE_SELECTED"
            : "BASELINE_FALLBACK";

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
    const routeShapeEligible = candidate.routeShapeEligible !== false;
    const eligible =
      !invalid && !duplicate && routeShapeEligible && directions.durationSeconds <= ceiling;
    const selected = candidate.originalIndex === selection.selected.originalIndex;
    const scoreDifference = highestEligibleScore - candidate.score;
    const utilisation = candidateBudgetUtilisation(
      selection.fastestDurationSeconds,
      directions.durationSeconds,
      requestedExtraMinutes,
    );
    const evidenceStrength = candidate.evidence
      ? Object.values(candidate.evidence).reduce((sum, count) => sum + count, 0)
      : null;
    const evidenceFree = candidate.source === "scenik" && (evidenceStrength ?? 0) <= 0;
    const belowAbsoluteQualityFloor =
      utilisation > 0 && candidate.score < MIN_ACCEPTABLE_TARGET_SCORE;
    const belowWeakQualityGuardrail =
      utilisation > 0 &&
      utilisation < MIN_MEANINGFUL_UTILISATION &&
      scoreDifference > TIME_TARGET_SCENIC_QUALITY_GUARDRAIL;
    const rejectionReason = selected
      ? null
      : invalid
        ? "INVALID_ROUTE_METRICS"
        : duplicate
          ? "DUPLICATE_ROUTE"
          : !routeShapeEligible
            ? "INCOHERENT_ROUTE"
            : !eligible
              ? "OVER_TIME_BUDGET"
              : evidenceFree
                ? "EVIDENCE_FREE_ROUTE"
                : belowAbsoluteQualityFloor
                  ? "BELOW_ABSOLUTE_QUALITY_FLOOR"
                  : belowWeakQualityGuardrail
                    ? "BELOW_WEAK_QUALITY_GUARDRAIL"
                    : "LOWER_UTILISATION_OR_TIEBREAK";
    const selectionReason = !selected
      ? null
      : requestedExtraMinutes <= 0
        ? "ZERO_MINUTE_BUDGET"
        : selection.timeTargetOutcome === "TARGET_MET"
          ? "TARGET_BAND_HIGHEST_SCENIC_QUALITY"
          : selection.timeTargetOutcome === "MEANINGFUL_FALLBACK"
            ? "MEANINGFUL_FALLBACK_HIGHEST_UTILISATION"
            : selection.timeTargetOutcome === "WEAK_ROUTE_SELECTED"
              ? "WEAK_ROUTE_BEST_BALANCE"
              : "BASELINE_FALLBACK";
    return {
      candidateId: candidate.candidateId ?? null,
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
