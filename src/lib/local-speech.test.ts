import { describe, expect, test } from "bun:test";
import {
  activateNavigationLifecycle,
  acceptCurrentNavigationAlternate,
  applyNavigationLifecycleTransition,
  applyNavigationReplacementTransition,
  applyTerminalNavigationTransition,
  awaitCurrentNavigationRouteReplacement,
  awaitCoordinatedNavigationRouteReplacement,
  awaitNavigationRouteReplacement,
  beginNavigationSession,
  beginCoordinatedNavigationReplacement,
  beginNavigationAlternateCalculation,
  clearNavigationAlternateForCalculation,
  captureNavigationSession,
  captureNavigationReplacement,
  completeCurrentNavigationSession,
  completeNavigationLifecycle,
  createBrowserSpeechBoundary,
  createLocalSpeechBoundary,
  createNavigationAsyncCoordinator,
  createNavigationSessionGuard,
  deactivateNavigationAsyncLifecycle,
  deactivateNavigationLifecycle,
  finishCoordinatedNavigationReplacement,
  finishNavigationAlternateCalculation,
  invalidateNavigationSession,
  isCurrentNavigationSession,
  isLatestNavigationReplacement,
  navigationSessionCanSpeak,
  publishNavigationAlternate,
  consumeCurrentNavigationAlternate,
  shutdownNavigationSpeech,
  speakDuringActiveNavigation,
} from "./local-speech";

type FakeUtterance = SpeechSynthesisUtterance & { text: string };

function setup(initialVoices: SpeechSynthesisVoice[] = []) {
  let voices = initialVoices;
  let listener: (() => void) | null = null;
  let fail = false;
  const spoken: FakeUtterance[] = [];
  const pending: FakeUtterance[] = [];
  let cancelCount = 0;
  const synthesis = {
    speaking: false,
    paused: false,
    getVoices: () => voices,
    speak: (utterance: SpeechSynthesisUtterance) => {
      if (fail) throw new Error("speech unavailable");
      spoken.push(utterance as FakeUtterance);
      pending.push(utterance as FakeUtterance);
      synthesis.speaking = true;
      utterance.onstart?.(new Event("start") as SpeechSynthesisEvent);
    },
    cancel: () => {
      cancelCount += 1;
      pending.length = 0;
      synthesis.speaking = false;
    },
    resume: () => {
      synthesis.paused = false;
    },
    addEventListener: (_type: "voiceschanged", next: () => void) => {
      listener = next;
    },
    removeEventListener: () => {
      listener = null;
    },
  };
  const boundary = createLocalSpeechBoundary({
    synthesis,
    locale: "en-GB",
    createUtterance: (text) =>
      ({
        text,
        voice: null,
        lang: "",
        rate: 1,
        pitch: 1,
        volume: 1,
        onstart: null,
        onend: null,
        onerror: null,
      }) as FakeUtterance,
  });
  return {
    boundary,
    spoken,
    pending,
    synthesis,
    setVoices(next: SpeechSynthesisVoice[]) {
      voices = next;
      listener?.();
    },
    setFail(next: boolean) {
      fail = next;
    },
    cancelCount: () => cancelCount,
    hasVoiceListener: () => listener != null,
  };
}

function installBrowserSpeechMocks() {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalUtterance = Object.getOwnPropertyDescriptor(globalThis, "SpeechSynthesisUtterance");
  const documentListeners = new Map<string, Set<() => void>>();
  const windowListeners = new Map<string, Set<() => void>>();
  let visibilityState: "visible" | "hidden" = "visible";
  let cancelCount = 0;
  const spoken: SpeechSynthesisUtterance[] = [];
  const synthesis = {
    speaking: false,
    paused: false,
    getVoices: () => [] as SpeechSynthesisVoice[],
    speak: (utterance: SpeechSynthesisUtterance) => {
      spoken.push(utterance);
      synthesis.speaking = true;
    },
    cancel: () => {
      cancelCount += 1;
      synthesis.speaking = false;
    },
    resume: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  class FakeBrowserUtterance {
    voice: SpeechSynthesisVoice | null = null;
    lang = "";
    rate = 1;
    pitch = 1;
    volume = 1;
    onstart: ((event: SpeechSynthesisEvent) => void) | null = null;
    onend: ((event: SpeechSynthesisEvent) => void) | null = null;
    onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;
    constructor(public text: string) {}
  }
  const add = (store: Map<string, Set<() => void>>, type: string, listener: () => void) => {
    const listeners = store.get(type) ?? new Set();
    listeners.add(listener);
    store.set(type, listeners);
  };
  const remove = (store: Map<string, Set<() => void>>, type: string, listener: () => void) => {
    store.get(type)?.delete(listener);
  };
  Object.defineProperties(globalThis, {
    window: {
      configurable: true,
      value: {
        speechSynthesis: synthesis,
        addEventListener: (type: string, listener: () => void) =>
          add(windowListeners, type, listener),
        removeEventListener: (type: string, listener: () => void) =>
          remove(windowListeners, type, listener),
      },
    },
    document: {
      configurable: true,
      value: {
        get visibilityState() {
          return visibilityState;
        },
        addEventListener: (type: string, listener: () => void) =>
          add(documentListeners, type, listener),
        removeEventListener: (type: string, listener: () => void) =>
          remove(documentListeners, type, listener),
      },
    },
    navigator: { configurable: true, value: { language: "en-GB" } },
    SpeechSynthesisUtterance: { configurable: true, value: FakeBrowserUtterance },
  });
  return {
    spoken,
    cancelCount: () => cancelCount,
    listenerCount: (scope: "window" | "document", type: string) =>
      (scope === "window" ? windowListeners : documentListeners).get(type)?.size ?? 0,
    dispatch: (scope: "window" | "document", type: string) =>
      [...((scope === "window" ? windowListeners : documentListeners).get(type) ?? [])].forEach(
        (listener) => listener(),
      ),
    setVisibility: (value: "visible" | "hidden") => {
      visibilityState = value;
    },
    restore() {
      for (const [name, descriptor] of [
        ["window", originalWindow],
        ["document", originalDocument],
        ["navigator", originalNavigator],
        ["SpeechSynthesisUtterance", originalUtterance],
      ] as const) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
    },
  };
}

const voice = (name: string, lang: string, extra = {}) =>
  ({ name, lang, voiceURI: name, ...extra }) as SpeechSynthesisVoice;

describe("local speech boundary", () => {
  test("uses distinct Production parameters for all three profiles", () => {
    const state = setup([voice("Enhanced British", "en-GB", { localService: true })]);
    for (const profile of ["default", "calm", "warm"] as const) {
      state.synthesis.speaking = false;
      state.boundary.speak({ text: "Preview", kind: "preview", profile });
    }
    expect(state.spoken.map(({ rate, pitch, volume }) => [rate, pitch, volume])).toEqual([
      [0.98, 1.02, 1],
      [0.86, 0.92, 0.88],
      [1.06, 1.08, 1],
    ]);
  });

  test("refreshes an initially empty voice list when voiceschanged fires", () => {
    const state = setup();
    const enhanced = voice("Premium British", "en-GB", { localService: true });
    expect(state.boundary.selectedVoice("default")).toBeNull();
    state.setVoices([enhanced]);
    expect(state.boundary.selectedVoice("default")).toBe(enhanced);
  });

  test("preview cancellation and navigation interruption share one boundary", () => {
    const state = setup();
    state.boundary.speak({ text: "Preview", kind: "preview", profile: "default" });
    state.boundary.speak({ text: "Turn left", kind: "navigation", profile: "calm" });
    expect(state.cancelCount()).toBe(1);
    expect(state.boundary.isSpeaking("navigation")).toBe(true);
  });

  test("navigation shutdown cancels exactly once and leaves no queued utterance", () => {
    const state = setup();
    state.boundary.speak({ text: "Turn left", kind: "navigation", profile: "default" });
    state.boundary.cancel();
    expect(state.cancelCount()).toBe(1);
    expect(state.pending).toHaveLength(0);
    expect(state.boundary.isSpeaking()).toBe(false);
  });

  test("every Production navigation-ending reason uses one idempotent shutdown", () => {
    for (const reason of ["closed", "completed", "cleared", "replaced"] as const) {
      const state = setup();
      state.boundary.speak({ text: "Turn left", kind: "navigation", profile: "default" });
      shutdownNavigationSpeech(state.boundary, reason);
      expect(state.cancelCount()).toBe(1);
      expect(state.pending).toHaveLength(0);
      expect(state.boundary.isSpeaking()).toBe(false);
    }
  });

  test("does not overlap discovery narration or produce a backlog", () => {
    const state = setup();
    expect(state.boundary.speak({ text: "Discovery", kind: "narration", profile: "default" })).toBe(
      true,
    );
    expect(state.boundary.speak({ text: "Another", kind: "narration", profile: "default" })).toBe(
      false,
    );
  });

  test("muted speech never creates an utterance", () => {
    const state = setup();
    expect(
      state.boundary.speak({
        text: "Turn left",
        kind: "navigation",
        profile: "default",
        muted: true,
      }),
    ).toBe(false);
    expect(state.spoken).toHaveLength(0);
  });

  test("speech failure is silent and cleanup cancels speech and removes listeners", () => {
    const state = setup();
    state.setFail(true);
    expect(state.boundary.speak({ text: "Unavailable", kind: "preview", profile: "default" })).toBe(
      false,
    );
    state.boundary.dispose();
    expect(state.hasVoiceListener()).toBe(false);
    expect(state.cancelCount()).toBeGreaterThan(0);
  });

  test("uses only Scenik-owned state when the browser speaking flag is stuck", () => {
    const state = setup();
    state.synthesis.speaking = true;
    expect(state.boundary.isSpeaking()).toBe(false);
    expect(state.boundary.speak({ text: "Discovery", kind: "narration", profile: "default" })).toBe(
      true,
    );
    expect(state.boundary.isSpeaking("narration")).toBe(true);
    expect(state.boundary.speak({ text: "Another", kind: "narration", profile: "default" })).toBe(
      false,
    );
  });

  test("ignores delayed same-kind completion from a cancelled utterance", () => {
    const state = setup();
    state.boundary.speak({ text: "Turn left", kind: "navigation", profile: "default" });
    const first = state.spoken[0];
    state.boundary.cancel();
    state.boundary.speak({ text: "Turn right", kind: "navigation", profile: "default" });
    const second = state.spoken[1];
    first.onend?.(new Event("end") as SpeechSynthesisEvent);
    expect(state.boundary.isSpeaking("navigation")).toBe(true);
    second.onend?.(new Event("end") as SpeechSynthesisEvent);
    expect(state.boundary.isSpeaking()).toBe(false);
  });

  test("ignores delayed errors after narration pre-emption", () => {
    const state = setup();
    state.boundary.speak({ text: "A view", kind: "narration", profile: "default" });
    const narration = state.spoken[0];
    state.boundary.speak({ text: "Turn left", kind: "navigation", profile: "default" });
    narration.onerror?.(new Event("error") as SpeechSynthesisErrorEvent);
    expect(state.boundary.isSpeaking("navigation")).toBe(true);
  });

  test("dispose invalidates delayed completion and error callbacks", () => {
    const state = setup();
    state.boundary.speak({ text: "Preview", kind: "preview", profile: "default" });
    const utterance = state.spoken[0];
    state.boundary.dispose();
    utterance.onend?.(new Event("end") as SpeechSynthesisEvent);
    utterance.onerror?.(new Event("error") as SpeechSynthesisErrorEvent);
    expect(state.boundary.isSpeaking()).toBe(false);
    expect(state.boundary.speak({ text: "Again", kind: "preview", profile: "default" })).toBe(
      false,
    );
  });

  test("preview replacement ignores the old preview callback", () => {
    const state = setup();
    state.boundary.speak({ text: "Preview A", kind: "preview", profile: "default" });
    const first = state.spoken[0];
    state.boundary.speak({ text: "Preview B", kind: "preview", profile: "default" });
    first.onend?.(new Event("end") as SpeechSynthesisEvent);
    expect(state.boundary.isSpeaking("preview")).toBe(true);
  });

  test("Production navigation-ending actions cancel before clearing navigation state", () => {
    for (const action of [
      "end",
      "go-back",
      "dialog-close",
      "done",
      "start-over",
      "clear-route",
      "new-plan",
    ]) {
      const state = setup();
      const order: string[] = [];
      state.boundary.speak({ text: "Turn left", kind: "navigation", profile: "default" });
      const originalCancel = state.boundary.cancel;
      state.boundary.cancel = () => {
        order.push("cancel");
        originalCancel();
      };
      applyNavigationLifecycleTransition(
        state.boundary,
        action === "dialog-close" ? "closed" : "cleared",
        () => {
          order.push("clear-navigation");
        },
      );
      expect(order, action).toEqual(["cancel", "clear-navigation"]);
    }
  });

  test("only an active-navigation dialog close shuts speech down", () => {
    const state = setup();
    let navigationOpen = true;
    let presentationOpen = true;
    applyNavigationLifecycleTransition(state.boundary, "continue", () => {
      presentationOpen = false;
    });
    expect(state.cancelCount()).toBe(0);
    expect(navigationOpen).toBe(true);
    expect(presentationOpen).toBe(false);

    applyNavigationLifecycleTransition(state.boundary, "closed", () => {
      navigationOpen = false;
    });
    expect(state.cancelCount()).toBe(1);
    expect(navigationOpen).toBe(false);
  });

  test("Production completion transition cancels exactly once and cannot speak after completion", () => {
    const state = setup();
    let completed = false;
    let completionUiCount = 0;
    state.boundary.speak({ text: "Turn left", kind: "navigation", profile: "default" });
    const complete = () =>
      completeNavigationLifecycle(state.boundary, completed, () => {
        completed = true;
        completionUiCount += 1;
      });

    expect(complete()).toBe(true);
    expect(complete()).toBe(false);
    expect(completed).toBe(true);
    expect(completionUiCount).toBe(1);
    expect(state.cancelCount()).toBe(1);
    expect(
      speakDuringActiveNavigation(state.boundary, completed, {
        text: "Late instruction",
        kind: "navigation",
        profile: "default",
      }),
    ).toBe(false);
    expect(state.spoken).toHaveLength(1);
  });

  test("route upgrade, reroute and traffic alternate replace after cancellation and permit new speech", () => {
    for (const replacement of ["upgrade", "reroute", "traffic-alternate"]) {
      const state = setup();
      const order: string[] = [];
      let route = "old";
      state.boundary.speak({ text: "Old route", kind: "narration", profile: "default" });
      const old = state.spoken[0];
      const originalCancel = state.boundary.cancel;
      state.boundary.cancel = () => {
        order.push("cancel-old");
        originalCancel();
      };
      applyNavigationLifecycleTransition(state.boundary, "replaced", () => {
        route = replacement;
        order.push("install-new");
      });
      expect(order).toEqual(["cancel-old", "install-new"]);
      expect(route).toBe(replacement);
      expect(
        state.boundary.speak({ text: "New manoeuvre", kind: "navigation", profile: "default" }),
      ).toBe(true);
      old.onend?.(new Event("end") as SpeechSynthesisEvent);
      old.onerror?.(new Event("error") as SpeechSynthesisErrorEvent);
      expect(state.boundary.isSpeaking("navigation")).toBe(true);
    }
  });

  test("failed reroute preserves route and does not run successful replacement lifecycle", async () => {
    const state = setup();
    let route = "old";
    await expect(
      awaitNavigationRouteReplacement(
        state.boundary,
        () => Promise.reject(new Error("unavailable")),
        () => {
          route = "new";
        },
      ),
    ).rejects.toThrow("unavailable");
    expect(route).toBe("old");
    expect(state.cancelCount()).toBe(0);
  });

  test("component cleanup is idempotent and stale callbacks cannot mutate later state", () => {
    const state = setup();
    state.boundary.speak({ text: "Turn left", kind: "navigation", profile: "default" });
    const old = state.spoken[0];
    state.boundary.dispose();
    state.boundary.dispose();
    old.onend?.(new Event("end") as SpeechSynthesisEvent);
    old.onerror?.(new Event("error") as SpeechSynthesisErrorEvent);
    expect(state.cancelCount()).toBe(1);
    expect(state.boundary.isSpeaking()).toBe(false);
    expect(
      state.boundary.speak({ text: "After unmount", kind: "navigation", profile: "default" }),
    ).toBe(false);

    const inactive = setup();
    inactive.boundary.dispose();
    inactive.boundary.dispose();
    expect(inactive.cancelCount()).toBe(1);
  });

  test("browser page lifecycle cancels once, removes listeners and never replays speech", () => {
    const browser = installBrowserSpeechMocks();
    try {
      const boundary = createBrowserSpeechBoundary();
      expect(boundary).not.toBeNull();
      expect(browser.listenerCount("window", "pagehide")).toBe(1);
      expect(browser.listenerCount("document", "visibilitychange")).toBe(1);

      boundary?.speak({ text: "Turn left", kind: "navigation", profile: "default" });
      browser.dispatch("document", "visibilitychange");
      expect(browser.cancelCount()).toBe(0);

      browser.setVisibility("hidden");
      browser.dispatch("document", "visibilitychange");
      expect(browser.cancelCount()).toBe(1);
      expect(boundary?.isSpeaking()).toBe(false);
      browser.setVisibility("visible");
      browser.dispatch("document", "visibilitychange");
      expect(browser.spoken).toHaveLength(1);

      boundary?.speak({ text: "Turn right", kind: "navigation", profile: "default" });
      browser.dispatch("window", "pagehide");
      expect(browser.cancelCount()).toBe(2);

      boundary?.dispose();
      boundary?.dispose();
      expect(browser.listenerCount("window", "pagehide")).toBe(0);
      expect(browser.listenerCount("document", "visibilitychange")).toBe(0);
      const afterDispose = browser.cancelCount();
      browser.dispatch("window", "pagehide");
      browser.setVisibility("hidden");
      browser.dispatch("document", "visibilitychange");
      expect(browser.cancelCount()).toBe(afterDispose);
      expect(browser.spoken).toHaveLength(2);
    } finally {
      browser.restore();
    }
  });

  test("discards a reroute that resolves after completion without success effects", async () => {
    const state = setup();
    const guard = createNavigationSessionGuard();
    beginNavigationSession(guard);
    const token = captureNavigationReplacement(guard)!;
    let resolve!: (value: string) => void;
    const provider = new Promise<string>((done) => {
      resolve = done;
    });
    const effects: string[] = [];
    const pending = awaitCurrentNavigationRouteReplacement(
      state.boundary,
      guard,
      token,
      () => provider,
      () => effects.push("install", "summary", "analytics", "toast", "speech"),
    );
    expect(
      completeCurrentNavigationSession(state.boundary, guard, () => effects.push("complete")),
    ).toBe(true);
    resolve("route-a-replacement");
    expect(await pending).toEqual({ status: "stale" });
    expect(effects).toEqual(["complete"]);
    expect(guard.completed).toBe(true);
  });

  test("discards a reroute after explicit end and cannot restore navigation", async () => {
    const state = setup();
    const guard = createNavigationSessionGuard();
    beginNavigationSession(guard);
    const token = captureNavigationReplacement(guard)!;
    let resolve!: (value: string) => void;
    const provider = new Promise<string>((done) => {
      resolve = done;
    });
    let route = "old";
    const pending = awaitCurrentNavigationRouteReplacement(
      state.boundary,
      guard,
      token,
      () => provider,
      (next) => {
        route = next;
      },
    );
    invalidateNavigationSession(guard);
    resolve("stale");
    expect(await pending).toEqual({ status: "stale" });
    expect(route).toBe("old");
    expect(navigationSessionCanSpeak(guard)).toBe(false);
  });

  test("journey B is isolated from journey A's pending reroute", async () => {
    const state = setup();
    const guard = createNavigationSessionGuard();
    beginNavigationSession(guard);
    const tokenA = captureNavigationReplacement(guard)!;
    let resolveA!: (value: string) => void;
    const providerA = new Promise<string>((done) => {
      resolveA = done;
    });
    let route = "journey-a";
    const pendingA = awaitCurrentNavigationRouteReplacement(
      state.boundary,
      guard,
      tokenA,
      () => providerA,
      (next) => {
        route = next;
      },
    );
    invalidateNavigationSession(guard);
    beginNavigationSession(guard);
    route = "journey-b";
    resolveA("stale-a");
    expect(await pendingA).toEqual({ status: "stale" });
    expect(route).toBe("journey-b");
    expect(navigationSessionCanSpeak(guard)).toBe(true);
  });

  test("only the newest overlapping reroute commits and owns loading cleanup", async () => {
    const state = setup();
    const guard = createNavigationSessionGuard();
    beginNavigationSession(guard);
    const tokenA = captureNavigationReplacement(guard)!;
    const tokenB = captureNavigationReplacement(guard)!;
    let resolveA!: (value: string) => void;
    let resolveB!: (value: string) => void;
    const providerA = new Promise<string>((done) => (resolveA = done));
    const providerB = new Promise<string>((done) => (resolveB = done));
    const installed: string[] = [];
    const pendingA = awaitCurrentNavigationRouteReplacement(
      state.boundary,
      guard,
      tokenA,
      () => providerA,
      (next) => installed.push(next),
    );
    const pendingB = awaitCurrentNavigationRouteReplacement(
      state.boundary,
      guard,
      tokenB,
      () => providerB,
      (next) => installed.push(next),
    );
    resolveB("route-b");
    expect(await pendingB).toEqual({ status: "applied", replacement: "route-b" });
    resolveA("route-a");
    expect(await pendingA).toEqual({ status: "stale" });
    expect(installed).toEqual(["route-b"]);
    expect(isLatestNavigationReplacement(guard, tokenA)).toBe(false);
    expect(isLatestNavigationReplacement(guard, tokenB)).toBe(true);
  });

  test("active reroute cancels before install and permits new-route speech", async () => {
    const state = setup();
    const guard = createNavigationSessionGuard();
    beginNavigationSession(guard);
    state.boundary.speak({ text: "Old route", kind: "navigation", profile: "default" });
    const token = captureNavigationReplacement(guard)!;
    const order: string[] = [];
    const originalCancel = state.boundary.cancel;
    state.boundary.cancel = () => {
      order.push("cancel");
      originalCancel();
    };
    const result = await awaitCurrentNavigationRouteReplacement(
      state.boundary,
      guard,
      token,
      async () => "new-route",
      () => order.push("install"),
    );
    expect(result.status).toBe("applied");
    expect(order).toEqual(["cancel", "install"]);
    expect(navigationSessionCanSpeak(guard)).toBe(true);
    expect(
      state.boundary.speak({ text: "Route updated", kind: "navigation", profile: "default" }),
    ).toBe(true);
  });

  test("failed current reroute preserves the old route and success effects", async () => {
    const state = setup();
    const guard = createNavigationSessionGuard();
    beginNavigationSession(guard);
    const token = captureNavigationReplacement(guard)!;
    let route = "old-route";
    const effects: string[] = [];
    await expect(
      awaitCurrentNavigationRouteReplacement(
        state.boundary,
        guard,
        token,
        () => Promise.reject(new Error("provider unavailable")),
        (replacement) => {
          route = replacement;
          effects.push("install", "summary", "analytics", "toast", "speech");
        },
      ),
    ).rejects.toThrow("provider unavailable");
    expect(route).toBe("old-route");
    expect(effects).toEqual([]);
    expect(state.cancelCount()).toBe(0);
    expect(navigationSessionCanSpeak(guard)).toBe(true);
  });

  test("completion keeps its gate when delayed speech and session callbacks fire", () => {
    const state = setup();
    const guard = createNavigationSessionGuard();
    beginNavigationSession(guard);
    const session = captureNavigationSession(guard);
    state.boundary.speak({ text: "Turn left", kind: "navigation", profile: "default" });
    const oldUtterance = state.spoken[0];

    expect(completeCurrentNavigationSession(state.boundary, guard, () => {})).toBe(true);
    oldUtterance.onend?.(new Event("end") as SpeechSynthesisEvent);
    oldUtterance.onerror?.(new Event("error") as SpeechSynthesisErrorEvent);

    expect(guard.completed).toBe(true);
    expect(isCurrentNavigationSession(guard, session)).toBe(false);
    expect(state.boundary.isSpeaking()).toBe(false);
    expect(
      speakDuringActiveNavigation(state.boundary, !navigationSessionCanSpeak(guard), {
        text: "Late instruction",
        kind: "navigation",
        profile: "default",
      }),
    ).toBe(false);
  });

  test("Production terminal transaction clears pending loading and offers before completion", async () => {
    const state = setup();
    const guard = createNavigationSessionGuard();
    const coordinator = createNavigationAsyncCoordinator<string>(guard);
    beginNavigationSession(guard);
    const replacement = beginCoordinatedNavigationReplacement(coordinator)!;
    const alternate = beginNavigationAlternateCalculation(coordinator)!;
    expect(publishNavigationAlternate(coordinator, alternate, "offer-a")).not.toBeNull();
    let resolve!: (value: string) => void;
    const provider = new Promise<string>((done) => (resolve = done));
    const effects: string[] = [];
    let rerouting = true;
    let alternateLoading = true;
    let offer: string | null = "offer-a";
    const pending = awaitCurrentNavigationRouteReplacement(
      state.boundary,
      guard,
      replacement,
      () => provider,
      () => effects.push("install"),
    );

    expect(
      applyTerminalNavigationTransition(
        state.boundary,
        coordinator,
        "completed",
        () => {
          effects.push("cleanup");
          rerouting = false;
          alternateLoading = false;
          offer = null;
        },
        () => effects.push("complete"),
      ),
    ).toBe(true);
    expect([rerouting, alternateLoading, offer]).toEqual([false, false, null]);
    expect(effects).toEqual(["cleanup", "complete"]);
    expect(coordinator.rerouteOwner).toBeNull();
    expect(coordinator.alternateOwner).toBeNull();
    expect(coordinator.alternateOffer).toBeNull();
    expect(consumeCurrentNavigationAlternate(coordinator, "offer-a")).toBe(false);

    resolve("stale-route");
    expect(await pending).toEqual({ status: "stale" });
    expect(finishCoordinatedNavigationReplacement(coordinator, replacement)).toBe(false);
    expect(effects).toEqual(["cleanup", "complete"]);
  });

  test("Journey A alternate cannot publish or be accepted during Journey B", () => {
    const guard = createNavigationSessionGuard();
    const coordinator = createNavigationAsyncCoordinator<string>(guard);
    beginNavigationSession(guard);
    const calculationA = beginNavigationAlternateCalculation(coordinator)!;
    invalidateNavigationSession(guard);
    coordinator.alternateOwner = null;
    beginNavigationSession(guard);

    expect(publishNavigationAlternate(coordinator, calculationA, "offer-a")).toBeNull();
    expect(consumeCurrentNavigationAlternate(coordinator, "offer-a")).toBe(false);
    expect(navigationSessionCanSpeak(guard)).toBe(true);
  });

  test("an older alternate calculation cannot clear a newer published offer", () => {
    const guard = createNavigationSessionGuard();
    const coordinator = createNavigationAsyncCoordinator<string>(guard);
    beginNavigationSession(guard);
    const calculationA = beginNavigationAlternateCalculation(coordinator)!;
    const calculationB = beginNavigationAlternateCalculation(coordinator)!;
    expect(publishNavigationAlternate(coordinator, calculationB, "offer-b")).not.toBeNull();
    expect(clearNavigationAlternateForCalculation(coordinator, calculationA)).toBe(false);
    expect(coordinator.alternateOffer?.value).toBe("offer-b");
  });

  test("valid current alternate accepts once and preserves replacement ordering", () => {
    const state = setup();
    const guard = createNavigationSessionGuard();
    const coordinator = createNavigationAsyncCoordinator<string>(guard);
    beginNavigationSession(guard);
    const calculation = beginNavigationAlternateCalculation(coordinator)!;
    expect(publishNavigationAlternate(coordinator, calculation, "offer-current")).not.toBeNull();
    expect(finishNavigationAlternateCalculation(coordinator, calculation)).toBe(true);
    const originalSession = guard.current;
    const order: string[] = [];
    const originalCancel = state.boundary.cancel;
    state.boundary.cancel = () => {
      order.push("cancel");
      originalCancel();
    };
    let renderedOffer: string | null = "offer-current";
    const accept = () =>
      acceptCurrentNavigationAlternate(
        state.boundary,
        coordinator,
        "offer-current",
        () => {
          renderedOffer = null;
          order.push("cleanup");
        },
        () => order.push("install"),
      );
    expect(accept()).toBe(true);
    expect(order).toEqual(["cleanup", "cancel", "install"]);
    expect(guard.current).not.toBe(originalSession);
    expect(renderedOffer).toBeNull();
    expect(coordinator.alternateOffer).toBeNull();
    expect(accept()).toBe(false);
    expect(order).toEqual(["cleanup", "cancel", "install"]);
    expect(
      speakDuringActiveNavigation(state.boundary, !navigationSessionCanSpeak(guard), {
        text: "New route instruction",
        kind: "navigation",
        profile: "default",
      }),
    ).toBe(true);
  });

  test("loading ownership survives overlap and terminal cleanup owns the final clear", () => {
    const guard = createNavigationSessionGuard();
    const coordinator = createNavigationAsyncCoordinator<string>(guard);
    beginNavigationSession(guard);
    const requestA = beginCoordinatedNavigationReplacement(coordinator)!;
    const requestB = beginCoordinatedNavigationReplacement(coordinator)!;
    let loading = true;
    if (finishCoordinatedNavigationReplacement(coordinator, requestA)) loading = false;
    expect(loading).toBe(true);
    if (finishCoordinatedNavigationReplacement(coordinator, requestB)) loading = false;
    expect(loading).toBe(false);

    const requestC = beginCoordinatedNavigationReplacement(coordinator)!;
    loading = true;
    applyTerminalNavigationTransition(
      null,
      coordinator,
      "completed",
      () => (loading = false),
      () => {},
    );
    expect(loading).toBe(false);
    expect(finishCoordinatedNavigationReplacement(coordinator, requestC)).toBe(false);
  });

  test("Strict Mode lifecycle replay reactivates the guard without stale cleanup winning", () => {
    const stateA = setup();
    const stateB = setup();
    const guard = createNavigationSessionGuard();
    const lifecycleA = activateNavigationLifecycle(guard);
    beginNavigationSession(guard);
    expect(captureNavigationReplacement(guard)).not.toBeNull();
    expect(deactivateNavigationLifecycle(guard, lifecycleA)).toBe(true);
    stateA.boundary.dispose();

    const lifecycleB = activateNavigationLifecycle(guard);
    beginNavigationSession(guard);
    expect(captureNavigationReplacement(guard)).not.toBeNull();
    expect(
      speakDuringActiveNavigation(stateB.boundary, !navigationSessionCanSpeak(guard), {
        text: "Journey B instruction",
        kind: "navigation",
        profile: "default",
      }),
    ).toBe(true);
    expect(deactivateNavigationLifecycle(guard, lifecycleA)).toBe(false);
    expect(navigationSessionCanSpeak(guard)).toBe(true);
    expect(deactivateNavigationLifecycle(guard, lifecycleB)).toBe(true);
    stateB.boundary.dispose();
    expect(captureNavigationReplacement(guard)).toBeNull();
    expect(navigationSessionCanSpeak(guard)).toBe(false);
  });

  test("true unmount makes a pending Production replacement stale", async () => {
    const state = setup();
    const guard = createNavigationSessionGuard();
    const coordinator = createNavigationAsyncCoordinator<string>(guard);
    const lifecycle = activateNavigationLifecycle(guard);
    beginNavigationSession(guard);
    const token = beginCoordinatedNavigationReplacement(coordinator)!;
    let resolve!: (value: string) => void;
    const provider = new Promise<string>((done) => (resolve = done));
    const effects: string[] = [];
    const pending = awaitCurrentNavigationRouteReplacement(
      state.boundary,
      guard,
      token,
      () => provider,
      () => effects.push("state", "offer", "speech", "toast", "analytics"),
    );
    deactivateNavigationAsyncLifecycle(coordinator, lifecycle);
    state.boundary.dispose();
    resolve("late-route");
    expect(await pending).toEqual({ status: "stale" });
    expect(effects).toEqual([]);
  });

  test("manual reroute and route upgrade start with synchronously clean alternate state", () => {
    for (const replacement of ["manual-reroute", "route-upgrade"]) {
      const state = setup();
      const guard = createNavigationSessionGuard();
      const coordinator = createNavigationAsyncCoordinator<string>(guard);
      beginNavigationSession(guard);
      const oldSession = guard.current;
      const alternate = beginNavigationAlternateCalculation(coordinator)!;
      expect(publishNavigationAlternate(coordinator, alternate, "old-offer")).not.toBeNull();
      let renderedOffer: string | null = "old-offer";
      let alternateLoading = true;
      const order: string[] = [];
      const originalCancel = state.boundary.cancel;
      state.boundary.cancel = () => {
        order.push("cancel");
        originalCancel();
      };

      applyNavigationReplacementTransition(
        state.boundary,
        coordinator,
        () => {
          renderedOffer = null;
          alternateLoading = false;
          order.push("cleanup");
        },
        () => order.push(`install-${replacement}`),
      );

      expect(order).toEqual(["cleanup", "cancel", `install-${replacement}`]);
      expect(renderedOffer).toBeNull();
      expect(alternateLoading).toBe(false);
      expect(coordinator.alternateOwner).toBeNull();
      expect(coordinator.alternateOffer).toBeNull();
      expect(guard.current).not.toBe(oldSession);
      expect(publishNavigationAlternate(coordinator, alternate, "stale-offer")).toBeNull();
    }
  });

  test("failed coordinated reroute preserves a valid current alternate offer", async () => {
    const state = setup();
    const guard = createNavigationSessionGuard();
    const coordinator = createNavigationAsyncCoordinator<string>(guard);
    beginNavigationSession(guard);
    const alternate = beginNavigationAlternateCalculation(coordinator)!;
    expect(publishNavigationAlternate(coordinator, alternate, "current-offer")).not.toBeNull();
    const replacement = beginCoordinatedNavigationReplacement(coordinator)!;
    let cleanupCount = 0;
    await expect(
      awaitCoordinatedNavigationRouteReplacement(
        state.boundary,
        coordinator,
        replacement,
        () => Promise.reject(new Error("provider unavailable")),
        () => cleanupCount++,
        () => {
          throw new Error("must not install");
        },
      ),
    ).rejects.toThrow("provider unavailable");
    expect(cleanupCount).toBe(0);
    expect(coordinator.alternateOffer?.value).toBe("current-offer");
    expect(navigationSessionCanSpeak(guard)).toBe(true);
  });

  test("journeys A and B each complete exactly once after reset", () => {
    const state = setup();
    const guard = createNavigationSessionGuard();
    const coordinator = createNavigationAsyncCoordinator<string>(guard);
    let commits = 0;
    let rerouting = false;
    let alternateLoading = false;
    let renderedOffer: string | null = null;
    const cleanup = () => {
      rerouting = false;
      alternateLoading = false;
      renderedOffer = null;
    };
    const complete = () =>
      applyTerminalNavigationTransition(
        state.boundary,
        coordinator,
        "completed",
        cleanup,
        () => commits++,
      );

    beginNavigationSession(guard);
    rerouting = true;
    expect(beginCoordinatedNavigationReplacement(coordinator)).not.toBeNull();
    const alternateA = beginNavigationAlternateCalculation(coordinator)!;
    expect(publishNavigationAlternate(coordinator, alternateA, "offer-a")).not.toBeNull();
    alternateLoading = true;
    renderedOffer = "offer-a";
    expect(complete()).toBe(true);
    expect([rerouting, alternateLoading, renderedOffer]).toEqual([false, false, null]);
    expect(coordinator.rerouteOwner).toBeNull();
    expect(coordinator.alternateOwner).toBeNull();
    expect(coordinator.alternateOffer).toBeNull();
    expect(complete()).toBe(false);

    expect(
      applyTerminalNavigationTransition(state.boundary, coordinator, "cleared", cleanup, () => {}),
    ).toBe(true);
    beginNavigationSession(guard);
    expect(navigationSessionCanSpeak(guard)).toBe(true);
    expect([rerouting, alternateLoading, renderedOffer]).toEqual([false, false, null]);
    expect(beginCoordinatedNavigationReplacement(coordinator)).not.toBeNull();
    expect(
      speakDuringActiveNavigation(state.boundary, !navigationSessionCanSpeak(guard), {
        text: "Journey B instruction",
        kind: "navigation",
        profile: "default",
      }),
    ).toBe(true);
    const alternateB = beginNavigationAlternateCalculation(coordinator)!;
    expect(publishNavigationAlternate(coordinator, alternateB, "offer-b")).not.toBeNull();
    alternateLoading = true;
    renderedOffer = "offer-b";
    expect(complete()).toBe(true);
    expect(complete()).toBe(false);
    expect([rerouting, alternateLoading, renderedOffer]).toEqual([false, false, null]);
    expect(commits).toBe(2);
    expect(state.cancelCount()).toBe(2);
  });
});
