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
) {
  const usedMinutes = Math.max(0, Math.round(measuredExtraSeconds / 60));
  const allowanceMinutes = Math.max(0, Math.round(requestedExtraMinutes));
  const utilisation = allowanceMinutes > 0 ? usedMinutes / allowanceMinutes : 0;
  if (allowanceMinutes === 0) {
    return { usedMinutes, allowanceMinutes, utilisation, explanation: "Fastest route selected." };
  }
  if (utilisation >= 0.7) {
    return {
      usedMinutes,
      allowanceMinutes,
      utilisation,
      explanation: "Your larger allowance unlocked this route.",
    };
  }
  if (utilisation >= 0.4) {
    return {
      usedMinutes,
      allowanceMinutes,
      utilisation,
      explanation: "This was the best balance of scenery and journey time.",
    };
  }
  return {
    usedMinutes,
    allowanceMinutes,
    utilisation,
    explanation: fullSearchCompleted
      ? "Scenik searched your full allowance, but the longer options didn’t improve the journey enough to justify the extra time."
      : "The longer options didn’t improve the journey enough to justify the extra time.",
  };
}
