import {
  haversineDistanceMeters,
  verifiedMeaningfulPlaceName,
  type LatLng,
  type ScenicPlace,
  type ScenicWaypointPlan,
} from "./scenic-waypoint";

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

export function verifiedJourneyHighlights(
  waypoints: Array<{ displayName?: string; alternativeDisplayName?: string }>,
): string | null {
  const names = waypoints.flatMap((waypoint) => {
    const name = verifiedMeaningfulPlaceName(waypoint);
    return name ? [name] : [];
  });
  return names.join(" and ") || null;
}

export function routeResultNarrative(input: {
  selectedWinner: string;
  selectedWaypointReason: string | null;
  requestedExtraMinutes: number;
  measuredExtraTimeSeconds: number;
}): string {
  const addedMinutes = Math.round(input.measuredExtraTimeSeconds / 60);
  if (input.selectedWinner === "scenik" && input.selectedWaypointReason)
    return `${input.requestedExtraMinutes > 10 ? "Your larger time allowance unlocked this route. " : ""}It adds ${addedMinutes} minutes and includes ${input.selectedWaypointReason}.`;
  if (input.measuredExtraTimeSeconds > 0)
    return `This route remains within ${addedMinutes} minutes of the fastest journey and scored higher on measurable route variety.`;
  if (input.requestedExtraMinutes > 10)
    return `Scenik searched further within your ${input.requestedExtraMinutes}-minute allowance, but no better route scored higher.`;
  return "This was the highest-scoring route within your allowance without adding journey time.";
}

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
  waypoints: Array<
    ScenicWaypointPlan | (ScenicPlace & { routeProgress?: number; distanceToRouteMeters?: number })
  >,
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
  const totalDurationSeconds = timedSteps.at(-1)?.atSeconds ?? 0;
  const timeline = waypoints
    .flatMap((waypoint) => {
      const category =
        waypoint.categoryName?.trim() ||
        ("reason" in waypoint ? waypoint.reason : waypoint.primaryType.replaceAll("_", " "));
      const verifiedDisplayName = verifiedMeaningfulPlaceName(waypoint);
      if (!verifiedDisplayName || !category || timedSteps.length === 0) return [];
      const name = verifiedDisplayName;
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
      const routeProgress = "routeProgress" in waypoint ? waypoint.routeProgress : undefined;
      const atSeconds =
        routeProgress == null
          ? closest.atSeconds
          : Math.round(Math.max(0, Math.min(1, routeProgress)) * totalDurationSeconds);
      const distanceToRouteMeters =
        "distanceToRouteMeters" in waypoint && waypoint.distanceToRouteMeters != null
          ? waypoint.distanceToRouteMeters
          : haversineDistanceMeters(closest.point, waypoint);
      return [
        {
          identity: identity || undefined,
          atSeconds,
          name,
          hasVerifiedDisplayName: !!verifiedDisplayName,
          category,
          evidenceCategory: "reason" in waypoint ? waypoint.reason : waypoint.primaryType,
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

export type DiscoveryCountBand = { minimum: number; maximum: number; target: number };

export function discoveryCountBand(
  durationSeconds: number,
  distanceMeters: number,
): DiscoveryCountBand {
  // Invalid provider/runtime values use the safest short-route, zero-distance fallback.
  const safeDurationSeconds = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
  const safeDistanceMeters = Number.isFinite(distanceMeters) ? Math.max(0, distanceMeters) : 0;
  const minutes = safeDurationSeconds / 60;
  const distance = safeDistanceMeters;
  const [minimum, maximum, distanceStep] =
    minutes < 45
      ? [2, 3, 30_000]
      : minutes < 90
        ? [3, 5, 50_000]
        : minutes < 180
          ? [5, 8, 75_000]
          : minutes < 300
            ? [8, 12, 100_000]
            : [10, 15, 125_000];
  return {
    minimum,
    maximum,
    target: Math.min(maximum, minimum + Math.floor(distance / distanceStep)),
  };
}

const broadCategory = (event: JourneyTimelineEvent) =>
  discoveryCategoryPresentation(event.category).label;

const discoveryTime = (event: JourneyTimelineEvent) =>
  Number.isFinite(event.atSeconds) ? Math.max(0, event.atSeconds) : 0;

const compareDiscoveryIdentity = (a: JourneyTimelineEvent, b: JourneyTimelineEvent) =>
  discoveryTime(a) - discoveryTime(b) ||
  a.name.localeCompare(b.name) ||
  a.category.localeCompare(b.category) ||
  (a.identity ?? "").localeCompare(b.identity ?? "");

export function selectJourneyDiscoveries(
  timeline: JourneyTimelineEvent[] | null | undefined,
  durationSeconds: number,
  distanceMeters: number,
  preferences: JourneyPreferences = {},
): JourneyTimelineEvent[] {
  const candidates = [...(timeline ?? [])];
  if (candidates.length === 0) return [];
  const target = Math.min(
    discoveryCountBand(durationSeconds, distanceMeters).target,
    candidates.length,
  );
  const journeySeconds = Math.max(
    1,
    Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0,
    ...candidates.map(discoveryTime),
  );
  const sectionCount = Math.min(target, Math.max(2, Math.ceil(target / 2)));
  const section = (event: JourneyTimelineEvent) =>
    Math.min(sectionCount - 1, Math.floor((discoveryTime(event) / journeySeconds) * sectionCount));
  const byStrength = [...candidates].sort((a, b) => {
    const difference = discoveryStrength(b, preferences) - discoveryStrength(a, preferences);
    return difference || compareDiscoveryIdentity(a, b);
  });
  const selected: JourneyTimelineEvent[] = [];
  for (let index = 0; index < sectionCount && selected.length < target; index += 1) {
    const strongest = byStrength.find((candidate) => section(candidate) === index);
    if (strongest) selected.push(strongest);
  }
  while (selected.length < target) {
    const selectedCategories = new Set(selected.map(broadCategory));
    const next = byStrength
      .filter((candidate) => !selected.includes(candidate))
      .map((candidate) => {
        const separation = Math.min(
          ...selected.map(
            (chosen) => Math.abs(discoveryTime(chosen) - discoveryTime(candidate)) / journeySeconds,
          ),
        );
        const endpointPenalty =
          discoveryTime(candidate) / journeySeconds < 0.03 ||
          discoveryTime(candidate) / journeySeconds > 0.97
            ? 3
            : 0;
        return {
          candidate,
          score:
            discoveryStrength(candidate, preferences) +
            separation * 8 +
            (selectedCategories.has(broadCategory(candidate)) ? 0 : 2) -
            endpointPenalty,
        };
      })
      .sort(
        (a, b) => b.score - a.score || compareDiscoveryIdentity(a.candidate, b.candidate),
      )[0]?.candidate;
    if (!next) break;
    selected.push(next);
  }
  return selected.sort(compareDiscoveryIdentity);
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
      return strengthDifference || compareDiscoveryIdentity(a, b);
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
  durationSeconds?: number,
): DiscoveryNarrationEvent[] {
  const narrationLimit =
    durationSeconds == null
      ? timeline.length
      : durationSeconds < 90 * 60
        ? 3
        : durationSeconds < 3 * 60 * 60
          ? 5
          : 6;
  const selected =
    timeline.length <= narrationLimit
      ? timeline
      : Array.from(
          { length: narrationLimit },
          (_, index) =>
            timeline[Math.round((index * (timeline.length - 1)) / (narrationLimit - 1))],
        );
  return selected.map((event, index) => {
    const atSeconds = discoveryTime(event);
    return {
      ...event,
      atSeconds,
      triggerAtSeconds: Math.max(0, atSeconds - 60),
      staleAfterSeconds: atSeconds + 120,
      text: event.hasVerifiedDisplayName
        ? `You’re approaching ${event.name}, one of the featured discoveries on today’s journey.`
        : "A featured discovery is approaching along today’s journey.",
      priority: Math.max(1, selected.length - index),
      hasBeenSpoken: false,
    };
  });
}
