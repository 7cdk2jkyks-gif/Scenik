import { haversineDistanceMeters, type LatLng, type ScenicWaypointPlan } from "./scenic-waypoint";

export type JourneyTimelineEvent = {
  identity?: string;
  atSeconds: number;
  name: string;
  hasVerifiedDisplayName?: boolean;
  category: string;
  evidenceCategory?: string;
  description: string;
  distanceToRouteMeters?: number;
  rating?: number;
  userRatingCount?: number;
  photoUrl?: string;
};

export type DiscoveryCategoryPresentation = {
  label: string;
  copy: string;
};

export type DiscoveryCardPresentation = DiscoveryCategoryPresentation & {
  showPhoto: boolean;
};

export type DiscoveryNarrationEvent = JourneyTimelineEvent & {
  triggerAtSeconds: number;
  staleAfterSeconds: number;
  text: string;
  priority: number;
  hasBeenSpoken: boolean;
};

type TimedStep = {
  durationSeconds: number;
  endLat?: number;
  endLng?: number;
};

type JourneyPreferences = {
  moods?: string | string[];
  themes?: string | string[];
};

const normalized = (value: string) =>
  value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ");

const selections = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value : (value ?? "").split(",")).map(normalized).filter(Boolean);

export function discoveryCategoryPresentation(category: string): DiscoveryCategoryPresentation {
  const value = normalized(category);
  if (/\b(wood|woods|woodland|forest)\b/.test(value))
    return { label: "Woodland", copy: "Woodland discovery along your journey." };
  if (/\b(historic|historical|heritage|castle|ruin|monument|history museum)\b/.test(value))
    return { label: "Historic place", copy: "Historic discovery along your journey." };
  if (/\b(museum)\b/.test(value))
    return { label: "Museum", copy: "Museum discovery along your journey." };
  if (/\b(art gallery|cultural landmark)\b/.test(value))
    return { label: "Cultural place", copy: "Cultural discovery along your journey." };
  if (
    /\b(lake|river|water|waterside|coast|coastal|beach|harbour|harbor|marina|canal)\b/.test(value)
  )
    return { label: "Waterside", copy: "Waterside discovery along your journey." };
  if (/\b(viewpoint|lookout|observation)\b/.test(value))
    return { label: "Viewpoint", copy: "Viewpoint along your journey." };
  if (/\b(park|nature reserve|national park|natural place)\b/.test(value))
    return { label: "Natural place", copy: "Natural discovery along your journey." };
  if (/\b(garden|botanical garden)\b/.test(value))
    return { label: "Garden", copy: "Garden discovery along your journey." };
  if (/\b(wildlife reserve|wildlife refuge|wildlife park)\b/.test(value))
    return { label: "Wildlife place", copy: "Wildlife discovery along your journey." };
  return { label: "Discovery", copy: "Discovery along your journey." };
}

export function verifiedDiscoveryDescription(category: string): string {
  return discoveryCategoryPresentation(category).copy;
}

export function hasFeaturedDiscoveryDetail(event: JourneyTimelineEvent): boolean {
  return Boolean(event.photoUrl || event.rating != null || event.userRatingCount != null);
}

export function discoveryCardPresentation(
  event: JourneyTimelineEvent,
  photoFailed = false,
): DiscoveryCardPresentation {
  return {
    ...discoveryCategoryPresentation(event.category),
    showPhoto: Boolean(event.photoUrl) && !photoFailed,
  };
}

export function featuredJourneyDiscoveries(
  timeline: JourneyTimelineEvent[] | null | undefined,
  preferences: JourneyPreferences = {},
  limit = 4,
): JourneyTimelineEvent[] {
  return rankJourneyDiscoveries(
    (timeline ?? []).filter(hasFeaturedDiscoveryDetail),
    preferences,
    limit,
  );
}

export function buildJourneyTimeline(
  waypoints: ScenicWaypointPlan[],
  steps: TimedStep[],
  preferences: JourneyPreferences = {},
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

  const seenIdentities = new Set<string>();
  const seenPresentations = new Set<string>();
  const timeline = waypoints
    .flatMap((waypoint) => {
      const category = waypoint.categoryName?.trim() || waypoint.reason;
      const verifiedDisplayName = waypoint.displayName?.trim();
      const name = verifiedDisplayName || category;
      if (!name || !category || timedSteps.length === 0) return [];
      const identity = waypoint.id.trim();
      const presentationIdentity = `${normalized(name)}|${normalized(category)}`;
      if ((identity && seenIdentities.has(identity)) || seenPresentations.has(presentationIdentity))
        return [];
      if (identity) seenIdentities.add(identity);
      seenPresentations.add(presentationIdentity);
      const closest = timedSteps.reduce((best, current) =>
        haversineDistanceMeters(current.point, waypoint) <
        haversineDistanceMeters(best.point, waypoint)
          ? current
          : best,
      );
      const distanceToRouteMeters = haversineDistanceMeters(closest.point, waypoint);
      return [
        {
          identity: identity || undefined,
          atSeconds: closest.atSeconds,
          name,
          hasVerifiedDisplayName: !!verifiedDisplayName,
          category,
          evidenceCategory: waypoint.reason,
          description: verifiedDiscoveryDescription(category),
          distanceToRouteMeters,
          rating: waypoint.rating,
          userRatingCount: waypoint.userRatingCount,
          photoUrl: waypoint.photoUrl,
        },
      ];
    })
    .sort((a, b) => a.atSeconds - b.atSeconds || a.name.localeCompare(b.name));

  void preferences;
  return timeline;
}

const THEME_TERMS: Record<string, string[]> = {
  forest: ["wood", "forest", "nature reserve", "national park"],
  historic: ["historic", "heritage", "castle", "museum", "ruin"],
  "castles ruins": ["castle", "ruin", "historic"],
  coastal: ["coast", "beach", "harbour", "marina"],
  "lakes rivers": ["lake", "river", "water"],
  "scenic viewpoints": ["viewpoint", "lookout", "observation", "scenic"],
  countryside: ["park", "nature", "village", "town"],
  villages: ["village", "town", "locality"],
};

const MOOD_TERMS: Record<string, string[]> = {
  romantic: ["garden", "park", "water", "marina"],
  peaceful: ["park", "garden", "nature", "lake", "wood"],
  relaxed: ["park", "garden", "nature", "lake", "wood"],
  adventurous: ["hiking", "viewpoint", "national park", "scenic"],
  awestruck: ["viewpoint", "lookout", "national park", "scenic"],
};

function discoveryStrength(event: JourneyTimelineEvent, preferences: JourneyPreferences): number {
  const evidence = normalized(`${event.category} ${event.evidenceCategory ?? ""}`);
  const themeMatch = selections(preferences.themes).some((theme) =>
    (THEME_TERMS[theme] ?? []).some((term) => evidence.includes(term)),
  );
  const moodMatch = selections(preferences.moods).some((mood) =>
    (MOOD_TERMS[mood] ?? []).some((term) => evidence.includes(term)),
  );
  const specificity =
    /historic|heritage|castle|museum|wood|forest|lake|river|coast|beach|viewpoint|lookout|national park/.test(
      evidence,
    )
      ? 3
      : 1;
  const ratingStrength = event.rating == null ? 0 : Math.max(0, event.rating - 3) * 2;
  const reviewStrength = event.userRatingCount
    ? Math.min(2, Math.log10(event.userRatingCount + 1) / 2)
    : 0;
  const proximityStrength = Math.max(0, 2 - (event.distanceToRouteMeters ?? 2_000) / 1_000);
  return (
    (themeMatch ? 6 : 0) +
    (moodMatch ? 3 : 0) +
    specificity +
    ratingStrength +
    reviewStrength +
    proximityStrength
  );
}

export function rankJourneyDiscoveries(
  timeline: JourneyTimelineEvent[] | null | undefined,
  preferences: JourneyPreferences = {},
  limit = 4,
): JourneyTimelineEvent[] {
  return [...(timeline ?? [])]
    .sort((a, b) => {
      const strengthDifference =
        discoveryStrength(b, preferences) - discoveryStrength(a, preferences);
      return strengthDifference || a.atSeconds - b.atSeconds || a.name.localeCompare(b.name);
    })
    .slice(0, Math.max(0, limit));
}

export function discoveryPresentationState(
  timeline: JourneyTimelineEvent[] | null | undefined,
  legacyHighlights: string[] | null | undefined,
) {
  const hasDiscoveries = (timeline?.length ?? 0) > 0;
  const legacySummary = (legacyHighlights ?? [])
    .map((highlight) => highlight.trim())
    .filter(Boolean)
    .join(" · ");
  return {
    hasDiscoveries,
    showDiscoveryHeading: hasDiscoveries,
    legacySummary: hasDiscoveries || !legacySummary ? null : legacySummary,
  };
}

export function buildDiscoveryNarration(
  timeline: JourneyTimelineEvent[],
): DiscoveryNarrationEvent[] {
  return timeline.map((event, index) => ({
    ...event,
    triggerAtSeconds: Math.max(0, event.atSeconds - 60),
    staleAfterSeconds: event.atSeconds + 120,
    text: event.hasVerifiedDisplayName
      ? `You’re approaching ${event.name}, one of the featured discoveries on today’s journey.`
      : "A featured discovery is approaching along today’s journey.",
    priority: Math.max(1, timeline.length - index),
    hasBeenSpoken: false,
  }));
}
