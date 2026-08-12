export type LongAttemptStatus = "COMPLETED" | "FAILED" | "NO_PLAN";

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
  intendedTargetMinutes: number | null;
  adaptiveTargetMinutes: number | null;
  actualAddedMinutes: number | null;
  outcomeClassification: string;
  duplicateEligible: boolean | null;
  budgetEligible: boolean | null;
  qualityEligible: boolean | null;
  scenicScore: number | null;
  routeShapeEligible?: boolean | null;
  routeShapeRejectionReason?: string | null;
  reverseOverlapDistanceMeters?: number | null;
  reverseOverlapRatio?: number | null;
  waypointSpurDetected?: boolean | null;
  affectedWaypointIndex?: number | null;
  waypointAssociationStatus?: string | null;
  routeShapeAnalysisStatus?: string | null;
};

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
  adaptiveTargetMinutes: number[];
  actualAddedMinutesReturned: number;
  outcomeClassification: string;
  candidateEligibility: SafeAttemptDiagnostic[];
  candidateScenicScores: number[];
  finalSelectionReason: string | null;
  totalServerProcessingDurationMs: number;
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
    adaptiveTargetMinutes: [...input.adaptiveTargetMinutes],
    actualAddedMinutesReturned: input.actualAddedMinutesReturned,
    outcomeClassification: input.outcomeClassification,
    candidateEligibility: input.candidateEligibility.map((candidate) => ({
      intendedTargetMinutes: candidate.intendedTargetMinutes,
      adaptiveTargetMinutes: candidate.adaptiveTargetMinutes,
      actualAddedMinutes: candidate.actualAddedMinutes,
      outcomeClassification: candidate.outcomeClassification,
      duplicateEligible: candidate.duplicateEligible,
      budgetEligible: candidate.budgetEligible,
      qualityEligible: candidate.qualityEligible,
      scenicScore: candidate.scenicScore,
      routeShapeEligible: candidate.routeShapeEligible ?? null,
      routeShapeRejectionReason: candidate.routeShapeRejectionReason ?? null,
      reverseOverlapDistanceMeters: candidate.reverseOverlapDistanceMeters ?? null,
      reverseOverlapRatio: candidate.reverseOverlapRatio ?? null,
      waypointSpurDetected: candidate.waypointSpurDetected ?? null,
      affectedWaypointIndex: candidate.affectedWaypointIndex ?? null,
      waypointAssociationStatus: candidate.waypointAssociationStatus ?? null,
      routeShapeAnalysisStatus: candidate.routeShapeAnalysisStatus ?? null,
    })),
    candidateScenicScores: [...input.candidateScenicScores],
    finalSelectionReason: input.finalSelectionReason,
    totalServerProcessingDurationMs: input.totalServerProcessingDurationMs,
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
  return `scenik-route-engine-v2 ${JSON.stringify(buildRouteGenerationDiagnostic(input))}`;
}
