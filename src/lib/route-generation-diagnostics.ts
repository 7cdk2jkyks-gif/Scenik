export type LongAttemptStatus = "COMPLETED" | "FAILED" | "EFFECTIVE_COLLISION" | "NO_PLAN";

export function candidateByRequestLocalId<T extends { candidateId: string | null }>(
  candidates: T[],
  candidateId: string,
): T | undefined {
  return candidates.find((candidate) => candidate.candidateId === candidateId);
}

export type LongAttemptResult = {
  status: LongAttemptStatus;
  actualAddedMinutes: number | null;
};

export type LongAttemptExecution = LongAttemptResult & {
  intendedTargetMinutes: number;
  adaptiveTargetMinutes: number;
};

export async function runSequentialLongAttempts(input: {
  intendedTargets: number[];
  maximumExtraMinutes: number;
  adaptiveTarget: (input: {
    nextTargetMinutes: number;
    priorIntendedMinutes: number;
    priorActualMinutes: number;
    maximumExtraMinutes: number;
  }) => number;
  execute: (input: {
    intendedTargetMinutes: number;
    adaptiveTargetMinutes: number;
  }) => Promise<LongAttemptResult>;
}): Promise<LongAttemptExecution[]> {
  const executions: LongAttemptExecution[] = [];
  let priorTargetResult: { intended: number; actual: number } | null = null;

  for (const intendedTargetMinutes of input.intendedTargets) {
    const adaptiveTargetMinutes = priorTargetResult
      ? input.adaptiveTarget({
          nextTargetMinutes: intendedTargetMinutes,
          priorIntendedMinutes: priorTargetResult.intended,
          priorActualMinutes: priorTargetResult.actual,
          maximumExtraMinutes: input.maximumExtraMinutes,
        })
      : intendedTargetMinutes;
    const result = await input.execute({ intendedTargetMinutes, adaptiveTargetMinutes });
    executions.push({ intendedTargetMinutes, adaptiveTargetMinutes, ...result });
    if (result.status === "COMPLETED" && result.actualAddedMinutes != null) {
      priorTargetResult = {
        intended: intendedTargetMinutes,
        actual: result.actualAddedMinutes,
      };
    }
  }

  return executions;
}

type SafeAttemptDiagnostic = {
  candidateId: string;
  candidateSource: "fastest" | "google" | "scenik";
  explorationStage: number | null;
  intendedTargetMinutes: number | null;
  adaptiveTargetMinutes: number | null;
  actualAddedMinutes: number | null;
  outcomeClassification: string;
  duplicateEligible: boolean | null;
  budgetEligible: boolean | null;
  qualityEligible: boolean | null;
  preferredQualityEligible?: boolean | null;
  timeCommitmentEligible?: boolean | null;
  baselineScoreImprovement?: number | null;
  provisionalTimeCommitmentCandidate?: boolean | null;
  scenicScore: number | null;
  scoreBreakdown?: {
    naturalBeauty: number;
    pointsOfInterest: number;
    moodMatch: number;
    roadCharacter: number;
    themeMatch: number;
    diversity: number;
  } | null;
  allowanceUtilisation?: number | null;
  evidenceEligible?: boolean | null;
  targetBandEligible?: boolean | null;
  selected?: boolean;
  rejectionReason?: string | null;
  finalSelectionReason?: string | null;
  geometryDistanceMeters?: number | null;
  evidenceSampleCount?: number | null;
  evidenceConsidered?: number | null;
  evidenceMatchedToGeometry?: number | null;
  evidenceMatchedThroughWaypoints?: number | null;
  naturalEvidenceCount?: number | null;
  themeEvidenceCount?: number | null;
  moodEvidenceCount?: number | null;
  evidenceAssociationStatus?: string | null;
  routeShapeEligible?: boolean | null;
  routeShapeRejectionReason?: string | null;
  reverseOverlapDistanceMeters?: number | null;
  reverseOverlapRatio?: number | null;
  waypointSpurDetected?: boolean | null;
  affectedWaypointIndex?: number | null;
  waypointAssociationStatus?: string | null;
  routeShapeAnalysisStatus?: string | null;
  requestedWaypointForm?: "one-waypoint" | "two-waypoint-arc" | null;
  effectiveWaypointForm?: "one-waypoint" | "two-waypoint-arc" | null;
  effectiveProgress?: "early" | "middle" | "late" | "distributed" | null;
  effectiveOrientation?: "left" | "right" | "alternating-mixed" | null;
  effectiveWaypointCount?: number | null;
  refinementParentCandidateId?: string | null;
  refinementUpperCandidateId?: string | null;
  refinementAttemptNumber?: number | null;
  refinementStrategy?: "RELATED_BRACKET" | "BASELINE_ZERO_BRACKET" | "BOUNDED_EXPANSION" | null;
  refinementBracketLowerMinutes?: number | null;
  refinementBracketUpperMinutes?: number | null;
  refinementTargetBandReached?: boolean | null;
  refinementStopReason?: string | null;
};

const SAFE_EVIDENCE_ASSOCIATION_STATUSES = new Set([
  "ANALYSED",
  "MISSING_GEOMETRY",
  "MALFORMED_GEOMETRY",
  "GEOMETRY_LIMIT_EXCEEDED",
  "SAMPLE_LIMIT_EXCEEDED",
  "INDEX_LIMIT_EXCEEDED",
  "ASSOCIATION_FAILED",
  "WORK_LIMIT_EXCEEDED",
]);

function safeNonNegativeNumber(value: unknown, integer = false): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    (!integer || Number.isInteger(value))
    ? value
    : null;
}

function safeBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Scenic Scores and score deltas are bounded by the public 0–100 scoring scale. */
function safeScoreDifference(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= -100 && value <= 100
    ? Object.is(value, -0)
      ? 0
      : value
    : null;
}

function safeScenicScore(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? Object.is(value, -0)
      ? 0
      : value
    : null;
}

function safeRefinementCount(value: unknown): number | null {
  const count = safeNonNegativeNumber(value, true);
  return count != null && count <= 2 ? count : null;
}

function safeScenicRequestCount(value: unknown): number | null {
  const count = safeNonNegativeNumber(value, true);
  return count != null && count <= 6 ? count : null;
}

function safeEvidenceAssociationStatus(value: unknown): string | null {
  return typeof value === "string" && SAFE_EVIDENCE_ASSOCIATION_STATUSES.has(value) ? value : null;
}

const SAFE_REFINEMENT_STOP_REASONS = new Set([
  "TARGET_REACHED",
  "PROVIDER_REMAINED_BELOW_TARGET",
  "NO_SAFE_REFINEMENT_BRACKET",
  "NO_CALIBRATION_LOWER_BOUND",
  "NO_SAFE_CALIBRATION_UPPER",
  "NO_RELATED_PLAN_FAMILY",
  "NO_DISTINCT_DERIVED_CONSTRUCTION",
  "NO_CONSTRUCTION_HEADROOM",
  "PROVIDER_REQUEST_FAILED",
  "PROVIDER_RESPONSE_REJECTED",
  "PROVIDER_EVALUATION_FAILED",
  "REFINED_CANDIDATES_OVER_BUDGET",
  "REFINED_CANDIDATES_INCOHERENT",
  "ATTEMPT_CAPACITY_EXHAUSTED",
]);
const SAFE_RECOVERY_STOP_REASONS = new Set([
  "TARGET_REACHED",
  "SAFE_OBSERVATION_PRODUCED",
  "NO_RECOVERABLE_SHAPE_SEED",
  "NO_DISTINCT_RECOVERY_CONSTRUCTION",
  "RECOVERY_SHAPE_REJECTED",
  "RECOVERY_CAPACITY_EXHAUSTED",
  "PROVIDER_REQUEST_FAILED",
]);
const SAFE_FINAL_SELECTION_REASONS = new Set([
  "ZERO_MINUTE_BUDGET",
  "ONLY_ELIGIBLE_ROUTE",
  "TARGET_BAND_HIGHEST_SCENIC_QUALITY",
  "TIME_COMMITMENT_TARGET_FALLBACK",
  "MEANINGFUL_FALLBACK_HIGHEST_UTILISATION",
  "TIME_COMMITMENT_MEANINGFUL_FALLBACK",
  "WEAK_ROUTE_BEST_BALANCE",
  "BASELINE_FALLBACK",
  "BELOW_TARGET_BEST_BALANCE",
]);

function safeFinalSelectionReason(value: unknown): string | null {
  return typeof value === "string" && SAFE_FINAL_SELECTION_REASONS.has(value) ? value : null;
}

function safeCandidateId(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9-]{1,64}$/i.test(value) ? value : null;
}

export function buildRouteGenerationDiagnostic(input: {
  correlationId: string;
  requestedExtraMinutes: number;
  baselineDurationSeconds: number;
  plannedExplorationStages: Array<{
    radiusMeters: number;
    sampleCap: number;
    cumulativePlaceCap: number;
    cumulativeRouteCap: number;
    targetExtraMinutes: number[];
  }>;
  attemptsPlanned: number;
  attemptsCompleted: number;
  intendedTargetMinutes: number[];
  processedTargetMinutes?: number[];
  adaptiveTargetMinutes: number[];
  actualAddedMinutesReturned: number;
  outcomeClassification: string;
  candidateEligibility: SafeAttemptDiagnostic[];
  candidateScenicScores: number[];
  finalSelectionReason: string | null;
  totalServerProcessingDurationMs: number;
  durationRefinement?: {
    attempted: boolean;
    reachedTargetBand: boolean;
    attemptsUsed: number;
    safeConstructionsProduced: number;
    providerRequestsStarted: number;
    providerResponsesReturned: number;
    providerRequestsFailed: number;
    providerResponsesEvaluated: number;
    stopReason: string;
  } | null;
  constructionRecovery?: {
    attempted: boolean;
    seedsConsidered: number;
    safeConstructionsProduced: number;
    providerRequestsStarted: number;
    providerResponsesReturned: number;
    providerRequestsFailed: number;
    responsesEvaluated: number;
    stopReason: string;
  } | null;
  preferencePresence?: { mood: boolean; theme: boolean };
  attemptRoles?: Array<{
    target: number;
    side: "left" | "right" | "alternating-arc";
    progress: "early" | "middle" | "late" | "distributed";
    waypointForm: "one-waypoint" | "two-waypoint-arc";
    evidencePreference: "preference-match" | "overall-scenic" | "alternate-cluster";
  }>;
  attemptsStarted?: number;
  placesSummary?: { succeeded: number; failed: number; returned: number; accepted: number };
  evidenceSummary?: { accepted: number; distinctSets: number };
  constructionSummary?: {
    scheduled: number;
    processed: number;
    distinct: number;
    collisions: number;
    noPlan: number;
  };
  providerRouteSummary?: { succeeded: number; failed: number };
  candidateSummary?: { returned: number; recorded: number; refined: number };
}) {
  return {
    correlationId: input.correlationId,
    requestedExtraMinutes: input.requestedExtraMinutes,
    baselineDurationSeconds: input.baselineDurationSeconds,
    plannedExplorationStages: input.plannedExplorationStages.map((stage) => ({
      radiusMeters: stage.radiusMeters,
      sampleCap: stage.sampleCap,
      cumulativePlaceCap: stage.cumulativePlaceCap,
      cumulativeRouteCap: stage.cumulativeRouteCap,
      targetExtraMinutes: [...stage.targetExtraMinutes],
    })),
    attemptsPlanned: input.attemptsPlanned,
    attemptsCompleted: input.attemptsCompleted,
    intendedTargetMinutes: [...input.intendedTargetMinutes],
    ...(input.processedTargetMinutes
      ? { processedTargetMinutes: [...input.processedTargetMinutes] }
      : {}),
    adaptiveTargetMinutes: [...input.adaptiveTargetMinutes],
    actualAddedMinutesReturned: input.actualAddedMinutesReturned,
    outcomeClassification: input.outcomeClassification,
    candidateEligibility: input.candidateEligibility.map((candidate) => ({
      candidateId: candidate.candidateId,
      candidateSource: candidate.candidateSource,
      explorationStage: candidate.explorationStage,
      intendedTargetMinutes: candidate.intendedTargetMinutes,
      adaptiveTargetMinutes: candidate.adaptiveTargetMinutes,
      actualAddedMinutes: candidate.actualAddedMinutes,
      outcomeClassification: candidate.outcomeClassification,
      duplicateEligible: candidate.duplicateEligible,
      budgetEligible: candidate.budgetEligible,
      qualityEligible: candidate.qualityEligible,
      preferredQualityEligible: safeBoolean(candidate.preferredQualityEligible),
      timeCommitmentEligible: safeBoolean(candidate.timeCommitmentEligible),
      baselineScoreImprovement: safeScoreDifference(candidate.baselineScoreImprovement),
      provisionalTimeCommitmentCandidate: safeBoolean(candidate.provisionalTimeCommitmentCandidate),
      scenicScore: safeScenicScore(candidate.scenicScore),
      scoreBreakdown: candidate.scoreBreakdown
        ? {
            naturalBeauty: candidate.scoreBreakdown.naturalBeauty,
            pointsOfInterest: candidate.scoreBreakdown.pointsOfInterest,
            moodMatch: candidate.scoreBreakdown.moodMatch,
            roadCharacter: candidate.scoreBreakdown.roadCharacter,
            themeMatch: candidate.scoreBreakdown.themeMatch,
            diversity: candidate.scoreBreakdown.diversity,
          }
        : null,
      allowanceUtilisation: candidate.allowanceUtilisation ?? null,
      evidenceEligible: candidate.evidenceEligible ?? null,
      targetBandEligible: candidate.targetBandEligible ?? null,
      selected: candidate.selected ?? false,
      rejectionReason: candidate.rejectionReason ?? null,
      finalSelectionReason: candidate.selected
        ? safeFinalSelectionReason(candidate.finalSelectionReason)
        : null,
      geometryDistanceMeters: safeNonNegativeNumber(candidate.geometryDistanceMeters, true),
      evidenceSampleCount: safeNonNegativeNumber(candidate.evidenceSampleCount, true),
      evidenceConsidered: safeNonNegativeNumber(candidate.evidenceConsidered, true),
      evidenceMatchedToGeometry: safeNonNegativeNumber(candidate.evidenceMatchedToGeometry, true),
      evidenceMatchedThroughWaypoints: safeNonNegativeNumber(
        candidate.evidenceMatchedThroughWaypoints,
        true,
      ),
      naturalEvidenceCount: safeNonNegativeNumber(candidate.naturalEvidenceCount),
      themeEvidenceCount: safeNonNegativeNumber(candidate.themeEvidenceCount),
      moodEvidenceCount: safeNonNegativeNumber(candidate.moodEvidenceCount),
      evidenceAssociationStatus: safeEvidenceAssociationStatus(candidate.evidenceAssociationStatus),
      routeShapeEligible: candidate.routeShapeEligible ?? null,
      routeShapeRejectionReason: candidate.routeShapeRejectionReason ?? null,
      reverseOverlapDistanceMeters: candidate.reverseOverlapDistanceMeters ?? null,
      reverseOverlapRatio: candidate.reverseOverlapRatio ?? null,
      waypointSpurDetected: candidate.waypointSpurDetected ?? null,
      affectedWaypointIndex: candidate.affectedWaypointIndex ?? null,
      waypointAssociationStatus: candidate.waypointAssociationStatus ?? null,
      routeShapeAnalysisStatus: candidate.routeShapeAnalysisStatus ?? null,
      ...(candidate.requestedWaypointForm != null || candidate.effectiveWaypointForm != null
        ? {
            requestedWaypointForm: candidate.requestedWaypointForm ?? null,
            effectiveWaypointForm: candidate.effectiveWaypointForm ?? null,
            effectiveProgress: candidate.effectiveProgress ?? null,
            effectiveOrientation: candidate.effectiveOrientation ?? null,
            effectiveWaypointCount:
              safeNonNegativeNumber(candidate.effectiveWaypointCount, true) ?? null,
          }
        : {}),
      ...(candidate.refinementAttemptNumber != null
        ? {
            refinementParentCandidateId: safeCandidateId(candidate.refinementParentCandidateId),
            refinementUpperCandidateId: safeCandidateId(candidate.refinementUpperCandidateId),
            refinementAttemptNumber: safeNonNegativeNumber(candidate.refinementAttemptNumber, true),
            refinementStrategy:
              candidate.refinementStrategy === "RELATED_BRACKET" ||
              candidate.refinementStrategy === "BASELINE_ZERO_BRACKET" ||
              candidate.refinementStrategy === "BOUNDED_EXPANSION"
                ? candidate.refinementStrategy
                : null,
            refinementBracketLowerMinutes: safeNonNegativeNumber(
              candidate.refinementBracketLowerMinutes,
            ),
            refinementBracketUpperMinutes: safeNonNegativeNumber(
              candidate.refinementBracketUpperMinutes,
            ),
            refinementTargetBandReached: candidate.refinementTargetBandReached === true,
            refinementStopReason:
              typeof candidate.refinementStopReason === "string" &&
              SAFE_REFINEMENT_STOP_REASONS.has(candidate.refinementStopReason)
                ? candidate.refinementStopReason
                : null,
          }
        : {}),
    })),
    candidateScenicScores: input.candidateScenicScores
      .map(safeScenicScore)
      .filter((score): score is number => score != null),
    finalSelectionReason: safeFinalSelectionReason(input.finalSelectionReason),
    totalServerProcessingDurationMs: input.totalServerProcessingDurationMs,
    ...(input.durationRefinement
      ? {
          durationRefinement: {
            attempted: input.durationRefinement.attempted === true,
            reachedTargetBand: input.durationRefinement.reachedTargetBand === true,
            // attemptsUsed means actual provider requests started.
            attemptsUsed: safeRefinementCount(input.durationRefinement.attemptsUsed) ?? 0,
            safeConstructionsProduced:
              safeRefinementCount(input.durationRefinement.safeConstructionsProduced) ?? 0,
            providerRequestsStarted:
              safeRefinementCount(input.durationRefinement.providerRequestsStarted) ?? 0,
            providerResponsesReturned:
              safeRefinementCount(input.durationRefinement.providerResponsesReturned) ?? 0,
            providerRequestsFailed:
              safeRefinementCount(input.durationRefinement.providerRequestsFailed) ?? 0,
            providerResponsesEvaluated:
              safeRefinementCount(input.durationRefinement.providerResponsesEvaluated) ?? 0,
            stopReason: SAFE_REFINEMENT_STOP_REASONS.has(input.durationRefinement.stopReason)
              ? input.durationRefinement.stopReason
              : "NO_SAFE_REFINEMENT_BRACKET",
          },
        }
      : {}),
    ...(input.constructionRecovery
      ? {
          constructionRecovery: {
            attempted: input.constructionRecovery.attempted === true,
            seedsConsidered:
              safeScenicRequestCount(input.constructionRecovery.seedsConsidered) ?? 0,
            safeConstructionsProduced:
              safeRefinementCount(input.constructionRecovery.safeConstructionsProduced) ?? 0,
            providerRequestsStarted:
              safeRefinementCount(input.constructionRecovery.providerRequestsStarted) ?? 0,
            providerResponsesReturned:
              safeRefinementCount(input.constructionRecovery.providerResponsesReturned) ?? 0,
            providerRequestsFailed:
              safeRefinementCount(input.constructionRecovery.providerRequestsFailed) ?? 0,
            responsesEvaluated:
              safeRefinementCount(input.constructionRecovery.responsesEvaluated) ?? 0,
            stopReason: SAFE_RECOVERY_STOP_REASONS.has(input.constructionRecovery.stopReason)
              ? input.constructionRecovery.stopReason
              : "NO_RECOVERABLE_SHAPE_SEED",
          },
        }
      : {}),
  };
}

export type RouteGenerationDiagnostic = ReturnType<typeof buildRouteGenerationDiagnostic>;

/**
 * Server-response projection. A false server-authorised gate returns no
 * diagnostic property at all, rather than a client-visible disabled payload.
 */
export function internalRouteDiagnosticResponse(
  authorised: boolean,
  diagnostic: RouteGenerationDiagnostic,
): { routeGenerationDiagnostics?: RouteGenerationDiagnostic } {
  return authorised ? { routeGenerationDiagnostics: diagnostic } : {};
}

export function formatRouteGenerationDiagnosticForClipboard(
  diagnostic: RouteGenerationDiagnostic,
): string {
  return JSON.stringify(buildRouteGenerationDiagnostic(diagnostic), null, 2);
}

type ClipboardWriter = Pick<Clipboard, "writeText">;

export async function copyRouteDiagnostics(
  diagnostic: RouteGenerationDiagnostic,
  clipboard: ClipboardWriter | undefined,
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(formatRouteGenerationDiagnosticForClipboard(diagnostic));
    return true;
  } catch {
    return false;
  }
}

export function serializeRouteGenerationDiagnostic(
  input: Parameters<typeof buildRouteGenerationDiagnostic>[0],
): string {
  const diagnostic = buildRouteGenerationDiagnostic(input);
  const constructionSummary = (() => {
    const summary = input.constructionSummary;
    if (!summary) return null;
    const counts = [
      summary.scheduled,
      summary.processed,
      summary.distinct,
      summary.collisions,
      summary.noPlan,
    ];
    if (
      counts.some((count) => !Number.isSafeInteger(count) || count < 0 || count > 5) ||
      summary.processed > summary.scheduled ||
      summary.distinct + summary.collisions + summary.noPlan !== summary.processed
    )
      return null;
    return { ...summary };
  })();
  const candidates = diagnostic.candidateEligibility;
  const rejectionHistogram = candidates.reduce<Record<string, number>>((counts, candidate) => {
    const reason = candidate.rejectionReason ?? candidate.outcomeClassification;
    counts[reason] = (counts[reason] ?? 0) + 1;
    return counts;
  }, {});
  const bestInBand = (minimum: number, maximum: number) => {
    const best = candidates
      .filter(
        (candidate) =>
          candidate.candidateSource === "scenik" &&
          candidate.scenicScore != null &&
          candidate.actualAddedMinutes != null &&
          candidate.allowanceUtilisation != null &&
          candidate.allowanceUtilisation >= minimum &&
          candidate.allowanceUtilisation < maximum,
      )
      .sort(
        (a, b) =>
          (b.scenicScore ?? 0) - (a.scenicScore ?? 0) ||
          (b.actualAddedMinutes ?? 0) - (a.actualAddedMinutes ?? 0),
      )[0];
    return best
      ? { addedSeconds: Math.round((best.actualAddedMinutes ?? 0) * 60), score: best.scenicScore }
      : null;
  };
  const selected = candidates.find((candidate) => candidate.selected);
  return `scenik-route-summary-v3 ${JSON.stringify({
    correlationId: diagnostic.correlationId,
    requestedExtraMinutes: diagnostic.requestedExtraMinutes,
    baselineDurationSeconds: diagnostic.baselineDurationSeconds,
    preferencePresence: input.preferencePresence ?? { mood: null, theme: null },
    plannedTargets: diagnostic.plannedExplorationStages.flatMap(
      (stage) => stage.targetExtraMinutes,
    ),
    processedTargets: diagnostic.processedTargetMinutes ?? diagnostic.intendedTargetMinutes,
    intendedTargets:
      diagnostic.intendedTargetMinutes.length ===
      (diagnostic.processedTargetMinutes ?? diagnostic.intendedTargetMinutes).length
        ? diagnostic.intendedTargetMinutes
        : null,
    adaptiveTargets: diagnostic.adaptiveTargetMinutes,
    attemptRoles: input.attemptRoles ?? [],
    attemptsStarted: input.attemptsStarted ?? diagnostic.attemptsCompleted,
    attemptsCompleted: diagnostic.attemptsCompleted,
    places: input.placesSummary ?? null,
    evidence: input.evidenceSummary ?? null,
    constructions: constructionSummary,
    providerRoutes: input.providerRouteSummary ?? null,
    candidates: input.candidateSummary ?? null,
    rejectionHistogram,
    bestByBand: {
      target: bestInBand(0.75, Number.POSITIVE_INFINITY),
      meaningful: bestInBand(0.35, 0.75),
      weak: bestInBand(0, 0.35),
    },
    refinement: diagnostic.durationRefinement ?? null,
    recovery: diagnostic.constructionRecovery ?? null,
    selected: selected
      ? {
          band:
            (selected.allowanceUtilisation ?? 0) >= 0.75
              ? "target"
              : (selected.allowanceUtilisation ?? 0) >= 0.35
                ? "meaningful"
                : (selected.allowanceUtilisation ?? 0) > 0
                  ? "weak"
                  : "baseline",
          addedSeconds: Math.round((selected.actualAddedMinutes ?? 0) * 60),
          score: selected.scenicScore,
        }
      : null,
    outcomeClassification: diagnostic.outcomeClassification,
  })}`;
}
