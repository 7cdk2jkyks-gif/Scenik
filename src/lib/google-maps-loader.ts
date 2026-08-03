import { getGoogleMapsBrowserKey } from "./google-maps.functions";

declare global {
  interface Window {
    __scenicMapPromise?: Promise<void>;
    __scenicMapReady?: boolean;
    __initScenicMap?: () => void;
  }
}

export function loadGoogleMaps(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.__scenicMapReady) return Promise.resolve();
  if (window.__scenicMapPromise) return window.__scenicMapPromise;

  window.__scenicMapPromise = new Promise<void>((resolve, reject) => {
    void (async () => {
      let key: string | undefined;
      try {
        const config = await getGoogleMapsBrowserKey();
        key = config.key;
      } catch {
        // Keep the managed browser key as a fallback for Lovable preview URLs.
        key = import.meta.env.VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY;
      }
      const channel = import.meta.env.VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_TRACKING_ID;
      if (!key) {
        reject(new Error("Missing Google Maps browser key"));
        return;
      }
      window.__initScenicMap = () => {
        window.__scenicMapReady = true;
        resolve();
      };
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&loading=async&libraries=geometry,places&callback=__initScenicMap${channel ? `&channel=${channel}` : ""}`;
      s.async = true;
      s.defer = true;
      s.onerror = () => reject(new Error("Failed to load Google Maps"));
      document.head.appendChild(s);
    })().catch(reject);
  });
  return window.__scenicMapPromise;
}

const REVERSE_GEOCODE_TIMEOUT_MS = 8_000;

export async function reverseGeocodeInBrowser(lat: number, lng: number): Promise<string> {
  console.info("[Location] browser reverse geocode started");

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const address = await Promise.race([
      (async () => {
        await loadGoogleMaps();
        const response = await new window.google.maps.Geocoder().geocode({
          location: { lat, lng },
        });
        const result = response.results.find(
          ({ formatted_address }) => formatted_address.trim().length > 0,
        );
        if (!result) throw new Error("REVERSE_GEOCODE_NOT_FOUND");
        return result.formatted_address;
      })(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("REVERSE_GEOCODE_TIMEOUT")),
          REVERSE_GEOCODE_TIMEOUT_MS,
        );
      }),
    ]);

    console.info("[Location] browser reverse geocode completed");
    return address;
  } catch (error) {
    console.warn("[Location] browser reverse geocode failed");
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
