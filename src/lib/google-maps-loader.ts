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

  window.__scenicMapPromise = new Promise<void>(async (resolve, reject) => {
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
  });
  return window.__scenicMapPromise;
}
