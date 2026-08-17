export type NarrationMode = "off" | "highlights" | "full";
export type NarrationVoiceStyle = "default" | "calm" | "warm";

export type VoiceProfile = {
  id: NarrationVoiceStyle;
  label: string;
  preferredLocale: "en-GB";
  preferredVoiceTraits: readonly string[];
  rate: number;
  pitch: number;
  volume: number;
  deliveryStyle: "friendly" | "reassuring" | "bright";
};

export const VOICE_PROFILES: Record<NarrationVoiceStyle, VoiceProfile> = {
  default: {
    id: "default",
    label: "Scenic Guide",
    preferredLocale: "en-GB",
    preferredVoiceTraits: ["premium", "enhanced", "natural", "neural"],
    rate: 0.98,
    pitch: 1.02,
    volume: 1,
    deliveryStyle: "friendly",
  },
  calm: {
    id: "calm",
    label: "Calm",
    preferredLocale: "en-GB",
    preferredVoiceTraits: ["calm", "serene", "soft", "natural"],
    rate: 0.86,
    pitch: 0.92,
    volume: 0.88,
    deliveryStyle: "reassuring",
  },
  warm: {
    id: "warm",
    label: "Warm",
    preferredLocale: "en-GB",
    preferredVoiceTraits: ["warm", "friendly", "premium", "enhanced", "natural"],
    rate: 1.06,
    pitch: 1.08,
    volume: 1,
    deliveryStyle: "bright",
  },
};

export type NarrationPreferences = {
  mode: NarrationMode;
  voice: NarrationVoiceStyle;
  volume: number;
};

export const DEFAULT_NARRATION_PREFERENCES: NarrationPreferences = {
  mode: "highlights",
  voice: "default",
  volume: 1,
};

export const NARRATION_STORAGE_KEY = "scenik.journeyNarration.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function loadNarrationPreferences(storage?: StorageLike | null): NarrationPreferences {
  if (!storage) return DEFAULT_NARRATION_PREFERENCES;
  try {
    const parsed = JSON.parse(
      storage.getItem(NARRATION_STORAGE_KEY) ?? "null",
    ) as Partial<NarrationPreferences> | null;
    return {
      mode: parsed?.mode === "off" || parsed?.mode === "full" ? parsed.mode : "highlights",
      voice: parsed?.voice === "calm" || parsed?.voice === "warm" ? parsed.voice : "default",
      volume:
        typeof parsed?.volume === "number" && Number.isFinite(parsed.volume)
          ? Math.max(0, Math.min(1, parsed.volume))
          : 1,
    };
  } catch {
    return DEFAULT_NARRATION_PREFERENCES;
  }
}

export function saveNarrationPreferences(
  preferences: NarrationPreferences,
  storage?: StorageLike | null,
) {
  storage?.setItem(NARRATION_STORAGE_KEY, JSON.stringify(preferences));
}

export type NarrationEvent = {
  identity?: string;
  name?: string;
  atSeconds: number;
  triggerAtSeconds?: number;
  staleAfterSeconds?: number;
  text: string;
  priority?: number;
  hasBeenSpoken?: boolean;
};

export type NarrationDecision = {
  event: NarrationEvent | null;
  eventId: string | null;
  skippedEventIds: string[];
  reason: "ready" | "off" | "blocked" | "cadence" | "none";
};

const eventId = (event: NarrationEvent, index: number) => event.identity || `event-${index}`;

export function selectNarrationEvent(input: {
  events: NarrationEvent[];
  elapsedSeconds: number;
  mode: NarrationMode;
  spokenEventIds: ReadonlySet<string>;
  lastNarrationAtSeconds: number | null;
  manoeuvreImminent: boolean;
  navigationSpeaking: boolean;
  rerouting: boolean;
  navigationCertain: boolean;
}): NarrationDecision {
  if (input.mode === "off")
    return { event: null, eventId: null, skippedEventIds: [], reason: "off" };

  const skippedEventIds: string[] = [];
  const available = input.events.flatMap((event, index) => {
    const id = eventId(event, index);
    if (event.hasBeenSpoken || input.spokenEventIds.has(id)) return [];
    const staleAfter = event.staleAfterSeconds ?? event.atSeconds + 120;
    if (input.elapsedSeconds > staleAfter) {
      skippedEventIds.push(id);
      return [];
    }
    const triggerAt = event.triggerAtSeconds ?? Math.max(0, event.atSeconds - 60);
    return input.elapsedSeconds >= triggerAt ? [{ event, id, index }] : [];
  });

  if (
    input.manoeuvreImminent ||
    input.navigationSpeaking ||
    input.rerouting ||
    !input.navigationCertain
  ) {
    return { event: null, eventId: null, skippedEventIds, reason: "blocked" };
  }

  const minimumCadenceSeconds = input.mode === "highlights" ? 10 * 60 : 4 * 60;
  if (
    input.lastNarrationAtSeconds != null &&
    input.elapsedSeconds - input.lastNarrationAtSeconds < minimumCadenceSeconds
  ) {
    return { event: null, eventId: null, skippedEventIds, reason: "cadence" };
  }

  const next = available.sort(
    (a, b) =>
      (b.event.priority ?? 0) - (a.event.priority ?? 0) ||
      a.event.atSeconds - b.event.atSeconds ||
      a.index - b.index,
  )[0];
  return next
    ? { event: next.event, eventId: next.id, skippedEventIds, reason: "ready" }
    : { event: null, eventId: null, skippedEventIds, reason: "none" };
}

export type SpeechVoiceLike = {
  name: string;
  lang: string;
  default?: boolean;
  localService?: boolean;
};

export function selectSpeechVoice<T extends SpeechVoiceLike>(
  voices: T[],
  _locale: string,
  style: NarrationVoiceStyle,
): T | null {
  if (voices.length === 0) return null;
  const profile = VOICE_PROFILES[style];
  const stable = (candidates: T[]) =>
    [...candidates].sort(
      (a, b) =>
        Number(Boolean(b.localService)) - Number(Boolean(a.localService)) ||
        Number(Boolean(b.default)) - Number(Boolean(a.default)) ||
        a.name.localeCompare(b.name),
    )[0] ?? null;
  const isEnglish = (voice: T) => voice.lang.toLowerCase().startsWith("en");
  const isBritishEnglish = (voice: T) => voice.lang.toLowerCase() === "en-gb";
  const hasPreferredTrait = (voice: T) => {
    const name = voice.name.toLowerCase();
    return profile.preferredVoiceTraits.some((trait) => name.includes(trait));
  };

  return (
    stable(voices.filter((voice) => isBritishEnglish(voice) && hasPreferredTrait(voice))) ??
    stable(voices.filter(isBritishEnglish)) ??
    stable(voices.filter(isEnglish)) ??
    stable(voices.filter((voice) => voice.default)) ??
    stable(voices)
  );
}

export function speechTuning(style: NarrationVoiceStyle) {
  const profile = VOICE_PROFILES[style];
  return { rate: profile.rate, pitch: profile.pitch, volume: profile.volume };
}
