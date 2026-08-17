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
});
