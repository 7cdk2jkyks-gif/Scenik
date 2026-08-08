import type { ComputedDirections } from "./google-maps.server";
import { routesAreMeaningfullyDifferent } from "./route-selection";
import type { ScenicScoreResult } from "./scenic-score";
import type { ScenicEvidenceCounts } from "./scenic-waypoint";

export type UpgradeScoredCandidate = {
  directions: ComputedDirections;
  score: number;
  scoreResult: ScenicScoreResult;
  originalIndex: number;
  evidence?: ScenicEvidenceCounts;
};

export function upgradeOverrunToleranceSeconds(extraMinutes: number): number {
  if (extraMinutes <= 0) return 0;
  return Math.min(15 * 60, Math.max(3 * 60, Math.round(extraMinutes * 60 * 0.3)));
}

export function verifiedUpgradeReasons(
  current: UpgradeScoredCandidate,
  upgrade: UpgradeScoredCandidate,
): string[] {
  const reasons: string[] = [];
  const currentEvidence = current.evidence;
  const upgradeEvidence = upgrade.evidence;
  const naturalCount = (evidence?: ScenicEvidenceCounts) =>
    (evidence?.natural ?? 0) +
    (evidence?.coastal ?? 0) +
    (evidence?.viewpoint ?? 0) +
    (evidence?.wildlife ?? 0);
  const poiCount = (evidence?: ScenicEvidenceCounts) =>
    (evidence?.historic ?? 0) +
    (evidence?.cultural ?? 0) +
    (evidence?.food ?? 0) +
    (evidence?.otherPoi ?? 0);
  if (naturalCount(upgradeEvidence) > naturalCount(currentEvidence))
    reasons.push("More verified natural evidence");
  if (poiCount(upgradeEvidence) > poiCount(currentEvidence))
    reasons.push("More verified points of interest");
  if (
    upgrade.scoreResult.breakdown.road_character - current.scoreResult.breakdown.road_character >=
    1
  )
    reasons.push("More varied measured road character");
  if (upgrade.scoreResult.breakdown.theme_match - current.scoreResult.breakdown.theme_match >= 1)
    reasons.push("Stronger verified theme match");
  if (upgrade.scoreResult.breakdown.diversity - current.scoreResult.breakdown.diversity >= 1)
    reasons.push("Greater verified route diversity");
  return reasons.slice(0, 3);
}

export function selectRouteUpgradeCandidate(input: {
  selected: UpgradeScoredCandidate;
  candidates: UpgradeScoredCandidate[];
  fastestDurationSeconds: number;
  requestedExtraMinutes: number;
}): { candidate: UpgradeScoredCandidate; reasons: string[] } | null {
  const allowedDuration = input.fastestDurationSeconds + input.requestedExtraMinutes * 60;
  const maximumDuration =
    allowedDuration + upgradeOverrunToleranceSeconds(input.requestedExtraMinutes);
  const eligible = input.candidates.flatMap((candidate) => {
    const improvement = candidate.score - input.selected.score;
    const reasons = verifiedUpgradeReasons(input.selected, candidate);
    if (
      candidate.originalIndex === input.selected.originalIndex ||
      candidate.directions.durationSeconds <= allowedDuration ||
      candidate.directions.durationSeconds > maximumDuration ||
      improvement < 5 ||
      reasons.length === 0 ||
      !routesAreMeaningfullyDifferent(input.selected.directions, candidate.directions)
    )
      return [];
    return [{ candidate, reasons, improvement }];
  });
  return (
    eligible.sort(
      (a, b) =>
        b.improvement - a.improvement ||
        a.candidate.directions.durationSeconds - b.candidate.directions.durationSeconds ||
        a.candidate.originalIndex - b.candidate.originalIndex,
    )[0] ?? null
  );
}

export function applyRetainedRouteUpgrade<TCurrent extends object, TPayload extends object>(
  current: TCurrent,
  payload: TPayload,
): TCurrent & TPayload & { routeUpgradeCandidate: undefined } {
  return { ...current, ...payload, routeUpgradeCandidate: undefined };
}
