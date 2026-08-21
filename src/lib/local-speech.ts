import {
  selectSpeechVoice,
  speechTuning,
  type NarrationVoiceStyle,
  type SpeechVoiceLike,
} from "./scenic-narration";

export type SpeechKind = "navigation" | "narration" | "preview" | "primer";

type SpeechSynthesisLike = {
  speaking: boolean;
  paused: boolean;
  getVoices(): SpeechSynthesisVoice[];
  speak(utterance: SpeechSynthesisUtterance): void;
  cancel(): void;
  resume(): void;
  addEventListener?(type: "voiceschanged", listener: () => void): void;
  removeEventListener?(type: "voiceschanged", listener: () => void): void;
};

export type LocalSpeechBoundary = {
  speak(input: {
    text: string;
    kind: Exclude<SpeechKind, "primer">;
    profile: NarrationVoiceStyle;
    volume?: number;
    muted?: boolean;
  }): boolean;
  prime(profile: NarrationVoiceStyle): void;
  cancel(): void;
  isSpeaking(kind?: "navigation" | "narration" | "preview"): boolean;
  selectedVoice(profile: NarrationVoiceStyle): SpeechVoiceLike | null;
  dispose(): void;
};

type LocalSpeechInput = Parameters<LocalSpeechBoundary["speak"]>[0];

export type NavigationSessionGuard = {
  current: object | null;
  latestReplacement: object | null;
  lifecycle: object | null;
  completed: boolean;
  mounted: boolean;
};

export type NavigationReplacementToken = {
  session: object;
  request: object;
};

export function createNavigationSessionGuard(): NavigationSessionGuard {
  return {
    current: null,
    latestReplacement: null,
    lifecycle: null,
    completed: false,
    mounted: true,
  };
}

export function activateNavigationLifecycle(guard: NavigationSessionGuard) {
  const lifecycle = {};
  guard.lifecycle = lifecycle;
  guard.mounted = true;
  return lifecycle;
}

export function deactivateNavigationLifecycle(guard: NavigationSessionGuard, lifecycle: object) {
  if (guard.lifecycle !== lifecycle) return false;
  guard.lifecycle = null;
  guard.mounted = false;
  invalidateNavigationSession(guard);
  return true;
}

export function beginNavigationSession(
  guard: NavigationSessionGuard,
  preserveLatestReplacement = false,
) {
  guard.current = {};
  if (!preserveLatestReplacement) guard.latestReplacement = null;
  guard.completed = false;
  return guard.current;
}

export function invalidateNavigationSession(guard: NavigationSessionGuard, completed = false) {
  guard.current = null;
  guard.latestReplacement = null;
  guard.completed = completed;
}

export function disposeNavigationSession(guard: NavigationSessionGuard) {
  guard.lifecycle = null;
  guard.mounted = false;
  invalidateNavigationSession(guard);
}

export function captureNavigationReplacement(
  guard: NavigationSessionGuard,
): NavigationReplacementToken | null {
  if (!guard.mounted || guard.completed || guard.current == null) return null;
  const token = { session: guard.current, request: {} };
  guard.latestReplacement = token.request;
  return token;
}

export function isCurrentNavigationReplacement(
  guard: NavigationSessionGuard,
  token: NavigationReplacementToken,
) {
  return (
    guard.mounted &&
    !guard.completed &&
    guard.current === token.session &&
    guard.latestReplacement === token.request
  );
}

export function isLatestNavigationReplacement(
  guard: NavigationSessionGuard,
  token: NavigationReplacementToken,
) {
  return guard.latestReplacement === token.request;
}

export function navigationSessionCanSpeak(guard: NavigationSessionGuard) {
  return guard.mounted && !guard.completed && guard.current != null;
}

export function captureNavigationSession(guard: NavigationSessionGuard) {
  return navigationSessionCanSpeak(guard) ? guard.current : null;
}

export function isCurrentNavigationSession(guard: NavigationSessionGuard, session: object | null) {
  return session != null && navigationSessionCanSpeak(guard) && guard.current === session;
}

export type NavigationAsyncCoordinator = {
  guard: NavigationSessionGuard;
  replacementOwner: object | null;
};

export function createNavigationAsyncCoordinator(guard: NavigationSessionGuard) {
  return {
    guard,
    replacementOwner: null,
  } satisfies NavigationAsyncCoordinator;
}

export function beginCoordinatedNavigationReplacement(coordinator: NavigationAsyncCoordinator) {
  const token = captureNavigationReplacement(coordinator.guard);
  if (token) coordinator.replacementOwner = token.request;
  return token;
}

export function finishCoordinatedNavigationReplacement(
  coordinator: NavigationAsyncCoordinator,
  token: NavigationReplacementToken,
) {
  if (coordinator.replacementOwner !== token.request) return false;
  coordinator.replacementOwner = null;
  return true;
}

export function clearNavigationAsyncOwnership(coordinator: NavigationAsyncCoordinator) {
  coordinator.replacementOwner = null;
}

export function applyNavigationReplacementTransition(
  boundary: LocalSpeechBoundary | null,
  coordinator: NavigationAsyncCoordinator,
  cleanup: () => void,
  commit: () => void,
) {
  clearNavigationAsyncOwnership(coordinator);
  cleanup();
  beginNavigationSession(coordinator.guard);
  applyNavigationLifecycleTransition(boundary, "replaced", commit);
}

export function deactivateNavigationAsyncLifecycle(
  coordinator: NavigationAsyncCoordinator,
  lifecycle: object,
) {
  if (!deactivateNavigationLifecycle(coordinator.guard, lifecycle)) return false;
  clearNavigationAsyncOwnership(coordinator);
  return true;
}

export type NavigationSpeechEndReason = "closed" | "completed" | "cleared" | "replaced";
export type NavigationLifecycleTransition = NavigationSpeechEndReason | "continue";

export function shutdownNavigationSpeech(
  boundary: LocalSpeechBoundary | null,
  _reason: NavigationSpeechEndReason,
) {
  boundary?.cancel();
}

export function applyNavigationLifecycleTransition(
  boundary: LocalSpeechBoundary | null,
  transition: NavigationLifecycleTransition,
  commit: () => void,
) {
  if (transition !== "continue") shutdownNavigationSpeech(boundary, transition);
  commit();
}

export function completeNavigationLifecycle(
  boundary: LocalSpeechBoundary | null,
  alreadyCompleted: boolean,
  commit: () => void,
) {
  if (alreadyCompleted) return false;
  applyNavigationLifecycleTransition(boundary, "completed", commit);
  return true;
}

export function completeCurrentNavigationSession(
  boundary: LocalSpeechBoundary | null,
  guard: NavigationSessionGuard,
  commit: () => void,
) {
  if (!navigationSessionCanSpeak(guard)) return false;
  invalidateNavigationSession(guard, true);
  applyNavigationLifecycleTransition(boundary, "completed", commit);
  return true;
}

export function applyTerminalNavigationTransition(
  boundary: LocalSpeechBoundary | null,
  coordinator: NavigationAsyncCoordinator,
  reason: Exclude<NavigationSpeechEndReason, "replaced">,
  cleanup: () => void,
  commit: () => void,
) {
  const wasActive = navigationSessionCanSpeak(coordinator.guard);
  if (reason === "completed" && !wasActive) return false;
  invalidateNavigationSession(coordinator.guard, reason === "completed");
  clearNavigationAsyncOwnership(coordinator);
  cleanup();
  if (wasActive) applyNavigationLifecycleTransition(boundary, reason, commit);
  else commit();
  return true;
}

export async function awaitNavigationRouteReplacement<T>(
  boundary: LocalSpeechBoundary | null,
  loadReplacement: () => Promise<T>,
  commit: (replacement: T) => void,
) {
  const replacement = await loadReplacement();
  applyNavigationLifecycleTransition(boundary, "replaced", () => commit(replacement));
  return replacement;
}

export async function awaitCurrentNavigationRouteReplacement<T>(
  boundary: LocalSpeechBoundary | null,
  guard: NavigationSessionGuard,
  token: NavigationReplacementToken,
  loadReplacement: () => Promise<T>,
  commit: (replacement: T) => void,
): Promise<{ status: "applied"; replacement: T } | { status: "stale" }> {
  const replacement = await loadReplacement();
  if (!isCurrentNavigationReplacement(guard, token)) return { status: "stale" };
  shutdownNavigationSpeech(boundary, "replaced");
  // The accepted route starts a fresh session, while this exact request retains
  // ownership of its loading cleanup until the caller's finally block runs.
  beginNavigationSession(guard, true);
  commit(replacement);
  return { status: "applied", replacement };
}

export async function awaitCoordinatedNavigationRouteReplacement<T>(
  boundary: LocalSpeechBoundary | null,
  coordinator: NavigationAsyncCoordinator,
  token: NavigationReplacementToken,
  loadReplacement: () => Promise<T>,
  cleanup: () => void,
  commit: (replacement: T) => void,
): Promise<{ status: "applied"; replacement: T } | { status: "stale" }> {
  const replacement = await loadReplacement();
  if (!isCurrentNavigationReplacement(coordinator.guard, token)) return { status: "stale" };
  applyNavigationReplacementTransition(boundary, coordinator, cleanup, () => commit(replacement));
  return { status: "applied", replacement };
}

export function speakDuringActiveNavigation(
  boundary: LocalSpeechBoundary | null,
  completed: boolean,
  input: LocalSpeechInput,
) {
  if (completed) return false;
  return boundary?.speak(input) ?? false;
}

type BoundaryOptions = {
  synthesis: SpeechSynthesisLike;
  createUtterance: (text: string) => SpeechSynthesisUtterance;
  locale: string;
};

const cleanSpeechText = (text: string) =>
  text
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(OK|Okay), now\b/gi, "Okay, now")
    .replace(/\bComing up in\b/gi, "coming up in")
    .replace(/\bIn about\b/gi, "in about")
    .replace(/\bRoute updated\b/gi, "Route updated");

export function createLocalSpeechBoundary(options: BoundaryOptions): LocalSpeechBoundary {
  let voices = options.synthesis.getVoices();
  let activeSpeech: { utterance: SpeechSynthesisUtterance; kind: SpeechKind } | null = null;
  let disposed = false;

  const refreshVoices = () => {
    voices = options.synthesis.getVoices();
  };
  options.synthesis.addEventListener?.("voiceschanged", refreshVoices);

  const cancel = () => {
    // Web Speech cancellation is global to this page. Clear Scenik's ownership
    // synchronously so delayed browser callbacks cannot affect later speech.
    activeSpeech = null;
    options.synthesis.cancel();
  };

  const selectedVoice = (profile: NarrationVoiceStyle) =>
    selectSpeechVoice(voices, options.locale, profile);

  const speak: LocalSpeechBoundary["speak"] = ({ text, kind, profile, volume = 1, muted }) => {
    if (disposed || muted) return false;
    const clean = cleanSpeechText(text);
    if (!clean) return false;
    if (kind === "narration" && activeSpeech != null) return false;

    let identity: { utterance: SpeechSynthesisUtterance; kind: SpeechKind } | null = null;
    try {
      if ((kind === "navigation" || kind === "preview") && activeSpeech != null) cancel();
      if (options.synthesis.paused) options.synthesis.resume();
      refreshVoices();
      const utterance = options.createUtterance(clean);
      const voice = selectedVoice(profile) as SpeechSynthesisVoice | null;
      const tuning = speechTuning(profile);
      utterance.voice = voice;
      utterance.lang = voice?.lang ?? "en-GB";
      utterance.rate = tuning.rate;
      utterance.pitch = tuning.pitch;
      utterance.volume = Math.max(0, Math.min(1, volume * tuning.volume));
      identity = { utterance, kind };
      activeSpeech = identity;
      utterance.onstart = null;
      const clear = () => {
        if (activeSpeech === identity) activeSpeech = null;
      };
      utterance.onend = clear;
      utterance.onerror = clear;
      options.synthesis.speak(utterance);
      return true;
    } catch {
      if (activeSpeech === identity) activeSpeech = null;
      return false;
    }
  };

  return {
    speak,
    prime(profile) {
      if (disposed) return;
      try {
        if (activeSpeech != null) cancel();
        refreshVoices();
        const utterance = options.createUtterance(" ");
        const voice = selectedVoice(profile) as SpeechSynthesisVoice | null;
        utterance.voice = voice;
        utterance.lang = voice?.lang ?? "en-GB";
        utterance.rate = 1;
        utterance.pitch = 1;
        utterance.volume = 0.01;
        const identity = { utterance, kind: "primer" as const };
        activeSpeech = identity;
        const clear = () => {
          if (activeSpeech === identity) activeSpeech = null;
        };
        utterance.onstart = null;
        utterance.onend = clear;
        utterance.onerror = clear;
        options.synthesis.speak(utterance);
      } catch {
        activeSpeech = null;
        // Local speech is optional and must never block navigation.
      }
    },
    cancel,
    isSpeaking(kind) {
      return kind ? activeSpeech?.kind === kind : activeSpeech != null;
    },
    selectedVoice,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      options.synthesis.removeEventListener?.("voiceschanged", refreshVoices);
    },
  };
}

export function createBrowserSpeechBoundary(): LocalSpeechBoundary | null {
  if (
    typeof window === "undefined" ||
    !("speechSynthesis" in window) ||
    typeof SpeechSynthesisUtterance === "undefined"
  )
    return null;

  const boundary = createLocalSpeechBoundary({
    synthesis: window.speechSynthesis,
    createUtterance: (text) => new SpeechSynthesisUtterance(text),
    locale: navigator.language || "en-GB",
  });
  const stopForBackground = () => {
    if (document.visibilityState === "hidden") boundary.cancel();
  };
  const stopForPageHide = () => boundary.cancel();
  document.addEventListener("visibilitychange", stopForBackground);
  window.addEventListener("pagehide", stopForPageHide);

  let disposed = false;
  return {
    ...boundary,
    dispose() {
      if (disposed) return;
      disposed = true;
      document.removeEventListener("visibilitychange", stopForBackground);
      window.removeEventListener("pagehide", stopForPageHide);
      boundary.dispose();
    },
  };
}
