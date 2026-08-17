import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NARRATION_PREFERENCES,
  loadNarrationPreferences,
  selectNarrationEvent,
  selectSpeechVoice,
  speechTuning,
} from "./scenic-narration";

const event = { identity: "palace", atSeconds: 900, text: "Approaching Palace." };
const base = {
  events: [event],
  elapsedSeconds: 850,
  mode: "highlights" as const,
  spokenEventIds: new Set<string>(),
  lastNarrationAtSeconds: null,
  manoeuvreImminent: false,
  navigationSpeaking: false,
  rerouting: false,
  navigationCertain: true,
};

describe("selectNarrationEvent", () => {
  test("defers narration for an imminent turn or active navigation speech", () => {
    expect(selectNarrationEvent({ ...base, manoeuvreImminent: true }).reason).toBe("blocked");
    expect(selectNarrationEvent({ ...base, navigationSpeaking: true }).reason).toBe("blocked");
  });

  test("never repeats a spoken event", () => {
    expect(selectNarrationEvent({ ...base, spokenEventIds: new Set(["palace"]) }).event).toBeNull();
  });

  test("marks stale events for skipping instead of creating a backlog", () => {
    const decision = selectNarrationEvent({ ...base, elapsedSeconds: 1_100 });
    expect(decision.event).toBeNull();
    expect(decision.skippedEventIds).toEqual(["palace"]);
  });

  test("Off mode never narrates discoveries", () => {
    expect(selectNarrationEvent({ ...base, mode: "off" }).reason).toBe("off");
  });

  test("Highlights mode enforces a ten-minute cadence", () => {
    expect(
      selectNarrationEvent({ ...base, lastNarrationAtSeconds: 400, elapsedSeconds: 850 }).reason,
    ).toBe("cadence");
  });

  test("fresh state after a route reset can narrate the event again", () => {
    expect(selectNarrationEvent(base).eventId).toBe("palace");
  });
});

describe("voice and settings fallbacks", () => {
  test("prefers a matching high-quality local voice without requiring a fixed name", () => {
    const chosen = selectSpeechVoice(
      [
        { name: "Basic", lang: "en-US", default: true },
        { name: "Enhanced Local", lang: "en-GB", localService: true },
        { name: "Premium French", lang: "fr-FR", localService: true },
      ],
      "en-GB",
      "default",
    );
    expect(chosen?.name).toBe("Enhanced Local");
  });

  test("uses safe defaults for missing or malformed stored preferences", () => {
    expect(loadNarrationPreferences(null)).toEqual(DEFAULT_NARRATION_PREFERENCES);
    expect(loadNarrationPreferences({ getItem: () => "bad json", setItem: () => {} })).toEqual(
      DEFAULT_NARRATION_PREFERENCES,
    );
  });

  test("restores every valid stored profile and rejects an invalid profile", () => {
    const storage = (voice: string) => ({
      getItem: () => JSON.stringify({ mode: "highlights", voice, volume: 0.7 }),
      setItem: () => {},
    });
    expect(loadNarrationPreferences(storage("calm")).voice).toBe("calm");
    expect(loadNarrationPreferences(storage("warm")).voice).toBe("warm");
    expect(loadNarrationPreferences(storage("robot")).voice).toBe("default");
  });

  test("all profiles expose audibly distinct tuning", () => {
    expect(
      new Set(["default", "calm", "warm"].map((id) => JSON.stringify(speechTuning(id as never))))
        .size,
    ).toBe(3);
  });

  test("falls back from British English to English, then device default", () => {
    const american = { name: "US Local", lang: "en-US", localService: true };
    expect(
      selectSpeechVoice(
        [american, { name: "French", lang: "fr-FR", default: true }],
        "en-GB",
        "default",
      ),
    ).toBe(american);
    const deviceDefault = { name: "Device", lang: "fr-FR", default: true };
    expect(selectSpeechVoice([deviceDefault], "en-GB", "default")).toBe(deviceDefault);
  });

  test("uses distinct approved British voices for profiles when available", () => {
    const voices = [
      { name: "Martha", lang: "en-GB", localService: true },
      { name: "Daniel (Enhanced)", lang: "en-GB", localService: true },
      { name: "Serena", lang: "en-GB", localService: true },
    ];
    expect(selectSpeechVoice(voices, "en-GB", "default")?.name).toBe("Serena");
    expect(selectSpeechVoice(voices, "en-GB", "calm")?.name).toBe("Daniel (Enhanced)");
    expect(selectSpeechVoice(voices, "en-GB", "warm")?.name).toBe("Martha");
  });

  test("selects deterministically when voice inventory order changes", () => {
    const voices = [
      { name: "Martha", lang: "en-GB", localService: true },
      { name: "Daniel", lang: "en-GB", localService: true },
      { name: "Serena", lang: "en-GB", localService: true },
    ];
    for (const profile of ["default", "calm", "warm"] as const) {
      expect(selectSpeechVoice(voices, "en-GB", profile)?.name).toBe(
        selectSpeechVoice([...voices].reverse(), "en-GB", profile)?.name,
      );
    }
  });

  test("uses normalized voice URI as the final duplicate-metadata tie-breaker", () => {
    const first = {
      name: "Daniel",
      lang: "en-GB",
      localService: true,
      default: false,
      voiceURI: "  com.example.voice-b  ",
    };
    const second = {
      name: "Daniel",
      lang: "en-GB",
      localService: true,
      default: false,
      voiceURI: "com.example.voice-a",
    };

    expect(selectSpeechVoice([first, second], "en-GB", "calm")?.voiceURI?.trim()).toBe(
      "com.example.voice-a",
    );
    expect(selectSpeechVoice([second, first], "en-GB", "calm")?.voiceURI?.trim()).toBe(
      "com.example.voice-a",
    );
  });

  test("handles missing and exactly equivalent voice URIs without array-position identity", () => {
    const withoutUri = { name: "Daniel", lang: "en-GB", localService: true, default: false };
    const withUri = { ...withoutUri, voiceURI: "com.example.daniel" };
    expect(selectSpeechVoice([withUri, withoutUri], "en-GB", "calm")).toBe(withoutUri);
    expect(selectSpeechVoice([withoutUri, withUri], "en-GB", "calm")).toBe(withoutUri);

    const equivalentA = { ...withoutUri, voiceURI: "com.example.same" };
    const equivalentB = { ...withoutUri, voiceURI: "com.example.same" };
    expect(selectSpeechVoice([equivalentA, equivalentB], "en-GB", "calm")).toEqual(
      selectSpeechVoice([equivalentB, equivalentA], "en-GB", "calm"),
    );
  });

  test("uses one suitable British or English voice safely for every profile", () => {
    const british = { name: "Daniel", lang: "en-GB", localService: true };
    const english = { name: "Samantha", lang: "en-US", localService: true };
    for (const profile of ["default", "calm", "warm"] as const) {
      expect(selectSpeechVoice([british], "en-GB", profile)).toBe(british);
      expect(selectSpeechVoice([english], "en-GB", profile)).toBe(english);
    }
  });

  test("falls back to a safe non-English device voice", () => {
    const french = { name: "Thomas", lang: "fr-FR", default: true };
    expect(selectSpeechVoice([french], "en-GB", "default")).toBe(french);
  });

  test("never lets a novelty voice beat an ordinary fallback", () => {
    const ordinary = { name: "British Voice", lang: "en-GB" };
    const novelty = { name: "Whisper", lang: "en-GB", default: true, localService: true };
    expect(selectSpeechVoice([novelty, ordinary], "en-GB", "calm")).toBe(ordinary);
    expect(selectSpeechVoice([novelty], "en-GB", "warm")).toBeNull();
  });
});
