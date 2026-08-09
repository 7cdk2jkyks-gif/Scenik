import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NARRATION_PREFERENCES,
  loadNarrationPreferences,
  selectNarrationEvent,
  selectSpeechVoice,
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
      "calm",
    );
    expect(chosen?.name).toBe("Enhanced Local");
  });

  test("uses safe defaults for missing or malformed stored preferences", () => {
    expect(loadNarrationPreferences(null)).toEqual(DEFAULT_NARRATION_PREFERENCES);
    expect(loadNarrationPreferences({ getItem: () => "bad json", setItem: () => {} })).toEqual(
      DEFAULT_NARRATION_PREFERENCES,
    );
  });
});
