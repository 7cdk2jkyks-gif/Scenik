import type { JourneyTimelineEvent } from "./journey-timeline";

export type AchievementKey =
  | "first_scenic_journey"
  | "forest_explorer"
  | "historic_wanderer"
  | "waterside_drive"
  | "scenic_miles_100"
  | "scenic_miles_500"
  | "journeys_10";

export type JourneyAchievement = {
  key: AchievementKey;
  name: string;
  description: string;
};

export type AchievementProgress = {
  completedJourneys: number;
  scenicMiles: number;
  earned: AchievementKey[];
};

export type CompletionFacts = {
  distanceMiles: number;
  discoveries: JourneyTimelineEvent[];
};

export const JOURNEY_ACHIEVEMENTS: Record<AchievementKey, JourneyAchievement> = {
  first_scenic_journey: {
    key: "first_scenic_journey",
    name: "First Scenic Journey",
    description: "Completed your first Scenik journey.",
  },
  forest_explorer: {
    key: "forest_explorer",
    name: "Forest Explorer",
    description: "Discovered a woodland or forest place.",
  },
  historic_wanderer: {
    key: "historic_wanderer",
    name: "Historic Wanderer",
    description: "Discovered a historic place.",
  },
  waterside_drive: {
    key: "waterside_drive",
    name: "Waterside Drive",
    description: "Discovered a waterside place.",
  },
  scenic_miles_100: {
    key: "scenic_miles_100",
    name: "100 Scenic Miles",
    description: "Travelled 100 miles on scenic journeys.",
  },
  scenic_miles_500: {
    key: "scenic_miles_500",
    name: "500 Scenic Miles",
    description: "Travelled 500 miles on scenic journeys.",
  },
  journeys_10: {
    key: "journeys_10",
    name: "10 Journeys Completed",
    description: "Completed ten Scenik journeys.",
  },
};

const terms = (event: JourneyTimelineEvent) =>
  `${event.category} ${event.evidenceCategory ?? ""}`.toLocaleLowerCase();

export function discoveryCounts(discoveries: JourneyTimelineEvent[]) {
  return discoveries.reduce(
    (counts, discovery) => {
      const value = terms(discovery);
      if (/historic|heritage|castle|museum|ruin/.test(value)) counts.historic += 1;
      else if (/water|lake|river|coast|beach|harbou?r|marina|canal/.test(value))
        counts.waterside += 1;
      else counts.natural += 1;
      return counts;
    },
    { natural: 0, historic: 0, waterside: 0 },
  );
}

export function applyJourneyCompletion(
  previous: AchievementProgress,
  completion: CompletionFacts,
): { progress: AchievementProgress; unlocked: JourneyAchievement[] } {
  const counts = discoveryCounts(completion.discoveries);
  const completedJourneys = previous.completedJourneys + 1;
  const scenicMiles = previous.scenicMiles + Math.max(0, completion.distanceMiles);
  const candidates: AchievementKey[] = ["first_scenic_journey"];
  if (completion.discoveries.some((item) => /wood|forest/.test(terms(item))))
    candidates.push("forest_explorer");
  if (counts.historic > 0) candidates.push("historic_wanderer");
  if (counts.waterside > 0) candidates.push("waterside_drive");
  if (scenicMiles >= 100) candidates.push("scenic_miles_100");
  if (scenicMiles >= 500) candidates.push("scenic_miles_500");
  if (completedJourneys >= 10) candidates.push("journeys_10");

  const alreadyEarned = new Set(previous.earned);
  const unlocked = [...new Set(candidates)]
    .filter((key) => !alreadyEarned.has(key))
    .map((key) => JOURNEY_ACHIEVEMENTS[key]);
  return {
    progress: {
      completedJourneys,
      scenicMiles,
      earned: [...previous.earned, ...unlocked.map((item) => item.key)],
    },
    unlocked,
  };
}

export function emptyAchievementProgress(): AchievementProgress {
  return { completedJourneys: 0, scenicMiles: 0, earned: [] };
}

export function loadAchievementProgress(userId: string | null): AchievementProgress {
  if (typeof localStorage === "undefined") return emptyAchievementProgress();
  try {
    const value = JSON.parse(
      localStorage.getItem(`scenik.achievements.v1.${userId ?? "guest"}`) ?? "null",
    );
    if (!value || !Array.isArray(value.earned)) return emptyAchievementProgress();
    return {
      completedJourneys: Math.max(0, Number(value.completedJourneys) || 0),
      scenicMiles: Math.max(0, Number(value.scenicMiles) || 0),
      earned: value.earned.filter((key: string) => key in JOURNEY_ACHIEVEMENTS),
    };
  } catch {
    return emptyAchievementProgress();
  }
}

export function saveAchievementProgress(userId: string | null, progress: AchievementProgress) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(`scenik.achievements.v1.${userId ?? "guest"}`, JSON.stringify(progress));
  } catch {
    // Completion remains available when storage is disabled or full.
  }
}
