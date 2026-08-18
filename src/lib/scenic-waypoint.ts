export type LatLng = { lat: number; lng: number };

export function isValidLatLng(value: unknown): value is LatLng {
  if (!value || typeof value !== "object") return false;
  const coordinate = value as { lat?: unknown; lng?: unknown };
  return (
    typeof coordinate.lat === "number" &&
    Number.isFinite(coordinate.lat) &&
    coordinate.lat >= -90 &&
    coordinate.lat <= 90 &&
    typeof coordinate.lng === "number" &&
    Number.isFinite(coordinate.lng) &&
    coordinate.lng >= -180 &&
    coordinate.lng <= 180
  );
}

function normalizeGeneratedLongitude(longitude: number): number {
  // Use -180 as the single deterministic representation of the antimeridian.
  const normalized = ((((longitude + 180) % 360) + 360) % 360) - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function interpolateRouteCoordinate(from: LatLng, to: LatLng, fraction: number): LatLng {
  const wrappedLongitudeDelta = ((((to.lng - from.lng + 540) % 360) + 360) % 360) - 180;
  return {
    lat: from.lat + (to.lat - from.lat) * fraction,
    lng: normalizeGeneratedLongitude(from.lng + wrappedLongitudeDelta * fraction),
  };
}

export type ScenicPlace = LatLng & {
  id: string;
  primaryType: string;
  types: string[];
  displayName?: string;
  alternativeDisplayName?: string;
  categoryName?: string;
  rating?: number;
  userRatingCount?: number;
  photoUrl?: string;
};

export type ScenicWaypointPlan = ScenicPlace & {
  reason: string;
  insertionIndex: number;
  estimatedDetourMeters: number;
};

export type ScenicWaypointPlanningDiagnostics = {
  plans: ScenicWaypointPlan[];
  considered: number;
  rejectedDuplicate: number;
  rejectedBacktracking: number;
};

export type ScenicEvidenceCounts = {
  natural: number;
  historic: number;
  cultural: number;
  coastal: number;
  viewpoint: number;
  wildlife: number;
  food: number;
  otherPoi: number;
};

export const EMPTY_SCENIC_EVIDENCE: ScenicEvidenceCounts = {
  natural: 0,
  historic: 0,
  cultural: 0,
  coastal: 0,
  viewpoint: 0,
  wildlife: 0,
  food: 0,
  otherPoi: 0,
};

const UK_POSTCODE_ONLY = /^(?:GIR\s?0AA|(?:[A-Z]{1,2}\d[A-Z\d]?|[A-Z]{1,2}\d{1,2})\s?\d[A-Z]{2})$/i;
const COORDINATES_ONLY = /^\s*[-+]?\d{1,3}(?:\.\d+)?\s*[,/]\s*[-+]?\d{1,3}(?:\.\d+)?\s*$/;
const PROVIDER_LOCATION_CODE_ONLY =
  /^(?:[23456789CFGHJMPQRVWX]{4,}\+[23456789CFGHJMPQRVWX]{2,}|(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{8,})$/i;

export function meaningfulPlaceDisplayName(value: string | null | undefined): string | undefined {
  const name = value?.trim();
  if (
    !name ||
    UK_POSTCODE_ONLY.test(name) ||
    COORDINATES_ONLY.test(name) ||
    PROVIDER_LOCATION_CODE_ONLY.test(name)
  )
    return undefined;
  return name;
}

export function verifiedMeaningfulPlaceName(place: {
  displayName?: string;
  alternativeDisplayName?: string;
}): string | undefined {
  return (
    meaningfulPlaceDisplayName(place.displayName) ??
    meaningfulPlaceDisplayName(place.alternativeDisplayName)
  );
}

const TYPE_REASON: Record<string, string> = {
  castle: "Historic site",
  cultural_landmark: "Historic landmark",
  historical_landmark: "Historic landmark",
  historical_place: "Historic place",
  history_museum: "History museum",
  museum: "Museum",
  botanical_garden: "Botanical garden",
  garden: "Garden",
  park: "Country park",
  city_park: "Park",
  national_park: "National park",
  state_park: "Country park",
  nature_preserve: "Nature reserve",
  woods: "Woodland",
  scenic_spot: "Scenic viewpoint",
  observation_deck: "Scenic viewpoint",
  beach: "Coastal stop",
  marina: "Harbour",
  lake: "Lake",
  river: "River",
  locality: "Local town",
  hiking_area: "Hiking area",
  art_gallery: "Art gallery",
  wildlife_refuge: "Wildlife reserve",
  wildlife_park: "Wildlife park",
  farmers_market: "Farmers market",
  winery: "Winery",
  dog_park: "Dog-friendly park",
};

const THEME_TYPES: Record<string, string[]> = {
  Historic: ["historical_place", "historical_landmark", "castle", "history_museum", "museum"],
  Forest: ["woods", "nature_preserve", "national_park", "state_park"],
  Coastal: ["beach", "marina"],
  Villages: ["locality"],
  "Scenic Viewpoints": ["scenic_spot", "observation_deck"],
  Countryside: ["park", "nature_preserve", "state_park"],
  Mountain: ["scenic_spot", "national_park", "hiking_area"],
  Waterfalls: ["scenic_spot", "nature_preserve"],
  "Lakes & Rivers": ["lake", "river", "park", "nature_preserve", "marina"],
  "Castles & Ruins": ["castle", "historical_place", "historical_landmark"],
  "Art & Culture": ["cultural_landmark", "museum", "art_gallery"],
  Wildlife: ["wildlife_refuge", "wildlife_park", "nature_preserve"],
  Stargazing: ["scenic_spot", "observation_deck", "national_park"],
  Foodie: ["farmers_market", "winery"],
  "Dog Friendly": ["dog_park", "park"],
};

const MOOD_TYPES: Record<string, string[]> = {
  Romantic: ["garden", "botanical_garden", "park", "marina"],
  Peaceful: ["park", "garden", "nature_preserve"],
  Relaxed: ["park", "garden", "nature_preserve"],
  Reflective: ["garden", "park", "historical_place"],
  Cosy: ["garden", "park"],
  Adventurous: ["hiking_area", "scenic_spot", "national_park"],
  Awestruck: ["scenic_spot", "observation_deck", "national_park"],
};

export function selectedPlaceTypes(moods: string[], themes: string[]): string[] {
  const preferenceTypes = [
    ...themes.flatMap((theme) => THEME_TYPES[theme] ?? []),
    ...moods.flatMap((mood) => MOOD_TYPES[mood] ?? []),
  ];
  const coreEvidenceTypes = [
    "park",
    "nature_preserve",
    "scenic_spot",
    "tourist_attraction",
    "museum",
    "beach",
    "lake",
    "river",
    "woods",
    "marina",
    "historical_place",
    "locality",
    "national_park",
  ];
  return [...new Set([...preferenceTypes.slice(0, 7), ...coreEvidenceTypes])].slice(0, 20);
}

export function haversineDistanceMeters(a: LatLng, b: LatLng): number {
  const radians = (value: number) => (value * Math.PI) / 180;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(((((b.lng - a.lng + 540) % 360) + 360) % 360) - 180);
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, value))));
}

export function routeMidpoint(
  start: LatLng,
  end: LatLng,
  steps: Array<{ distanceMeters: number; endLat?: number; endLng?: number }>,
): LatLng {
  const usable = steps.filter(
    (step) =>
      step.distanceMeters > 0 && Number.isFinite(step.endLat) && Number.isFinite(step.endLng),
  );
  const total = usable.reduce((sum, step) => sum + step.distanceMeters, 0);
  let travelled = 0;
  for (const step of usable) {
    travelled += step.distanceMeters;
    if (travelled >= total / 2) return { lat: step.endLat!, lng: step.endLng! };
  }
  return interpolateRouteCoordinate(start, end, 0.5);
}

function routeSegments(
  start: LatLng,
  end: LatLng,
  steps: Array<{
    startLat?: number;
    startLng?: number;
    endLat?: number;
    endLng?: number;
  }>,
): Array<{ from: LatLng; to: LatLng; length: number }> {
  if (!isValidLatLng(start) || !isValidLatLng(end)) return [];
  if (steps.length === 0) {
    const length = haversineDistanceMeters(start, end);
    return length > 0 ? [{ from: start, to: end, length }] : [];
  }
  const segments: Array<{ from: LatLng; to: LatLng; length: number }> = [];
  let previous: LatLng | null = start;
  for (const step of steps) {
    const explicitStart = { lat: step.startLat, lng: step.startLng };
    const explicitEnd = { lat: step.endLat, lng: step.endLng };
    const hasExplicitStart = step.startLat !== undefined || step.startLng !== undefined;
    if (hasExplicitStart) {
      if (isValidLatLng(explicitStart) && isValidLatLng(explicitEnd)) {
        const length = haversineDistanceMeters(explicitStart, explicitEnd);
        if (length > 0) segments.push({ from: explicitStart, to: explicitEnd, length });
        previous = explicitEnd;
      } else {
        previous = null;
      }
      continue;
    }
    if (previous && isValidLatLng(explicitEnd)) {
      const length = haversineDistanceMeters(previous, explicitEnd);
      if (length > 0) segments.push({ from: previous, to: explicitEnd, length });
      previous = explicitEnd;
    } else {
      previous = null;
    }
  }
  if (previous) {
    const length = haversineDistanceMeters(previous, end);
    if (length > 0) segments.push({ from: previous, to: end, length });
  }
  return segments;
}

export function corridorSampleCount(distanceMeters: number): 3 | 5 | 7 {
  return distanceMeters < 50_000 ? 3 : distanceMeters < 150_000 ? 5 : 7;
}

export function routeCorridorSamples(
  start: LatLng,
  end: LatLng,
  steps: Array<{
    startLat?: number;
    startLng?: number;
    endLat?: number;
    endLng?: number;
  }>,
  count: number,
): LatLng[] {
  const segments = routeSegments(start, end, steps);
  if (segments.length === 0) return [];
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (total <= 0) return [];
  return Array.from({ length: Math.max(1, count) }, (_, index) => {
    const target = total * ((index + 1) / (count + 1));
    let traversed = 0;
    for (const segment of segments) {
      if (traversed + segment.length >= target) {
        const fraction = segment.length ? (target - traversed) / segment.length : 0;
        return interpolateRouteCoordinate(segment.from, segment.to, fraction);
      }
      traversed += segment.length;
    }
    return segments.at(-1)!.to;
  });
}

export function explorationLimits(extraMinutes: number) {
  if (extraMinutes <= 0)
    return { radiusMeters: 0, maxSearches: 0, maxPlaces: 0, maxRouteCandidates: 0 };
  if (extraMinutes <= 10)
    return { radiusMeters: 1_500, maxSearches: 3, maxPlaces: 24, maxRouteCandidates: 2 };
  if (extraMinutes <= 30)
    return { radiusMeters: 3_500, maxSearches: 5, maxPlaces: 45, maxRouteCandidates: 3 };
  return { radiusMeters: 6_000, maxSearches: 7, maxPlaces: 70, maxRouteCandidates: 4 };
}

export function planScenicWaypoint(
  places: ScenicPlace[],
  anchors: LatLng[],
  maximumEstimatedDetourMeters: number,
): ScenicWaypointPlan | null {
  const ranked = places
    .flatMap((place) => {
      const reasonType = [place.primaryType, ...place.types].find((type) => TYPE_REASON[type]);
      if (!reasonType || anchors.some((anchor) => haversineDistanceMeters(anchor, place) < 300)) {
        return [];
      }
      let bestIndex = 0;
      let estimatedDetourMeters = Number.POSITIVE_INFINITY;
      for (let index = 0; index < anchors.length - 1; index += 1) {
        const detour =
          haversineDistanceMeters(anchors[index], place) +
          haversineDistanceMeters(place, anchors[index + 1]) -
          haversineDistanceMeters(anchors[index], anchors[index + 1]);
        if (detour < estimatedDetourMeters) {
          estimatedDetourMeters = detour;
          bestIndex = index;
        }
      }
      return estimatedDetourMeters <= maximumEstimatedDetourMeters
        ? [
            {
              ...place,
              reason: TYPE_REASON[reasonType],
              insertionIndex: bestIndex,
              estimatedDetourMeters,
            },
          ]
        : [];
    })
    .sort(
      (a, b) =>
        a.estimatedDetourMeters - b.estimatedDetourMeters ||
        a.reason.localeCompare(b.reason) ||
        a.id.localeCompare(b.id),
    );
  return ranked[0] ?? null;
}

export function planScenicWaypoints(
  places: ScenicPlace[],
  anchors: LatLng[],
  maximumEstimatedDetourMeters: number,
  maximumPlans: number,
): ScenicWaypointPlan[] {
  return planScenicWaypointsWithDiagnostics(
    places,
    anchors,
    maximumEstimatedDetourMeters,
    maximumPlans,
  ).plans;
}

export function planScenicWaypointsWithDiagnostics(
  places: ScenicPlace[],
  anchors: LatLng[],
  maximumEstimatedDetourMeters: number,
  maximumPlans: number,
): ScenicWaypointPlanningDiagnostics {
  const plans: ScenicWaypointPlan[] = [];
  const remaining = [...places];
  let rejectedDuplicate = places.filter((place) =>
    anchors.some((anchor) => haversineDistanceMeters(anchor, place) < 300),
  ).length;
  const rejectedBacktracking = places.filter((place) => {
    if (![place.primaryType, ...place.types].some((type) => TYPE_REASON[type])) return false;
    if (anchors.some((anchor) => haversineDistanceMeters(anchor, place) < 300)) return false;
    const minimumDetour = anchors.slice(0, -1).reduce((minimum, anchor, index) => {
      const detour =
        haversineDistanceMeters(anchor, place) +
        haversineDistanceMeters(place, anchors[index + 1]) -
        haversineDistanceMeters(anchor, anchors[index + 1]);
      return Math.min(minimum, detour);
    }, Number.POSITIVE_INFINITY);
    return minimumDetour > maximumEstimatedDetourMeters;
  }).length;
  while (plans.length < maximumPlans) {
    const plan = planScenicWaypoint(remaining, anchors, maximumEstimatedDetourMeters);
    if (!plan) break;
    plans.push(plan);
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (
        remaining[index].id === plan.id ||
        haversineDistanceMeters(remaining[index], plan) < 300
      ) {
        if (remaining[index].id !== plan.id) rejectedDuplicate += 1;
        remaining.splice(index, 1);
      }
    }
  }
  return {
    plans,
    considered: places.length,
    rejectedDuplicate,
    rejectedBacktracking,
  };
}

const EVIDENCE_TYPES: Record<keyof ScenicEvidenceCounts, ReadonlySet<string>> = {
  natural: new Set([
    "park",
    "city_park",
    "national_park",
    "state_park",
    "nature_preserve",
    "woods",
    "botanical_garden",
    "garden",
    "hiking_area",
    "lake",
    "river",
  ]),
  historic: new Set(["castle", "historical_place", "historical_landmark", "history_museum"]),
  cultural: new Set(["museum", "art_gallery", "cultural_landmark"]),
  coastal: new Set(["beach", "marina"]),
  viewpoint: new Set(["scenic_spot", "observation_deck"]),
  wildlife: new Set(["wildlife_refuge", "wildlife_park"]),
  food: new Set(["farmers_market", "winery"]),
  otherPoi: new Set(["tourist_attraction", "locality"]),
};

export function evidenceForRoute(
  places: ScenicPlace[],
  routeSamples: LatLng[],
  proximityMeters: number,
): ScenicEvidenceCounts {
  const result = { ...EMPTY_SCENIC_EVIDENCE };
  for (const place of places) {
    if (!routeSamples.some((sample) => haversineDistanceMeters(sample, place) <= proximityMeters))
      continue;
    const types = new Set([place.primaryType, ...place.types]);
    for (const [category, categoryTypes] of Object.entries(EVIDENCE_TYPES) as Array<
      [keyof ScenicEvidenceCounts, ReadonlySet<string>]
    >) {
      if ([...types].some((type) => categoryTypes.has(type))) result[category] += 1;
    }
  }
  return result;
}

export function candidateFitsTimeBudget(
  baselineDurationSeconds: number,
  candidateDurationSeconds: number,
  extraMinutes: number,
): boolean {
  return (
    Number.isFinite(baselineDurationSeconds) &&
    baselineDurationSeconds > 0 &&
    Number.isFinite(candidateDurationSeconds) &&
    candidateDurationSeconds > 0 &&
    candidateDurationSeconds <= baselineDurationSeconds + Math.max(0, extraMinutes) * 60
  );
}
