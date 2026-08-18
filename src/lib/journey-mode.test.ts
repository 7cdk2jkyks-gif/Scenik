import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectZeroAllowanceJourneyEvidence,
  journeyAllowancePresentation,
  journeyCtaLabel,
  journeyGenerationPath,
  journeyMode,
  journeyRequestIdentity,
  JourneyRequestPublicationCoordinator,
  LatestJourneyRequestOwnership,
  meaningfullySpacedJourneySearchCentres,
  normalizeJourneyExtraMinutes,
  normalizeJourneyPreferences,
  normalizeJourneySelection,
  OwnedJourneyAnimationFrame,
} from "./journey-mode";
import { corridorSampleCount, routeCorridorSamples } from "./scenic-waypoint";

describe("journey mode", () => {
  it("implements the complete fastest/scenic truth table", () => {
    assert.equal(journeyMode({ mood: null, theme: undefined, extraMinutes: 0 }), "fastest");
    assert.equal(journeyMode({ mood: "", theme: "", extraMinutes: 30 }), "scenic");
    assert.equal(journeyMode({ mood: "Peaceful", theme: "", extraMinutes: 0 }), "scenic");
    assert.equal(journeyMode({ mood: "", theme: "Coastal", extraMinutes: 0 }), "scenic");
    assert.equal(journeyMode({ mood: "Peaceful", theme: "Coastal", extraMinutes: 0 }), "scenic");
    assert.equal(journeyMode({ mood: "Peaceful", theme: "Coastal", extraMinutes: 30 }), "scenic");
  });

  it("normalises neutral, restored and malformed values safely", () => {
    for (const value of [undefined, null, "", "  ", "None", "neutral", "DEFAULT", "Any", "Open"])
      assert.equal(normalizeJourneySelection(value), "");
    assert.equal(normalizeJourneySelection("  Romantic  "), "Romantic");

    for (const value of [undefined, null, "", "  ", 0, "0", -30, "-30", "invalid", 1.5])
      assert.equal(normalizeJourneyExtraMinutes(value), 0);
    assert.equal(normalizeJourneyExtraMinutes("30"), 30);
    assert.equal(normalizeJourneyExtraMinutes(80), 80);
    assert.equal(normalizeJourneyExtraMinutes("300"), 240);
  });

  it("updates the Production-used CTA for allowance-only state transitions", () => {
    assert.equal(
      journeyCtaLabel({ mood: "", theme: "", extraMinutes: 0 }),
      "Take the fastest route",
    );
    assert.equal(journeyCtaLabel({ mood: "", theme: "", extraMinutes: 30 }), "Plan my drive");
    assert.equal(
      journeyCtaLabel({ mood: "", theme: "", extraMinutes: 0 }),
      "Take the fastest route",
    );
    assert.equal(
      journeyCtaLabel({ mood: "Peaceful", theme: "", extraMinutes: 0 }),
      "Plan my drive",
    );
  });

  it("gives fastest and neutral-scenic requests distinct stable identities", () => {
    const fastest = journeyRequestIdentity({ mood: "", theme: "", extraMinutes: 0 });
    const thirty = journeyRequestIdentity({ mood: "", theme: "", extraMinutes: "30" });
    const eighty = journeyRequestIdentity({ mood: "", theme: "", extraMinutes: 80 });
    assert.notEqual(fastest, thirty);
    assert.notEqual(thirty, eighty);
    assert.equal(thirty, journeyRequestIdentity({ mood: "  ", theme: null, extraMinutes: 30 }));
  });

  it("serializes a restored positive allowance without inventing preferences", () => {
    assert.deepEqual(normalizeJourneyPreferences({ mood: " ", theme: null, extraMinutes: "30" }), {
      mood: "",
      theme: "",
      extraMinutes: 30,
    });
  });

  it("drives the Production server branch for fastest, zero-allowance and explored journeys", () => {
    assert.equal(journeyGenerationPath({ mood: "", theme: "", extraMinutes: 0 }), "fastest");
    assert.equal(
      journeyGenerationPath({ mood: "Peaceful", theme: "", extraMinutes: 0 }),
      "zero-allowance-personalised",
    );
    assert.equal(
      journeyGenerationPath({ mood: "", theme: "Coastal", extraMinutes: 0 }),
      "zero-allowance-personalised",
    );
    assert.equal(
      journeyGenerationPath({ mood: "", theme: "", extraMinutes: 30 }),
      "scenic-exploration",
    );
    assert.equal(
      journeyGenerationPath({ mood: "Peaceful", theme: "Coastal", extraMinutes: 30 }),
      "scenic-exploration",
    );
  });

  it("fingerprints the complete ordered Production submission", () => {
    const base = {
      origin: "  Oxford   Station ",
      destination: "Glasgow Central",
      stops: ["Birmingham", "Manchester"],
      mood: " Peaceful ",
      theme: "Coastal",
      extraMinutes: "30",
    };
    const identity = journeyRequestIdentity(base);
    assert.equal(identity, journeyRequestIdentity({ ...base, origin: "Oxford Station" }));
    assert.notEqual(identity, journeyRequestIdentity({ ...base, origin: "Cambridge" }));
    assert.notEqual(identity, journeyRequestIdentity({ ...base, destination: "Edinburgh" }));
    assert.notEqual(identity, journeyRequestIdentity({ ...base, stops: ["Birmingham"] }));
    assert.notEqual(
      identity,
      journeyRequestIdentity({ ...base, stops: [...base.stops].reverse() }),
    );
    assert.notEqual(identity, journeyRequestIdentity({ ...base, mood: "Romantic" }));
    assert.notEqual(identity, journeyRequestIdentity({ ...base, theme: "Historic" }));
    assert.notEqual(identity, journeyRequestIdentity({ ...base, extraMinutes: 80 }));
  });

  it("allows only the latest request instance to publish success, errors and settled state", () => {
    const ownership = new LatestJourneyRequestOwnership();
    const fingerprint = journeyRequestIdentity({
      origin: "Oxford",
      destination: "Glasgow",
      stops: [],
      extraMinutes: 30,
    });
    const older = ownership.begin(fingerprint);
    const newer = ownership.begin(fingerprint);
    const events: string[] = [];
    const publish = (token: typeof older, event: string) => {
      if (ownership.isCurrent(token, fingerprint)) events.push(event);
    };

    publish(older, "old-success");
    publish(older, "old-modal");
    publish(older, "old-analytics");
    publish(older, "old-error");
    publish(older, "old-settled");
    publish(newer, "new-success");
    publish(newer, "new-modal");
    publish(newer, "new-analytics");
    publish(newer, "new-settled");

    assert.deepEqual(events, ["new-success", "new-modal", "new-analytics", "new-settled"]);
  });

  it("invalidates outstanding work on reset and unmount while remaining Strict Mode safe", () => {
    const ownership = new LatestJourneyRequestOwnership();
    const first = ownership.begin("first");
    ownership.invalidate();
    assert.equal(ownership.isCurrent(first), false);

    const second = ownership.begin("second");
    ownership.dispose();
    assert.equal(ownership.isCurrent(second), false);
    ownership.activate();
    const third = ownership.begin("third");
    assert.equal(ownership.isCurrent(third), true);
  });

  it("presents truthful zero-allowance copy and preserves positive utilisation copy", () => {
    const budget = { usedMinutes: 0, allowanceMinutes: 0, explanation: "Fastest route selected." };
    const fastest = journeyAllowancePresentation({ mood: "", theme: "", extraMinutes: 0 }, budget);
    assert.equal(fastest, "Fastest route selected.");

    for (const preferences of [
      { mood: "Peaceful", theme: "" },
      { mood: "", theme: "Coastal" },
      { mood: "Peaceful", theme: "Coastal" },
    ]) {
      const copy = journeyAllowancePresentation({ ...preferences, extraMinutes: 0 }, budget);
      assert.equal(
        copy,
        "We kept you on the fastest route while shaping the journey around your preferences.",
      );
      for (const forbidden of ["0 of your 0", "used 0", "extra minutes", "detour"])
        assert.equal(copy.toLowerCase().includes(forbidden), false);
    }

    assert.equal(
      journeyAllowancePresentation(
        { mood: "Peaceful", theme: "", extraMinutes: 30 },
        { usedMinutes: 18, allowanceMinutes: 30, explanation: "Existing explanation." },
      ),
      "We used 18 of your 30 extra minutes. Existing explanation.",
    );
    assert.equal(
      journeyAllowancePresentation(
        { mood: undefined, theme: undefined, extraMinutes: undefined },
        budget,
      ),
      "Fastest route selected.",
    );
    assert.equal(
      journeyAllowancePresentation(
        { mood: "Open", theme: "Direct route", extraMinutes: 0 },
        budget,
      ),
      "Fastest route selected.",
    );
  });

  it("deduplicates substantially overlapping search areas in chronological order", () => {
    const veryClose = [
      { lat: 51.5, lng: -0.12 },
      { lat: 51.5, lng: -0.115 },
      { lat: 51.5, lng: -0.11 },
    ];
    assert.deepEqual(meaningfullySpacedJourneySearchCentres(veryClose, 1_000), [veryClose[1]]);

    const separated = [
      { lat: 51.5, lng: -0.12 },
      { lat: 51.5, lng: -0.09 },
      { lat: 51.5, lng: -0.06 },
    ];
    assert.deepEqual(meaningfullySpacedJourneySearchCentres(separated, 1_000), separated);
    assert.deepEqual(
      meaningfullySpacedJourneySearchCentres(
        [separated[0], separated[0], separated[1], separated[1]],
        1_000,
      ),
      [separated[0], separated[1]],
    );
    assert.deepEqual(meaningfullySpacedJourneySearchCentres(separated, 0), []);
  });

  it("uses the Production evidence seam without exceeding tier candidates or 70 places", async () => {
    const centres = Array.from({ length: 7 }, (_, index) => ({
      lat: 51.5,
      lng: -0.2 + index * 0.03,
    }));
    let calls = 0;
    const collect = (candidateCentres: typeof centres) =>
      collectZeroAllowanceJourneyEvidence({
        preferences: { mood: "Peaceful", extraMinutes: 0 },
        candidateCentres,
        radiusMeters: 1_000,
        search: async () => {
          calls += 1;
          return Array.from({ length: 20 }, (_, index) => ({ id: `${calls}-${index}` }));
        },
      });

    assert.equal((await collect(centres.slice(0, 3))).callCount, 3);
    assert.equal((await collect(centres.slice(0, 5))).callCount, 5);
    const long = await collect(centres);
    assert.equal(long.callCount, 7);
    assert.equal(long.places.length, 70);
  });

  it("applies authoritative distance tiers before geographically spacing provider calls", async () => {
    const origin = { lat: 0, lng: 0 };
    const cases = [
      { distanceMeters: 1_000, destination: { lat: 0, lng: 0.009 }, maximum: 3, calls: 1 },
      { distanceMeters: 49_999, destination: { lat: 0, lng: 0.45 }, maximum: 3, calls: 3 },
      { distanceMeters: 50_000, destination: { lat: 0, lng: 0.9 }, maximum: 5, calls: 5 },
      { distanceMeters: 149_999, destination: { lat: 0, lng: 1.35 }, maximum: 5, calls: 5 },
      { distanceMeters: 150_000, destination: { lat: 0, lng: 1.8 }, maximum: 7, calls: 7 },
    ];
    for (const routeCase of cases) {
      const tier = corridorSampleCount(routeCase.distanceMeters);
      assert.equal(tier, routeCase.maximum);
      const candidateCentres = routeCorridorSamples(origin, routeCase.destination, [], tier);
      let calls = 0;
      const result = await collectZeroAllowanceJourneyEvidence({
        preferences: { mood: "Peaceful", extraMinutes: 0 },
        candidateCentres,
        radiusMeters: 1_000,
        search: async () => {
          calls += 1;
          return [];
        },
      });
      assert.equal(result.callCount, routeCase.calls);
      assert.equal(calls, routeCase.calls);
      assert.equal(result.callCount <= routeCase.maximum, true);
    }
  });

  it("makes no evidence call for fastest or positive scenic paths", async () => {
    let calls = 0;
    const search = async () => {
      calls += 1;
      return [{ id: "place" }];
    };
    for (const preferences of [
      { mood: "", theme: "", extraMinutes: 0 },
      { mood: "Peaceful", theme: "", extraMinutes: 30 },
    ]) {
      const result = await collectZeroAllowanceJourneyEvidence({
        preferences,
        candidateCentres: [{ lat: 51.5, lng: -0.1 }],
        radiusMeters: 1_000,
        search,
      });
      assert.equal(result.callCount, 0);
      assert.deepEqual(result.places, []);
    }
    assert.equal(calls, 0);
  });

  it("contains Places failures and retains fulfilled evidence", async () => {
    let calls = 0;
    const result = await collectZeroAllowanceJourneyEvidence({
      preferences: { theme: "Historic", extraMinutes: 0 },
      candidateCentres: [
        { lat: 51.5, lng: -0.12 },
        { lat: 51.5, lng: -0.09 },
      ],
      radiusMeters: 1_000,
      search: async () => {
        calls += 1;
        if (calls === 1) throw new Error("provider rejected");
        return [{ id: "verified" }];
      },
    });
    assert.equal(result.callCount, 2);
    assert.deepEqual(result.places, [{ id: "verified" }]);
  });

  it("contains complete Places failure without evidence, retries or an escaped rejection", async () => {
    let calls = 0;
    const result = await collectZeroAllowanceJourneyEvidence({
      preferences: { mood: "Peaceful", extraMinutes: 0 },
      candidateCentres: [
        { lat: 51.5, lng: -0.12 },
        { lat: 51.5, lng: -0.09 },
        { lat: 51.5, lng: -0.06 },
      ],
      radiusMeters: 1_000,
      search: async () => {
        calls += 1;
        throw new Error("provider-specific failure");
      },
    });
    assert.equal(calls, 3);
    assert.equal(result.callCount, 3);
    assert.deepEqual(result.places, []);
  });

  it("rejects invalid candidate centres before invoking Places", async () => {
    let calls = 0;
    const result = await collectZeroAllowanceJourneyEvidence({
      preferences: { theme: "Historic", extraMinutes: 0 },
      candidateCentres: [
        { lat: 91, lng: 0 },
        { lat: 0, lng: 181 },
        { lat: Number.NaN, lng: 0 },
        { lat: 51.5, lng: -0.1 },
      ],
      radiusMeters: 1_000,
      search: async () => {
        calls += 1;
        return [];
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(result.centres, [{ lat: 51.5, lng: -0.1 }]);
  });

  it("uses geographic spacing safely beside the antimeridian", () => {
    const centres = [
      { lat: 0, lng: 179.999 },
      { lat: 0, lng: -179.999 },
      { lat: 0, lng: -179.97 },
    ];
    assert.deepEqual(meaningfullySpacedJourneySearchCentres(centres, 1_000), [
      centres[0],
      centres[2],
    ]);
  });

  it("scrolls only while the scheduled animation frame still owns the request", () => {
    const callbacks = new Map<number, () => void>();
    const cancelled = new Set<number>();
    let nextHandle = 0;
    const requestFrame = (callback: () => void) => {
      const handle = ++nextHandle;
      callbacks.set(handle, callback);
      return handle;
    };
    const cancelFrame = (handle: number) => cancelled.add(handle);
    const ownership = new LatestJourneyRequestOwnership();
    const frame = new OwnedJourneyAnimationFrame();
    const effects: string[] = [];
    const schedule = (token: ReturnType<typeof ownership.begin>, effect: string) =>
      frame.schedule({
        ownership,
        token,
        requestFrame,
        cancelFrame,
        effect: () => effects.push(effect),
      });

    const first = ownership.begin("same");
    schedule(first, "first");
    callbacks.get(1)!();
    assert.deepEqual(effects, ["first"]);

    const older = ownership.begin("same");
    schedule(older, "older");
    const newer = ownership.begin("same");
    callbacks.get(2)!();
    assert.deepEqual(effects, ["first"]);
    schedule(newer, "newer");
    callbacks.get(3)!();
    assert.deepEqual(effects, ["first", "newer"]);

    const reset = ownership.begin("reset");
    schedule(reset, "reset");
    frame.cancel();
    ownership.invalidate();
    callbacks.get(4)!();
    assert.equal(cancelled.has(4), true);

    const unmounted = ownership.begin("unmount");
    schedule(unmounted, "unmount");
    frame.cancel();
    ownership.dispose();
    callbacks.get(5)!();
    assert.equal(cancelled.has(5), true);

    ownership.activate();
    const remounted = ownership.begin("remount");
    schedule(remounted, "remount");
    callbacks.get(6)!();
    assert.deepEqual(effects, ["first", "newer", "remount"]);
  });

  it("retains safe scrolling when animation frames are unavailable", () => {
    const ownership = new LatestJourneyRequestOwnership();
    const token = ownership.begin("fallback");
    const effects: string[] = [];
    new OwnedJourneyAnimationFrame().schedule({
      ownership,
      token,
      effect: () => effects.push("fallback"),
    });
    assert.deepEqual(effects, ["fallback"]);
  });

  it("coordinates the named Production Plan publications across completion orderings", () => {
    const callbacks = new Map<number, () => void>();
    let nextHandle = 0;
    const requestFrame = (callback: () => void) => {
      const handle = ++nextHandle;
      callbacks.set(handle, callback);
      return handle;
    };
    const cancelFrame = () => undefined;
    const coordinator = new JourneyRequestPublicationCoordinator();
    const events: string[] = [];
    const success = (
      token: ReturnType<typeof coordinator.begin>,
      label: string,
      withFrame = true,
    ) =>
      coordinator.publishSuccess({
        token,
        publications: {
          publishSuccessState: () => events.push(`${label}:state`),
          publishPresentation: () => events.push(`${label}:presentation`),
          publishDiagnostics: () => events.push(`${label}:diagnostics`),
          openIntroduction: () => events.push(`${label}:introduction`),
          publishAnalytics: () => events.push(`${label}:analytics`),
          scroll: () => events.push(`${label}:scroll`),
        },
        requestFrame: withFrame ? requestFrame : undefined,
        cancelFrame: withFrame ? cancelFrame : undefined,
      });
    const failure = (token: ReturnType<typeof coordinator.begin>, label: string) =>
      coordinator.publishFailure({
        token,
        publications: {
          publishError: () => events.push(`${label}:error`),
          publishToast: () => events.push(`${label}:toast`),
          publishAnalytics: () => events.push(`${label}:failure-analytics`),
        },
      });
    const settled = (token: ReturnType<typeof coordinator.begin>, label: string) =>
      coordinator.publishSettled(token, () => events.push(`${label}:settled`));

    const a1 = coordinator.begin("a1");
    const b1 = coordinator.begin("b1");
    assert.equal(success(a1, "a1"), false);
    assert.equal(settled(a1, "a1"), false);
    assert.equal(success(b1, "b1"), true);
    callbacks.get(1)!();

    const a2 = coordinator.begin("a2");
    const b2 = coordinator.begin("b2");
    assert.equal(success(b2, "b2"), true);
    assert.equal(success(a2, "a2"), false);
    callbacks.get(2)!();

    const a3 = coordinator.begin("a3");
    const b3 = coordinator.begin("b3");
    assert.equal(failure(a3, "a3"), false);
    assert.equal(settled(a3, "a3"), false);
    assert.equal(success(b3, "b3"), true);
    callbacks.get(3)!();

    const a4 = coordinator.begin("a4");
    const b4 = coordinator.begin("b4");
    assert.equal(success(b4, "b4"), true);
    assert.equal(failure(a4, "a4"), false);
    callbacks.get(4)!();

    const identicalA = coordinator.begin("identical");
    const identicalB = coordinator.begin("identical");
    assert.equal(success(identicalB, "identical-b"), true);
    assert.equal(success(identicalA, "identical-a"), false);
    callbacks.get(5)!();

    const reset = coordinator.begin("reset");
    coordinator.reset();
    assert.equal(success(reset, "reset"), false);
    assert.equal(failure(reset, "reset"), false);
    assert.equal(settled(reset, "reset"), false);

    const unmount = coordinator.begin("unmount");
    coordinator.dispose();
    assert.equal(success(unmount, "unmount"), false);
    coordinator.activate();

    const staleFrame = coordinator.begin("stale-frame");
    assert.equal(success(staleFrame, "stale-frame"), true);
    const current = coordinator.begin("current");
    callbacks.get(6)!();
    assert.equal(events.includes("stale-frame:scroll"), false);
    assert.equal(success(current, "current", false), true);
    assert.equal(events.includes("current:scroll"), true);
    assert.equal(settled(current, "current"), true);

    assert.equal(
      events.some((event) => event.startsWith("a1:")),
      false,
    );
    assert.equal(
      events.some((event) => event.startsWith("a2:")),
      false,
    );
    assert.equal(
      events.some((event) => event.startsWith("a3:")),
      false,
    );
    assert.equal(
      events.some((event) => event.startsWith("a4:")),
      false,
    );
    assert.equal(
      events.some((event) => event.startsWith("identical-a:")),
      false,
    );
    assert.equal(events.includes("current:settled"), true);
  });
});
