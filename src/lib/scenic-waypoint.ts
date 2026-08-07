export type LatLng = { lat: number; lng: number };

export type ScenicPlace = LatLng & {
  id: string;
  primaryType: string;
  types: string[];
};

export type ScenicWaypointPlan = ScenicPlace & {
  reason: string;
  insertionIndex: number;
  estimatedDetourMeters: number;
};

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
  "Lakes & Rivers": ["park", "nature_preserve", "marina"],
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
  const ordered = [
    ...themes.flatMap((theme) => THEME_TYPES[theme] ?? []),
    ...moods.flatMap((mood) => MOOD_TYPES[mood] ?? []),
  ];
  return [...new Set(ordered.length ? ordered : ["park", "nature_preserve", "scenic_spot"])].slice(
    0,
    20,
  );
}

export function haversineDistanceMeters(a: LatLng, b: LatLng): number {
  const radians = (value: number) => (value * Math.PI) / 180;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(value));
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
  return { lat: (start.lat + end.lat) / 2, lng: (start.lng + end.lng) / 2 };
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
