import { createServerFn } from "@tanstack/react-start";

/**
 * Google Maps browser keys are public credentials protected by Google's
 * HTTP-referrer restrictions. Resolve the custom-domain key at runtime so a
 * production build cannot accidentally bake in the Lovable-managed key.
 */
export const getGoogleMapsBrowserKey = createServerFn({ method: "GET" }).handler(
  async () => {
    const key = process.env.GOOGLE_API_KEY;
    if (!key) {
      throw new Error("Custom Google Maps browser key is not configured");
    }
    return { key };
  },
);