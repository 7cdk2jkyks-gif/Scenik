import posthog from "posthog-js";
import { POSTHOG_HOST, POSTHOG_KEY, CONSENT_STORAGE_KEY } from "./config";
import type { AnalyticsEventName } from "./events";

// ─────────────────────────────────────────────────────────────────────────────
// GDPR-first PostHog wrapper.
//
// Design:
//   - Strict opt-in: PostHog is initialised only after the user accepts.
//     Nothing (not even `$pageview`) is captured until then.
//   - `person_profiles: 'identified_only'` so anonymous visitors never
//     get a profile — reduces stored personal data.
//   - `respect_dnt: true` — honour Do-Not-Track.
//   - No autocapture: we only send the explicit events we define.
//   - `capture` is safe to call before init; it no-ops.
// ─────────────────────────────────────────────────────────────────────────────

type ConsentState = "unknown" | "granted" | "denied";

let initialized = false;
let currentConsent: ConsentState = "unknown";

function isBrowser() {
  return typeof window !== "undefined";
}

export function readStoredConsent(): ConsentState {
  if (!isBrowser()) return "unknown";
  try {
    const v = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    if (v === "granted" || v === "denied") return v;
  } catch {
    // localStorage blocked (e.g. Safari private mode) — treat as unknown.
  }
  return "unknown";
}

export function getConsent(): ConsentState {
  return currentConsent === "unknown" ? readStoredConsent() : currentConsent;
}

function persistConsent(state: ConsentState) {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, state);
  } catch {
    /* ignore */
  }
}

function initPostHog() {
  if (initialized || !isBrowser() || !POSTHOG_KEY) return;
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    person_profiles: "identified_only",
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: false,
    disable_session_recording: true,
    respect_dnt: true,
    opt_out_capturing_by_default: true,
    loaded: (ph) => {
      ph.opt_in_capturing();
    },
  });
  initialized = true;
}

export function grantConsent() {
  currentConsent = "granted";
  persistConsent("granted");
  if (!isBrowser() || !POSTHOG_KEY) return;
  if (!initialized) {
    initPostHog();
  } else {
    posthog.opt_in_capturing();
  }
}

export function denyConsent() {
  currentConsent = "denied";
  persistConsent("denied");
  if (!isBrowser()) return;
  if (initialized) {
    posthog.opt_out_capturing();
  }
}

/** Called once from the AnalyticsProvider on mount. If consent was previously
 *  granted, initialises PostHog; otherwise waits for the banner. */
export function bootstrapAnalytics() {
  if (!isBrowser()) return;
  const stored = readStoredConsent();
  currentConsent = stored;
  if (stored === "granted") initPostHog();
}

/** Safe to call at any time — no-ops if PostHog is not initialised or the
 *  user has not consented. */
export function capture(
  event: AnalyticsEventName,
  properties?: Record<string, unknown>,
) {
  if (!isBrowser() || !initialized) return;
  if (getConsent() !== "granted") return;
  try {
    posthog.capture(event, properties);
  } catch {
    /* never let analytics break the app */
  }
}

export function identify(userId: string, traits?: Record<string, unknown>) {
  if (!isBrowser() || !initialized) return;
  if (getConsent() !== "granted") return;
  try {
    posthog.identify(userId, traits);
  } catch {
    /* ignore */
  }
}

export function reset() {
  if (!isBrowser() || !initialized) return;
  try {
    posthog.reset();
  } catch {
    /* ignore */
  }
}

export function pageview(pathname: string) {
  if (!isBrowser() || !initialized) return;
  if (getConsent() !== "granted") return;
  try {
    posthog.capture("$pageview", { $current_url: window.location.href, pathname });
  } catch {
    /* ignore */
  }
}
