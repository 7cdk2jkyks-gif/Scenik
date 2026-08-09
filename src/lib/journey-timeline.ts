import { haversineDistanceMeters, type LatLng, type ScenicWaypointPlan } from "./scenic-waypoint";

export type JourneyTimelineEvent = {
  atSeconds: number;
  name: string;
  category: string;
  description: string;
};

export type DiscoveryNarrationEvent = JourneyTimelineEvent & {
  text: string;
};

type TimedStep = {
  durationSeconds: number;
  endLat?: number;
  endLng?: number;
};

function factualDescription(name: string, category: string): string {
  return `Google Places lists ${name} as ${category.toLowerCase()}.`;
}

export function buildJourneyTimeline(
  waypoints: ScenicWaypointPlan[],
  steps: TimedStep[],
): JourneyTimelineEvent[] {
  const timedSteps = steps.reduce<Array<{ point: LatLng; atSeconds: number }>>((result, step) => {
    const previousSeconds = result.at(-1)?.atSeconds ?? 0;
    const atSeconds = previousSeconds + Math.max(0, step.durationSeconds);
    if (Number.isFinite(step.endLat) && Number.isFinite(step.endLng)) {
      result.push({ point: { lat: step.endLat!, lng: step.endLng! }, atSeconds });
    } else if (result.length > 0) {
      result[result.length - 1].atSeconds = atSeconds;
    }
    return result;
  }, []);

  return waypoints
    .flatMap((waypoint) => {
      const name = waypoint.displayName?.trim();
      if (!name || timedSteps.length === 0) return [];
      const category = waypoint.categoryName?.trim() || waypoint.reason;
      const closest = timedSteps.reduce((best, current) =>
        haversineDistanceMeters(current.point, waypoint) <
        haversineDistanceMeters(best.point, waypoint)
          ? current
          : best,
      );
      return [
        {
          atSeconds: closest.atSeconds,
          name,
          category,
          description: factualDescription(name, category),
        },
      ];
    })
    .sort((a, b) => a.atSeconds - b.atSeconds || a.name.localeCompare(b.name));
}

export function buildDiscoveryNarration(
  timeline: JourneyTimelineEvent[],
): DiscoveryNarrationEvent[] {
  return timeline.map((event) => ({
    ...event,
    text: `Coming up: ${event.name}, ${event.category.toLowerCase()}.`,
  }));
}
