import { PREFERRED_TARGET_UTILISATION } from "./corridor-exploration";

export type LongAttemptStatus = "COMPLETED" | "FAILED" | "NO_PLAN";

export type LongAttemptResult = {
  status: LongAttemptStatus;
  actualAddedMinutes: number | null;
};

export type LongAttemptExecution = LongAttemptResult & {
  intendedTargetMinutes: number;
  adaptiveTargetMinutes: number;
  adaptationDirection: import("./corridor-exploration").DurationAdaptationDirection;
  lowerObservedActualMinutes: number | null;
  upperObservedActualMinutes: number | null;
  preferredTargetMinutes: number;
  bracketedInterpolationUsed: boolean;
};

export async function runSequentialLongAttempts(input: {
  intendedTargets: number[];
  maximumExtraMinutes: number;
  lowerObservation?: import("./corridor-exploration").DurationObservation | null;
  adaptiveTarget: (input: {
    nextTargetMinutes: number;
    priorIntendedMinutes: number;
    priorActualMinutes: number;
    maximumExtraMinutes: number;
    lowerObservation?: import("./corridor-exploration").DurationObservation | null;
  }) => import("./corridor-exploration").DurationTargetRefinement;
  execute: (input: {
    intendedTargetMinutes: number;
    adaptiveTargetMinutes: number;
  }) => Promise<LongAttemptResult>;
}): Promise<LongAttemptExecution[]> {
  const executions: LongAttemptExecution[] = [];
  let priorTargetResult: { intended: number; actual: number } | null = null;

  for (const intendedTargetMinutes of input.intendedTargets) {
    const refinement = priorTargetResult
      ? input.adaptiveTarget({
          nextTargetMinutes: intendedTargetMinutes,
          priorIntendedMinutes: priorTargetResult.intended,
          priorActualMinutes: priorTargetResult.actual,
          maximumExtraMinutes: input.maximumExtraMinutes,
          lowerObservation: input.lowerObservation,
        })
      : {
          targetMinutes: intendedTargetMinutes,
          direction: "NONE" as const,
          lowerObservedActualMinutes: input.lowerObservation?.actualAddedMinutes ?? null,
          upperObservedActualMinutes: null,
          preferredTargetMinutes: input.maximumExtraMinutes * PREFERRED_TARGET_UTILISATION,
          bracketedInterpolationUsed: false,
        };
    const adaptiveTargetMinutes = refinement.targetMinutes;
    const result = await input.execute({ intendedTargetMinutes, adaptiveTargetMinutes });
    executions.push({
      intendedTargetMinutes,
      adaptiveTargetMinutes,
      adaptationDirection: refinement.direction,
      lowerObservedActualMinutes: refinement.lowerObservedActualMinutes,
      upperObservedActualMinutes: refinement.upperObservedActualMinutes,
      preferredTargetMinutes: refinement.preferredTargetMinutes,
      bracketedInterpolationUsed: refinement.bracketedInterpolationUsed,
      ...result,
    });
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
  adaptationDirection?: import("./corridor-exploration").DurationAdaptationDirection;
  lowerObservedActualMinutes?: number | null;
  upperObservedActualMinutes?: number | null;
  preferredTargetMinutes?: number;
  finalRefinedConstructionTargetMinutes?: number | null;
  bracketedInterpolationUsed?: boolean;
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
    adaptationDirection: input.adaptationDirection ?? "NONE",
    lowerObservedActualMinutes: input.lowerObservedActualMinutes ?? null,
    upperObservedActualMinutes: input.upperObservedActualMinutes ?? null,
    preferredTargetMinutes:
      input.preferredTargetMinutes ?? input.requestedExtraMinutes * PREFERRED_TARGET_UTILISATION,
    finalRefinedConstructionTargetMinutes: input.finalRefinedConstructionTargetMinutes ?? null,
    bracketedInterpolationUsed: input.bracketedInterpolationUsed ?? false,
    actualAddedMinutesReturned: input.actualAddedMinutesReturned,
    outcomeClassification: input.outcomeClassification,
    candidateEligibility: input.candidateEligibility.map((candidate) => ({ ...candidate })),
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
