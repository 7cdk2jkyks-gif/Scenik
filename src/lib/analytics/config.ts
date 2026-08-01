// ─────────────────────────────────────────────────────────────────────────────
// PostHog configuration
//
// The Project API key (starts with `phc_`) is a *publishable* key and is
// safe to ship in the client bundle. Paste your key from
// https://eu.posthog.com/project/settings > Project API Key into POSTHOG_KEY
// below. If left empty, analytics no-ops silently (safe default).
// ─────────────────────────────────────────────────────────────────────────────

export const POSTHOG_KEY = "";
export const POSTHOG_HOST = "https://eu.i.posthog.com";

// Storage key for the strict-GDPR opt-in banner.
export const CONSENT_STORAGE_KEY = "scenik_analytics_consent_v1";
