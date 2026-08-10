import type { ScenicEvidenceCounts } from "./scenic-waypoint";

export type VerifiedJourneyDiscovery = {
  name?: string;
  category?: string;
};

type JourneyNamingInput = {
  evidence?: Partial<ScenicEvidenceCounts> | null;
  themes?: string | string[] | null;
  discoveries?: VerifiedJourneyDiscovery[] | null;
};

type EvidenceFamily = "forest" | "historic" | "water" | "viewpoint" | "mixed" | "none";

const splitSelections = (value: string | string[] | null | undefined) =>
  (Array.isArray(value) ? value : (value ?? "").split(","))
    .map((selection) => selection.trim().toLowerCase())
    .filter(Boolean);

const includesAny = (value: string, needles: string[]) =>
  needles.some((needle) => value.includes(needle));

function evidenceFamily(input: JourneyNamingInput): EvidenceFamily {
  const counts = input.evidence ?? {};
  const themes = splitSelections(input.themes);
  const categories = (input.discoveries ?? [])
    .map((discovery) => discovery.category?.trim().toLowerCase() ?? "")
    .filter(Boolean);

  const categoryCount = (needles: string[]) =>
    categories.filter((category) => includesAny(category, needles)).length;
  const supportsTheme = (...values: string[]) => values.some((value) => themes.includes(value));
  const forestCategoryCount = categoryCount(["wood", "forest"]);

  const strengths = {
    forest:
      forestCategoryCount +
      (forestCategoryCount > 0 ? (counts.natural ?? 0) : 0) +
      (supportsTheme("forest") && categoryCount(["national park", "nature reserve"]) > 0 ? 1 : 0),
    historic:
      (counts.historic ?? 0) + categoryCount(["historic", "heritage", "castle", "museum", "ruin"]),
    water:
      (counts.coastal ?? 0) +
      categoryCount(["lake", "river", "water", "coast", "beach", "harbour", "marina"]),
    viewpoint:
      (counts.viewpoint ?? 0) + categoryCount(["viewpoint", "scenic", "lookout", "observation"]),
  };
  const ranked = (
    Object.entries(strengths) as Array<[Exclude<EvidenceFamily, "mixed" | "none">, number]>
  )
    .filter(([, strength]) => strength > 0)
    .sort(([familyA, strengthA], [familyB, strengthB]) =>
      strengthB === strengthA ? familyA.localeCompare(familyB) : strengthB - strengthA,
    );

  if (ranked.length === 0) return "none";
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return "mixed";
  return ranked[0][0];
}

export function journeyTitle(input: JourneyNamingInput): string {
  switch (evidenceFamily(input)) {
    case "forest":
      return "Woodland Escape";
    case "historic":
      return "Heritage Run";
    case "water":
      return "Waterside Escape";
    case "viewpoint":
      return "The Viewfinder Route";
    case "mixed":
      return "Discovery Drive";
    default:
      return "The Scenic Journey";
  }
}

export function journeyEvidenceLine(input: JourneyNamingInput): string {
  const counts = input.evidence ?? {};
  const categories = (input.discoveries ?? [])
    .map((discovery) => discovery.category?.trim().toLowerCase() ?? "")
    .filter(Boolean);
  const categoryCount = (needles: string[]) =>
    categories.filter((category) => includesAny(category, needles)).length;
  const numberWord = (count: number) =>
    count === 1 ? "One" : count === 2 ? "Two" : count === 3 ? "Three" : String(count);
  const signal = (label: string, count: number) =>
    `${numberWord(count)} ${label} ${count === 1 ? "discovery" : "discoveries"}`;

  const woodlandCount = categoryCount(["wood", "forest"]);
  const naturalCount = categoryCount(["park", "nature", "reserve"]);
  const historicCount = categoryCount(["historic", "heritage", "castle", "museum", "ruin"]);
  const watersideCount = categoryCount([
    "lake",
    "river",
    "water",
    "coast",
    "beach",
    "harbour",
    "marina",
  ]);
  const viewpointCount = categoryCount(["viewpoint", "scenic", "lookout", "observation"]);
  const culturalCount = categoryCount(["gallery", "cultural", "art"]);
  const signals = [
    woodlandCount > 0
      ? signal("woodland", woodlandCount)
      : (counts.natural ?? 0) > 0
        ? signal("natural", counts.natural ?? 0)
        : naturalCount > 0
          ? signal("natural", naturalCount)
          : null,
    historicCount > 0
      ? signal("historic", historicCount)
      : (counts.historic ?? 0) > 0
        ? signal("historic", counts.historic ?? 0)
        : null,
    watersideCount > 0
      ? signal("waterside", watersideCount)
      : (counts.coastal ?? 0) > 0
        ? signal("waterside", counts.coastal ?? 0)
        : null,
    viewpointCount > 0
      ? signal("viewpoint", viewpointCount)
      : (counts.viewpoint ?? 0) > 0
        ? signal("viewpoint", counts.viewpoint ?? 0)
        : null,
    culturalCount > 0
      ? signal("cultural", culturalCount)
      : (counts.cultural ?? 0) > 0
        ? signal("cultural", counts.cultural ?? 0)
        : null,
  ].filter((value): value is string => value != null);

  if (signals.length === 0) return "Measured road variety shaped this journey.";
  const shown = signals.slice(0, 3);
  const phrase =
    shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
  return `${phrase} shaped this journey.`;
}
