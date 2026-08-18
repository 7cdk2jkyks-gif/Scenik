import { isValidLatLng } from "./scenic-waypoint";

export type JourneyMode = "fastest" | "scenic";
export type JourneyGenerationPath =
  | "fastest"
  | "zero-allowance-personalised"
  | "scenic-exploration";

export const MAX_EXTRA_MINUTES = 240;

const NEUTRAL_SELECTIONS = new Set(["", "none", "neutral", "default", "any", "open"]);

export function normalizeJourneySelection(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return NEUTRAL_SELECTIONS.has(normalized.toLowerCase()) ? "" : normalized;
}

export function normalizeJourneyExtraMinutes(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const numeric = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric <= 0) return 0;
  return Math.min(numeric, MAX_EXTRA_MINUTES);
}

export function normalizeJourneyPreferences(input: {
  mood?: unknown;
  theme?: unknown;
  extraMinutes?: unknown;
}): { mood: string; theme: string; extraMinutes: number } {
  return {
    mood: normalizeJourneySelection(input.mood),
    theme: normalizeJourneySelection(input.theme),
    extraMinutes: normalizeJourneyExtraMinutes(input.extraMinutes),
  };
}

export function journeyMode(input: {
  mood?: unknown;
  theme?: unknown;
  extraMinutes?: unknown;
}): JourneyMode {
  const normalized = normalizeJourneyPreferences(input);
  return normalized.mood || normalized.theme || normalized.extraMinutes > 0 ? "scenic" : "fastest";
}

export function journeyGenerationPath(input: {
  mood?: unknown;
  theme?: unknown;
  extraMinutes?: unknown;
}): JourneyGenerationPath {
  const normalized = normalizeJourneyPreferences(input);
  if (journeyMode(normalized) === "fastest") return "fastest";
  return normalized.extraMinutes > 0 ? "scenic-exploration" : "zero-allowance-personalised";
}

function normalizeJourneyLocation(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

export type JourneyRequestFingerprintInput = {
  origin?: unknown;
  destination?: unknown;
  stops?: readonly unknown[] | unknown;
  mood?: unknown;
  theme?: unknown;
  extraMinutes?: unknown;
};

export function journeyRequestIdentity(input: JourneyRequestFingerprintInput): string {
  const normalized = normalizeJourneyPreferences(input);
  return JSON.stringify({
    origin: normalizeJourneyLocation(input.origin),
    destination: normalizeJourneyLocation(input.destination),
    stops: Array.isArray(input.stops) ? input.stops.map(normalizeJourneyLocation) : [],
    mode: journeyMode(normalized),
    ...normalized,
  });
}

export type JourneyRequestToken = Readonly<{ sequence: number; fingerprint: string }>;

export type JourneyBudgetExplanation = Readonly<{
  usedMinutes: number;
  allowanceMinutes: number;
  explanation: string;
}>;

export function journeyAllowancePresentation(
  input: {
    mood?: unknown;
    theme?: unknown;
    extraMinutes?: unknown;
    generationPath?: JourneyGenerationPath;
  },
  budget: JourneyBudgetExplanation,
): string {
  const preferences = normalizeJourneyPreferences(input);
  if (preferences.extraMinutes === 0) {
    const generationPath =
      input.generationPath ??
      (preferences.mood === "" && preferences.theme.toLowerCase() === "direct route"
        ? "fastest"
        : journeyGenerationPath(preferences));
    return generationPath === "zero-allowance-personalised"
      ? "We kept you on the fastest route while shaping the journey around your preferences."
      : "Fastest route selected.";
  }
  return `We used ${budget.usedMinutes} of your ${budget.allowanceMinutes} extra minutes. ${budget.explanation}`;
}

export type JourneySearchCentre = Readonly<{ lat: number; lng: number }>;

function centreDistanceMeters(a: JourneySearchCentre, b: JourneySearchCentre): number {
  const earthRadiusMeters = 6_371_000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(b.lat - a.lat);
  const longitudeDelta = toRadians(b.lng - a.lng);
  const latitudeA = toRadians(a.lat);
  const latitudeB = toRadians(b.lat);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

export function meaningfullySpacedJourneySearchCentres(
  centres: readonly JourneySearchCentre[],
  radiusMeters: number,
): JourneySearchCentre[] {
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) return [];
  // At 1.5 radii, equal search circles overlap by about 14%, avoiding substantial
  // duplication while retaining useful adjacent evidence along the route.
  const minimumSeparationMeters = radiusMeters * 1.5;
  const validCentres = centres.filter(isValidLatLng).slice(0, 7);
  let bestIndices: number[] = [];
  let bestSpread = -1;
  let bestCentrality = Number.POSITIVE_INFINITY;
  for (let mask = 1; mask < 1 << validCentres.length; mask += 1) {
    const indices = validCentres.flatMap((_, index) => (mask & (1 << index) ? [index] : []));
    let spread = 0;
    let valid = true;
    for (let left = 0; left < indices.length && valid; left += 1) {
      for (let right = left + 1; right < indices.length; right += 1) {
        const distance = centreDistanceMeters(
          validCentres[indices[left]],
          validCentres[indices[right]],
        );
        if (distance < minimumSeparationMeters) {
          valid = false;
          break;
        }
        spread += distance;
      }
    }
    if (!valid) continue;
    const midpoint = (validCentres.length - 1) / 2;
    const centrality = indices.reduce((sum, index) => sum + Math.abs(index - midpoint), 0);
    if (
      indices.length > bestIndices.length ||
      (indices.length === bestIndices.length && spread > bestSpread) ||
      (indices.length === bestIndices.length &&
        spread === bestSpread &&
        centrality < bestCentrality)
    ) {
      bestIndices = indices;
      bestSpread = spread;
      bestCentrality = centrality;
    }
  }
  return bestIndices.map((index) => validCentres[index]);
}

export async function collectZeroAllowanceJourneyEvidence<TPlace extends { id: string }>(input: {
  preferences: { mood?: unknown; theme?: unknown; extraMinutes?: unknown };
  candidateCentres: readonly JourneySearchCentre[];
  radiusMeters: number;
  search: (centre: JourneySearchCentre) => Promise<readonly TPlace[]>;
  evidenceCap?: number;
}): Promise<{ centres: JourneySearchCentre[]; places: TPlace[]; callCount: number }> {
  if (journeyGenerationPath(input.preferences) !== "zero-allowance-personalised")
    return { centres: [], places: [], callCount: 0 };
  const centres = meaningfullySpacedJourneySearchCentres(
    input.candidateCentres,
    input.radiusMeters,
  );
  const results = await Promise.allSettled(centres.map((centre) => input.search(centre)));
  const places = new Map<string, TPlace>();
  const evidenceCap = Math.max(0, Math.floor(input.evidenceCap ?? 70));
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const place of result.value) {
      if (!places.has(place.id) && places.size < evidenceCap) places.set(place.id, place);
    }
  }
  return { centres, places: [...places.values()], callCount: centres.length };
}

export class LatestJourneyRequestOwnership {
  private sequence = 0;
  private activeSequence = 0;
  private mounted = true;

  activate(): void {
    this.mounted = true;
  }

  begin(fingerprint: string): JourneyRequestToken {
    const token = { sequence: ++this.sequence, fingerprint } as const;
    this.activeSequence = token.sequence;
    return token;
  }

  isCurrent(token: JourneyRequestToken, fingerprint: string = token.fingerprint): boolean {
    return (
      this.mounted && token.sequence === this.activeSequence && token.fingerprint === fingerprint
    );
  }

  invalidate(): void {
    this.activeSequence = ++this.sequence;
  }

  dispose(): void {
    this.mounted = false;
    this.invalidate();
  }
}

type RequestFrame = (callback: () => void) => number;
type CancelFrame = (handle: number) => void;

export class OwnedJourneyAnimationFrame {
  private pending: { handle: number; cancel: CancelFrame } | null = null;
  private generation = 0;

  cancel(): void {
    this.generation += 1;
    if (!this.pending) return;
    this.pending.cancel(this.pending.handle);
    this.pending = null;
  }

  schedule(input: {
    ownership: LatestJourneyRequestOwnership;
    token: JourneyRequestToken;
    fingerprint?: string;
    effect: () => void;
    requestFrame?: RequestFrame;
    cancelFrame?: CancelFrame;
  }): void {
    this.cancel();
    const fingerprint = input.fingerprint ?? input.token.fingerprint;
    if (!input.ownership.isCurrent(input.token, fingerprint)) return;
    if (!input.requestFrame || !input.cancelFrame) {
      if (input.ownership.isCurrent(input.token, fingerprint)) input.effect();
      return;
    }
    const generation = ++this.generation;
    const cancel = input.cancelFrame;
    const handle = input.requestFrame(() => {
      if (this.generation !== generation) return;
      if (this.pending?.handle === handle) this.pending = null;
      if (input.ownership.isCurrent(input.token, fingerprint)) input.effect();
    });
    this.pending = { handle, cancel };
  }
}

export type JourneySuccessPublications = Readonly<{
  publishSuccessState: () => void;
  publishPresentation: () => void;
  publishDiagnostics: () => void;
  openIntroduction: () => void;
  publishAnalytics: () => void;
  scroll: () => void;
}>;

export type JourneyFailurePublications = Readonly<{
  publishError: () => void;
  publishToast: () => void;
  publishAnalytics?: () => void;
}>;

export class JourneyRequestPublicationCoordinator {
  readonly ownership = new LatestJourneyRequestOwnership();
  readonly animationFrame = new OwnedJourneyAnimationFrame();

  activate(): void {
    this.ownership.activate();
  }

  begin(fingerprint: string): JourneyRequestToken {
    this.animationFrame.cancel();
    return this.ownership.begin(fingerprint);
  }

  isCurrent(token: JourneyRequestToken, fingerprint: string = token.fingerprint): boolean {
    return this.ownership.isCurrent(token, fingerprint);
  }

  publishSuccess(input: {
    token: JourneyRequestToken;
    fingerprint?: string;
    publications: JourneySuccessPublications;
    requestFrame?: RequestFrame;
    cancelFrame?: CancelFrame;
  }): boolean {
    const fingerprint = input.fingerprint ?? input.token.fingerprint;
    if (!this.isCurrent(input.token, fingerprint)) return false;
    input.publications.publishSuccessState();
    input.publications.publishPresentation();
    input.publications.publishDiagnostics();
    input.publications.openIntroduction();
    input.publications.publishAnalytics();
    this.animationFrame.schedule({
      ownership: this.ownership,
      token: input.token,
      fingerprint,
      effect: input.publications.scroll,
      requestFrame: input.requestFrame,
      cancelFrame: input.cancelFrame,
    });
    return true;
  }

  publishFailure(input: {
    token: JourneyRequestToken;
    fingerprint?: string;
    publications: JourneyFailurePublications;
  }): boolean {
    const fingerprint = input.fingerprint ?? input.token.fingerprint;
    if (!this.isCurrent(input.token, fingerprint)) return false;
    input.publications.publishAnalytics?.();
    input.publications.publishError();
    input.publications.publishToast();
    return true;
  }

  publishSettled(
    token: JourneyRequestToken,
    publishLoadingCleanup: () => void,
    fingerprint: string = token.fingerprint,
  ): boolean {
    if (!this.isCurrent(token, fingerprint)) return false;
    publishLoadingCleanup();
    return true;
  }

  reset(): void {
    this.animationFrame.cancel();
    this.ownership.invalidate();
  }

  dispose(): void {
    this.animationFrame.cancel();
    this.ownership.dispose();
  }
}

export function journeyCtaLabel(input: {
  mood?: unknown;
  theme?: unknown;
  extraMinutes?: unknown;
}): string {
  return journeyMode(input) === "fastest" ? "Take the fastest route" : "Plan my drive";
}
