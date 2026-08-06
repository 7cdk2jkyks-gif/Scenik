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

const clamp = (value: number, maximum: number) => Math.max(0, Math.min(maximum, Math.round(value)));

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

function routeTitle(moods: string[], themes: string[], detourRatio: number): string {
  const theme = themes[0];
  const mood = moods[0];
  const themeTitles: Record<string, string> = {
    Coastal: "Coastal Passage",
    Mountain: "Mountain Ramble",
    Forest: "Forest Escape",
    Countryside: "Country Meander",
    Historic: "Heritage Journey",
    Waterfalls: "Waterside Wander",
    Villages: "Village Ramble",
    "Scenic Viewpoints": "The Viewfinder Route",
    "Lakes & Rivers": "Waterside Journey",
    "Castles & Ruins": "Ruins & Roads",
    Stargazing: "Starlight Drive",
  };
  if (theme && themeTitles[theme]) return themeTitles[theme];
  if (mood) return `${mood} Road`;
  return detourRatio >= 1.12 ? "The Long Way Round" : "The Open Road";
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

  if (hasTheme("Historic", "Castles & Ruins")) add("Historic Treasure");
  if (hasTheme("Coastal")) add("Coastal Classic");
  if (hasTheme("Forest")) add("Forest Escape");
  if (hasTheme("Scenic Viewpoints")) add("Photographer’s Choice");
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

  // V1 intentionally uses only request choices and measurable route structure.
  // Natural features, verified POIs, elevation, land cover, and road classification
  // are Phase B inputs; until then the evidence-poor categories remain conservative.
  const naturalBeauty = clamp(
    5 + Math.min(3, (detourRatio - 1) * 10) + Math.min(2, input.stopCount),
    25,
  );
  const pointsOfInterest = clamp(3 + Math.min(12, input.stopCount * 3), 20);
  const moodMatch = clamp(
    (moods.length ? 4 : 2) +
      Math.min(2, input.stopCount) +
      (moods.some((mood) => ["Peaceful", "Relaxed", "Reflective"].includes(mood)) && turnDensity < 8
        ? 1
        : 0),
    10,
  );
  const roadCharacter = clamp(
    4 + Math.min(8, turnDensity * 0.8) + shortStepRatio * 4 + Math.min(3, (detourRatio - 1) * 10),
    20,
  );
  const themeMatch = clamp((themes.length ? 5 : 2) + Math.min(2, input.stopCount), 15);
  const diversity = clamp(
    2 + Math.min(4, Math.max(0, distanceBins - 1) * 1.5) + Math.min(2, input.stopCount),
    10,
  );

  const total = clamp(
    naturalBeauty + pointsOfInterest + moodMatch + roadCharacter + themeMatch + diversity,
    100,
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
          "Conservative until terrain and land-cover data are available; route deviation and stops provide limited evidence.",
        points_of_interest:
          input.stopCount > 0
            ? `Reflects ${input.stopCount} deliberate user stop${input.stopCount === 1 ? "" : "s"}; nearby POIs are not yet measured.`
            : "No user stops were added, and nearby points of interest are not yet measured.",
        mood_match: moods.length
          ? "Reflects your selected mood and the route variation currently measurable."
          : "No mood was selected, so this category receives only a conservative baseline.",
        road_character:
          "Uses turn density, step-length mix, and route deviation—not road surface or scenic-road classifications.",
        theme_match: themes.length
          ? "Acknowledges your selected theme without claiming unverified themed features along the road."
          : "No theme was selected, so no themed landscape or attraction is assumed.",
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
