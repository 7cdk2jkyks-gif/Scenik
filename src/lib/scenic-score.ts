import type { ComputedDirections } from "./google-maps.server";

export const SCENIC_BADGES = [
  "Hidden Gem",
  "Sunset Drive",
  "Historic Treasure",
  "Coastal Classic",
  "Forest Escape",
  "Couples Favourite",
  "Motorcycle Heaven",
  "Photographer’s Choice",
  "Scenic Detour",
  "Relaxed Escape",
] as const;

export type ScenicBadge = (typeof SCENIC_BADGES)[number];

export interface ScenicScoreBreakdown {
  natural_beauty: number;
  points_of_interest: number;
  mood_match: number;
  road_character: number;
  theme_match: number;
  diversity: number;
  rationale: string;
  explanations: {
    natural_beauty: string;
    points_of_interest: string;
    mood_match: string;
    road_character: string;
    theme_match: string;
    diversity: string;
  };
}

export interface ScenicScoreResult {
  total: number;
  breakdown: ScenicScoreBreakdown;
  overallVerdict: string;
  worthExtraTime: {
    verdict: "Yes" | "Promising" | "Direct choice";
    explanation: string;
    extraMinutes: number | null;
  };
  badges: ScenicBadge[];
  title: string;
}

const clamp = (value: number, maximum: number) =>
  Math.max(0, Math.min(maximum, Math.round(value * 10) / 10));

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(h));
}

function selections(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function preferenceScore(
  selected: string[],
  groups: readonly (readonly string[])[],
  neutral: number,
  single: number,
  maximum: number,
): number {
  if (selected.length === 0) return neutral;
  const representedGroups = new Set(
    selected
      .map((item) => groups.findIndex((group) => group.includes(item)))
      .filter((index) => index >= 0),
  ).size;
  const compatibleBonus = Math.min(2, selected.length - 1);
  const breadthPenalty = Math.max(0, representedGroups - 1) + Math.max(0, selected.length - 3);
  return clamp(single + compatibleBonus - breadthPenalty, maximum);
}

function routeTitle(moods: string[], themes: string[], detourRatio: number): string {
  void moods;
  void themes;
  return detourRatio >= 1.12 ? "Scenic drive — longer route" : "Scenic drive";
}

function chooseBadges(input: {
  moods: string[];
  themes: string[];
  stops: number;
  detourRatio: number;
  turnDensity: number;
}): ScenicBadge[] {
  const badges: ScenicBadge[] = [];
  const hasMood = (...values: string[]) => values.some((value) => input.moods.includes(value));
  const hasTheme = (...values: string[]) => values.some((value) => input.themes.includes(value));
  const add = (badge: ScenicBadge) => {
    if (!badges.includes(badge) && badges.length < 3) badges.push(badge);
  };

  void hasTheme;
  if (hasMood("Romantic")) add("Couples Favourite");
  if (hasMood("Peaceful", "Relaxed", "Reflective", "Cosy")) add("Relaxed Escape");
  if (hasMood("Adventurous", "Energetic") && input.turnDensity >= 5) add("Motorcycle Heaven");
  if (input.stops >= 2 && input.detourRatio >= 1.1) add("Hidden Gem");
  if (input.detourRatio >= 1.12) add("Scenic Detour");
  return badges;
}

export function scoreScenicRoute(input: {
  start: { lat: number; lng: number };
  end: { lat: number; lng: number };
  mood: string;
  theme: string;
  extraMinutes: number;
  stopCount: number;
  directions: ComputedDirections;
}): ScenicScoreResult {
  const moods = selections(input.mood);
  const themes = selections(input.theme);
  const directDistance = Math.max(1, haversineMeters(input.start, input.end));
  const detourRatio = Math.max(1, input.directions.distanceMeters / directDistance);
  const routeKm = Math.max(1, input.directions.distanceMeters / 1000);
  const steps = input.directions.steps.filter((step) => step.distanceMeters > 0);
  const turns = steps.filter(
    (step) => step.maneuver && !/straight|unspecified/i.test(step.maneuver),
  );
  const turnDensity = (turns.length / routeKm) * 10;
  const shortStepRatio = steps.length
    ? steps.filter((step) => step.distanceMeters < 1_000).length / steps.length
    : 0;
  const distanceBins = new Set(
    steps.map((step) =>
      step.distanceMeters < 500
        ? "short"
        : step.distanceMeters < 2_000
          ? "medium"
          : step.distanceMeters < 10_000
            ? "long"
            : "very-long",
    ),
  ).size;

  const moodPreference = preferenceScore(
    moods,
    [
      ["Peaceful", "Relaxed", "Reflective", "Cosy"],
      ["Adventurous", "Energetic", "Spontaneous", "Awestruck"],
      ["Romantic", "Nostalgic", "Inspired"],
      ["Curious", "Playful", "Joyful"],
      ["Focused"],
    ],
    5,
    6,
    9,
  );
  const themePreference = preferenceScore(
    themes,
    [
      ["Coastal", "Lakes & Rivers", "Waterfalls"],
      ["Mountain", "Forest", "Wildlife", "Scenic Viewpoints", "Stargazing"],
      ["Countryside", "Villages", "Dog Friendly"],
      ["Historic", "Castles & Ruins", "Art & Culture"],
      ["Foodie"],
    ],
    7,
    8,
    13,
  );

  // V1 intentionally uses only request choices and measurable route structure.
  // Unknown environmental/POI evidence receives a neutral midpoint, not a fail.
  // Terrain, verified POIs, elevation, land cover, and road classification are
  // Phase B inputs that will create stronger separation later.
  const naturalBeauty = clamp(
    13 + Math.min(4, (detourRatio - 1) * 10) + Math.min(2, input.stopCount),
    25,
  );
  const pointsOfInterest = clamp(9 + Math.min(9, input.stopCount * 3), 20);
  const moodMatch = clamp(
    moodPreference +
      Math.min(1, input.stopCount) +
      (moods.some((mood) => ["Peaceful", "Relaxed", "Reflective"].includes(mood)) && turnDensity < 8
        ? 1
        : 0),
    10,
  );
  const roadCharacter = clamp(
    6 + Math.min(7, turnDensity * 0.7) + shortStepRatio * 3 + Math.min(3, (detourRatio - 1) * 10),
    20,
  );
  const themeMatch = clamp(themePreference + Math.min(1, input.stopCount), 15);
  const diversity = clamp(
    5 + Math.min(3, Math.max(0, distanceBins - 1)) + Math.min(2, input.stopCount),
    10,
  );

  const total = Math.round(
    clamp(
      naturalBeauty + pointsOfInterest + moodMatch + roadCharacter + themeMatch + diversity,
      100,
    ),
  );
  const badges = chooseBadges({
    moods,
    themes,
    stops: input.stopCount,
    detourRatio,
    turnDensity,
  });
  const overallVerdict =
    total >= 70
      ? "A varied drive with strong route-shape signals."
      : total >= 50
        ? "A promising drive, scored cautiously with the evidence available."
        : "A practical route with limited verified scenic evidence so far.";
  const extraMinutes = input.extraMinutes > 0 ? input.extraMinutes : null;
  const worthExtraTime =
    input.extraMinutes === 0
      ? {
          verdict: "Direct choice" as const,
          explanation:
            "No extra-time budget was requested, so this route prioritises a direct drive.",
          extraMinutes,
        }
      : detourRatio >= 1.1 || input.stopCount > 0
        ? {
            verdict: "Yes" as const,
            explanation:
              "The route has measurable variation or deliberate stops, while the time shown is your budget rather than a measured delay.",
            extraMinutes,
          }
        : {
            verdict: "Promising" as const,
            explanation:
              "The route stays fairly direct; richer scenery and POI data will make this verdict more precise.",
            extraMinutes,
          };

  return {
    total,
    breakdown: {
      natural_beauty: naturalBeauty,
      points_of_interest: pointsOfInterest,
      mood_match: moodMatch,
      road_character: roadCharacter,
      theme_match: themeMatch,
      diversity,
      rationale:
        "This score is based on route shape, selected mood and theme, stops, and road characteristics currently available.",
      explanations: {
        natural_beauty:
          "Environmental evidence is currently neutral; route deviation and stops provide the measurable variation.",
        points_of_interest:
          input.stopCount > 0
            ? `Reflects ${input.stopCount} deliberate user stop${input.stopCount === 1 ? "" : "s"}; nearby POIs are not yet measured.`
            : "Nearby attractions are not yet measured, so unknown POI evidence is scored neutrally.",
        mood_match: moods.length
          ? `Reflects ${moods.length} selected mood${moods.length === 1 ? "" : "s"}, rewarding compatible combinations without assuming scenery.`
          : "No mood was selected, so this category uses a neutral baseline.",
        road_character:
          "Uses turn density, step-length mix, and route deviation—not road surface or scenic-road classifications.",
        theme_match: themes.length
          ? `Reflects ${themes.length} selected theme${themes.length === 1 ? "" : "s"}; broad combinations are moderated and features remain unverified.`
          : "No theme was selected, so this category uses a neutral baseline without assuming features.",
        diversity:
          "Uses the mix of short and long route steps plus deliberate stops as a provisional variety signal.",
      },
    },
    overallVerdict,
    worthExtraTime,
    badges,
    title: routeTitle(moods, themes, detourRatio),
  };
}
