import type { ComputedDirections } from "./google-maps.server";
import { EMPTY_SCENIC_EVIDENCE, type ScenicEvidenceCounts } from "./scenic-waypoint";

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

export const SCENIC_CATEGORY_WEIGHTS = {
  natural_beauty: 25,
  points_of_interest: 20,
  mood_match: 10,
  road_character: 20,
  theme_match: 15,
  diversity: 10,
} as const;

const LEGACY_CATEGORY_MAXIMA = {
  natural_beauty: 25,
  points_of_interest: 20,
  mood_match: 10,
  road_character: 20,
  theme_match: 15,
  diversity: 10,
} as const;

export function evidenceSupportCounts(input: {
  evidence: ScenicEvidenceCounts;
  moods: string[];
  themes: string[];
}) {
  const { evidence, moods, themes } = input;
  const theme = themes.reduce((sum, selectedTheme) => {
    if (["Historic", "Castles & Ruins"].includes(selectedTheme)) return sum + evidence.historic;
    if (selectedTheme === "Art & Culture") return sum + evidence.cultural + evidence.historic * 0.5;
    if (["Coastal", "Lakes & Rivers", "Waterfalls"].includes(selectedTheme))
      return sum + evidence.coastal + evidence.natural * 0.5;
    if (["Forest", "Countryside", "Mountain", "Dog Friendly"].includes(selectedTheme))
      return sum + evidence.natural;
    if (["Scenic Viewpoints", "Stargazing"].includes(selectedTheme))
      return sum + evidence.viewpoint;
    if (selectedTheme === "Wildlife") return sum + evidence.wildlife + evidence.natural * 0.25;
    if (selectedTheme === "Foodie") return sum + evidence.food;
    if (selectedTheme === "Villages") return sum + evidence.otherPoi;
    return sum;
  }, 0);
  const mood = moods.reduce((sum, selectedMood) => {
    if (["Peaceful", "Relaxed", "Reflective", "Cosy", "Romantic"].includes(selectedMood))
      return sum + evidence.natural + evidence.coastal + evidence.historic * 0.4;
    if (["Adventurous", "Awestruck", "Energetic"].includes(selectedMood))
      return sum + evidence.viewpoint + evidence.natural * 0.5 + evidence.wildlife * 0.5;
    if (["Curious", "Inspired", "Nostalgic"].includes(selectedMood))
      return sum + evidence.historic + evidence.cultural;
    return sum;
  }, 0);
  return { natural: evidence.natural, theme, mood };
}

type CategoryValues = Pick<
  ScenicScoreBreakdown,
  | "natural_beauty"
  | "points_of_interest"
  | "mood_match"
  | "road_character"
  | "theme_match"
  | "diversity"
>;

export function normalizeVisibleCategories(
  values: CategoryValues,
  sourceScale: "legacy" | "ten" = "ten",
): CategoryValues {
  return Object.fromEntries(
    Object.entries(LEGACY_CATEGORY_MAXIMA).map(([key, legacyMaximum]) => {
      const category = key as keyof CategoryValues;
      const value = Number.isFinite(values[category]) ? values[category] : 0;
      return [category, clamp(sourceScale === "legacy" ? (value / legacyMaximum) * 10 : value, 10)];
    }),
  ) as unknown as CategoryValues;
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
  evidence?: ScenicEvidenceCounts;
  fastestDurationSeconds?: number;
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
  const evidence = input.evidence ?? EMPTY_SCENIC_EVIDENCE;
  const evidenceCategories = Object.values(evidence).filter((count) => count > 0).length;
  const totalEvidence = Object.values(evidence).reduce((sum, count) => sum + count, 0);
  const naturalEvidence =
    evidence.natural * 3.2 + evidence.coastal * 3 + evidence.viewpoint * 3 + evidence.wildlife * 2;
  const poiEvidence =
    evidence.historic * 2.5 +
    evidence.cultural * 2.2 +
    evidence.viewpoint * 1.5 +
    evidence.coastal * 1.2 +
    evidence.food * 1.5 +
    evidence.otherPoi * 1.2;
  const { theme: themeEvidence, mood: moodEvidence } = evidenceSupportCounts({
    evidence,
    moods,
    themes,
  });

  const naturalBeauty = clamp(
    4 + Math.min(18, naturalEvidence) + Math.min(3, Math.max(0, detourRatio - 1) * 8),
    25,
  );
  const pointsOfInterest = clamp(5 + Math.min(13, poiEvidence) + Math.min(2, input.stopCount), 20);
  const moodMatch = clamp(
    (moods.length ? 2 + Math.min(0.5, (moods.length - 1) * 0.25) : 1) +
      Math.min(8, moodEvidence * 1.4) +
      Math.min(0.5, input.stopCount),
    10,
  );
  const roadCharacter = clamp(
    7 +
      Math.min(7, turnDensity * 0.75) +
      shortStepRatio * 3 +
      Math.min(2, distanceBins - 1) +
      Math.min(2, (detourRatio - 1) * 8),
    20,
  );
  const themeMatch = clamp(
    (themes.length ? 3 + Math.min(0.75, (themes.length - 1) * 0.35) : 1) +
      Math.min(12, themeEvidence * 2.1) +
      Math.min(1, input.stopCount),
    15,
  );
  const diversity = clamp(
    4 +
      Math.min(3, evidenceCategories * 0.8) +
      Math.min(2, Math.max(0, distanceBins - 1)) +
      Math.min(1, totalEvidence * 0.1),
    10,
  );

  const visibleCategories = normalizeVisibleCategories(
    {
      natural_beauty: naturalBeauty,
      points_of_interest: pointsOfInterest,
      mood_match: moodMatch,
      road_character: roadCharacter,
      theme_match: themeMatch,
      diversity,
    },
    "legacy",
  );
  const total = Math.round(
    clamp(
      (naturalBeauty / 25) * SCENIC_CATEGORY_WEIGHTS.natural_beauty +
        (pointsOfInterest / 20) * SCENIC_CATEGORY_WEIGHTS.points_of_interest +
        (moodMatch / 10) * SCENIC_CATEGORY_WEIGHTS.mood_match +
        (roadCharacter / 20) * SCENIC_CATEGORY_WEIGHTS.road_character +
        (themeMatch / 15) * SCENIC_CATEGORY_WEIGHTS.theme_match +
        (diversity / 10) * SCENIC_CATEGORY_WEIGHTS.diversity,
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
  const measuredExtraMinutes = input.fastestDurationSeconds
    ? Math.max(
        0,
        Math.round((input.directions.durationSeconds - input.fastestDurationSeconds) / 60),
      )
    : 0;
  const extraMinutes = measuredExtraMinutes > 0 ? measuredExtraMinutes : null;
  const worthExtraTime =
    input.extraMinutes === 0
      ? {
          verdict: "Direct choice" as const,
          explanation:
            "No extra-time budget was requested, so this route prioritises a direct drive.",
          extraMinutes,
        }
      : measuredExtraMinutes > 0 && (totalEvidence > 0 || visibleCategories.road_character >= 6)
        ? {
            verdict: "Yes" as const,
            explanation: `The route uses ${measuredExtraMinutes} measured extra minute${measuredExtraMinutes === 1 ? "" : "s"} and scored higher using verified evidence or route geometry.`,
            extraMinutes,
          }
        : {
            verdict: "Promising" as const,
            explanation:
              "The route remains close to the fastest baseline and the available evidence does not justify a stronger claim.",
            extraMinutes,
          };

  return {
    total,
    breakdown: {
      ...visibleCategories,
      rationale:
        "This score uses verified Places categories near the sampled route corridor and measurable route geometry.",
      explanations: {
        natural_beauty:
          evidence.natural + evidence.coastal + evidence.viewpoint + evidence.wildlife > 0
            ? `${evidence.natural + evidence.coastal + evidence.viewpoint + evidence.wildlife} verified natural, waterside, viewpoint or wildlife signal${evidence.natural + evidence.coastal + evidence.viewpoint + evidence.wildlife === 1 ? " appears" : "s appear"} near the sampled route corridor.`
            : "No verified natural, waterside, viewpoint or wildlife evidence was found near the sampled corridor.",
        points_of_interest:
          poiEvidence > 0
            ? `${Math.round(poiEvidence)} weighted verified cultural, historic or attraction signals appear near the sampled corridor.`
            : "No verified scenic points of interest were found near the sampled corridor.",
        mood_match: moods.length
          ? moodEvidence > 0
            ? "Verified corridor evidence supports the selected mood."
            : "The selected mood receives limited intent credit without supporting verified evidence."
          : "No mood was selected.",
        road_character:
          "Uses measured turn density, step-length variation and route deviation; it does not claim road surface or scenery.",
        theme_match: themes.length
          ? themeEvidence > 0
            ? `${Math.round(themeEvidence)} weighted verified evidence signal${themeEvidence === 1 ? " supports" : "s support"} the selected theme.`
            : "The selected theme receives limited intent credit without supporting verified evidence."
          : "No theme was selected.",
        diversity: `Uses ${evidenceCategories} verified evidence categor${evidenceCategories === 1 ? "y" : "ies"} plus measured route-step variation.`,
      },
    },
    overallVerdict,
    worthExtraTime,
    badges,
    title: routeTitle(moods, themes, detourRatio),
  };
}
