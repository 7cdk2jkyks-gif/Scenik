import type { JourneyTimelineEvent } from "./journey-timeline";
import { discoveryCounts } from "./journey-achievements";
import { selectedRoutePresentation } from "./route-presentation";

type SummaryResult = Parameters<typeof selectedRoutePresentation>[0] & {
  title: string;
  scenic_score: number;
  measuredExtraTimeSeconds?: number;
  journeyTimeline?: JourneyTimelineEvent[];
};

export type JourneySummary = {
  title: string;
  scenicScore: number;
  distanceMeters: number;
  durationSeconds: number;
  extraMinutes: number;
  discoveries: JourneyTimelineEvent[];
  discoveryCounts: ReturnType<typeof discoveryCounts>;
  shareText: string;
};

export function buildJourneySummary(result: SummaryResult): JourneySummary | null {
  const route = selectedRoutePresentation(result);
  if (!route) return null;
  const discoveries = result.journeyTimeline ?? [];
  const miles = route.distanceMeters / 1609.344;
  return {
    title: result.title,
    scenicScore: result.scenic_score,
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    extraMinutes: Math.max(0, Math.round((result.measuredExtraTimeSeconds ?? 0) / 60)),
    discoveries,
    discoveryCounts: discoveryCounts(discoveries),
    shareText: `${result.title}\nScenic Score ${result.scenic_score}\n${Math.round(miles)} miles\n${discoveries.length} discoveries\n\n“Made for the journey.”`,
  };
}
