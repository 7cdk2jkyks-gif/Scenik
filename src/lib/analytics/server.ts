// Server-side PostHog capture via HTTP. Small, dependency-free — safe in the
// Cloudflare Workers runtime (no `posthog-node`). Fire-and-forget: never throws,
// never blocks the caller.
//
// Reads the same publishable project key used on the client. Set POSTHOG_KEY
// in src/lib/analytics/config.ts.

import { POSTHOG_HOST, POSTHOG_KEY } from "./config";
import type { AnalyticsEventName } from "./events";

export async function serverCapture(
  event: AnalyticsEventName,
  distinctId: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  if (!POSTHOG_KEY || !distinctId) return;
  try {
    await fetch(`${POSTHOG_HOST}/i/v0/e/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        event,
        distinct_id: distinctId,
        properties: { $lib: "scenik-server", ...properties },
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.warn("[analytics] server capture failed", (e as Error).message);
  }
}
