type RouteDirections = {
  encodedPolyline?: string;
  durationSeconds?: number;
  duration?: string;
  distanceMeters?: number;
  distance?: string;
  steps?: Array<{ distanceMeters?: number; durationSeconds?: number; instruction?: string }>;
};

type RouteResult = {
  selectedRouteDurationSeconds?: number;
  directions?: RouteDirections;
};

export type SelectedRoutePresentation = {
  encodedPolyline: string;
  durationSeconds: number;
  distanceMeters: number;
  duration: string;
  distance: string;
  steps: NonNullable<RouteDirections["steps"]>;
  identityFingerprint: string;
};

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function parseLegacyDurationSeconds(value: string | undefined): number {
  if (!value) return 0;
  const hours = Number(value.match(/(\d+(?:\.\d+)?)\s*(?:hr|hour)/i)?.[1] ?? 0);
  const minutes = Number(value.match(/(\d+(?:\.\d+)?)\s*min/i)?.[1] ?? 0);
  return Math.round(hours * 3_600 + minutes * 60);
}

export function selectedRouteDurationSeconds(result: RouteResult | null | undefined): number {
  if (positiveNumber(result?.selectedRouteDurationSeconds))
    return Math.round(result.selectedRouteDurationSeconds);
  if (positiveNumber(result?.directions?.durationSeconds))
    return Math.round(result.directions.durationSeconds);
  return parseLegacyDurationSeconds(result?.directions?.duration);
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `route-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function routeIdentityFingerprint(
  directions: RouteDirections,
  authoritativeDurationSeconds?: number,
): string {
  const durationSeconds = positiveNumber(authoritativeDurationSeconds)
    ? Math.round(authoritativeDurationSeconds)
    : positiveNumber(directions.durationSeconds)
      ? Math.round(directions.durationSeconds)
      : parseLegacyDurationSeconds(directions.duration);
  const distanceMeters = positiveNumber(directions.distanceMeters)
    ? Math.round(directions.distanceMeters)
    : 0;
  const steps = directions.steps ?? [];
  return fingerprint(
    [
      directions.encodedPolyline ?? "",
      durationSeconds,
      distanceMeters,
      steps.length,
      ...steps.map(
        (step) =>
          `${step.distanceMeters ?? 0}:${step.durationSeconds ?? 0}:${step.instruction ?? ""}`,
      ),
    ].join("|"),
  );
}

export function selectedRoutePresentation(
  result: RouteResult | null | undefined,
): SelectedRoutePresentation | null {
  const directions = result?.directions;
  if (!directions) return null;
  const durationSeconds = selectedRouteDurationSeconds(result);
  const distanceMeters = positiveNumber(directions.distanceMeters)
    ? Math.round(directions.distanceMeters)
    : 0;
  const encodedPolyline = directions.encodedPolyline ?? "";
  const steps = directions.steps ?? [];
  const identityFingerprint = routeIdentityFingerprint(directions, durationSeconds);
  return {
    encodedPolyline,
    durationSeconds,
    distanceMeters,
    duration: directions.duration ?? "",
    distance: directions.distance ?? "",
    steps,
    identityFingerprint,
  };
}

export function mapRemainingDurationSeconds(
  selectedDurationSeconds: number,
  progress?: { remainingSeconds?: number } | null,
): number {
  return positiveNumber(progress?.remainingSeconds)
    ? progress.remainingSeconds
    : Math.max(0, selectedDurationSeconds);
}

export function timeBudgetExplanation(
  measuredExtraSeconds: number,
  requestedExtraMinutes: number,
  fullSearchCompleted = true,
  timeTargetOutcome?:
    | "ZERO_TARGET"
    | "TARGET_MET"
    | "TIME_COMMITMENT_TARGET_FALLBACK"
    | "MEANINGFUL_FALLBACK"
    | "TIME_COMMITMENT_MEANINGFUL_FALLBACK"
    | "WEAK_ROUTE_SELECTED"
    | "BASELINE_FALLBACK"
    | "LONGER_WEAKENED_QUALITY"
    | "NO_TARGET_BAND_ROUTE",
) {
  const authoritativeAddedSeconds = Number.isFinite(measuredExtraSeconds)
    ? Math.max(0, measuredExtraSeconds)
    : 0;
  const authoritativeAllowanceSeconds = Number.isFinite(requestedExtraMinutes)
    ? Math.max(0, requestedExtraMinutes * 60)
    : 0;
  const usedMinutes = Math.max(0, Math.round(authoritativeAddedSeconds / 60));
  const allowanceMinutes = Math.max(0, Math.round(authoritativeAllowanceSeconds / 60));
  const utilisation =
    authoritativeAllowanceSeconds > 0
      ? authoritativeAddedSeconds / authoritativeAllowanceSeconds
      : 0;
  if (allowanceMinutes === 0) {
    return { usedMinutes, allowanceMinutes, utilisation, explanation: "Fastest route selected." };
  }
  if (timeTargetOutcome === "ZERO_TARGET") {
    return { usedMinutes, allowanceMinutes, utilisation, explanation: "Fastest route selected." };
  }
  if (
    timeTargetOutcome === "TARGET_MET" ||
    timeTargetOutcome === "TIME_COMMITMENT_TARGET_FALLBACK"
  ) {
    return {
      usedMinutes,
      allowanceMinutes,
      utilisation,
      explanation: "Your larger allowance unlocked this route.",
    };
  }
  if (timeTargetOutcome === "MEANINGFUL_FALLBACK") {
    return {
      usedMinutes,
      allowanceMinutes,
      utilisation,
      explanation:
        "This useful longer route safely uses part of your allowance; no suitable route used more.",
    };
  }
  if (timeTargetOutcome === "TIME_COMMITMENT_MEANINGFUL_FALLBACK") {
    return {
      usedMinutes,
      allowanceMinutes,
      utilisation,
      explanation: "Your larger allowance unlocked this route.",
    };
  }
  if (timeTargetOutcome === "WEAK_ROUTE_SELECTED") {
    return {
      usedMinutes,
      allowanceMinutes,
      utilisation,
      explanation:
        "We found a worthwhile longer route, although the full allowance could not be used safely.",
    };
  }
  if (timeTargetOutcome === "BASELINE_FALLBACK") {
    return {
      usedMinutes,
      allowanceMinutes,
      utilisation,
      explanation: "No safe, coherent longer route met the minimum journey-quality requirements.",
    };
  }
  if (timeTargetOutcome === "LONGER_WEAKENED_QUALITY") {
    return {
      usedMinutes,
      allowanceMinutes,
      utilisation,
      explanation: "Longer routes were available, but they weakened the journey too much.",
    };
  }
  if (timeTargetOutcome === "NO_TARGET_BAND_ROUTE") {
    return {
      usedMinutes,
      allowanceMinutes,
      utilisation,
      explanation:
        "We couldn’t find a suitable route using all of your requested time, so we chose the strongest journey available.",
    };
  }
  if (utilisation >= 0.75 && utilisation <= 1) {
    return {
      usedMinutes,
      allowanceMinutes,
      utilisation,
      explanation: "Your larger allowance unlocked this route.",
    };
  }
  if (utilisation >= 0.35 && utilisation < 0.75) {
    return {
      usedMinutes,
      allowanceMinutes,
      utilisation,
      explanation:
        utilisation >= 0.4
          ? "This was the best balance of scenery and journey time."
          : "This useful longer route safely uses part of your allowance; no suitable route used more.",
    };
  }
  return {
    usedMinutes,
    allowanceMinutes,
    utilisation,
    explanation: fullSearchCompleted
      ? "We couldn’t find a suitable route using all of your requested time, so we chose the strongest journey available."
      : usedMinutes > 0
        ? "We found a scenic option without using your full allowance."
        : "The selected journey stays close to the fastest route.",
  };
}
