// Unified geolocation helper. On native (Capacitor iOS/Android) it uses the
// @capacitor/geolocation plugin, which is dramatically faster and more
// reliable than WKWebView's navigator.geolocation on iOS (that path routinely
// takes 15-30s to return a first fix). On the web it falls back to the
// standard browser API with the same "cached fast path + high-accuracy retry"
// strategy.

import { isNativePlatform } from "@/lib/native";

export type Coords = { lat: number; lng: number };

async function getNativePosition(highAccuracy: boolean, timeout: number): Promise<Coords> {
  const { Geolocation } = await import("@capacitor/geolocation");
  // Ensure permission first so the OS prompt shows immediately instead of
  // silently timing out.
  const perm = await Geolocation.checkPermissions();
  if (perm.location !== "granted") {
    const req = await Geolocation.requestPermissions();
    if (req.location !== "granted") {
      throw Object.assign(new Error("Location permission denied"), { code: 1, PERMISSION_DENIED: 1 });
    }
  }
  const pos = await Geolocation.getCurrentPosition({
    enableHighAccuracy: highAccuracy,
    timeout,
    maximumAge: highAccuracy ? 0 : 300_000,
  });
  return { lat: pos.coords.latitude, lng: pos.coords.longitude };
}

function getWebPosition(highAccuracy: boolean, timeout: number): Promise<Coords> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("Geolocation unavailable"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(err),
      {
        enableHighAccuracy: highAccuracy,
        timeout,
        maximumAge: highAccuracy ? 0 : 300_000,
      },
    );
  });
}

/**
 * Get the user's location as fast as possible.
 *
 * Strategy:
 *   1. Try a low-accuracy fix reusing any cached wifi/network location (up to
 *      5 minutes old). On iOS this typically returns in <1s.
 *   2. If that fails or times out, retry once with high accuracy (up to 10s)
 *      to warm up the GPS chip.
 */
export async function getFastLocation(): Promise<Coords> {
  const native = isNativePlatform();
  const fetch = native ? getNativePosition : getWebPosition;
  try {
    return await fetch(false, 6_000);
  } catch (err: unknown) {
    const code = (err as { code?: number } | null)?.code;
    // Permission denied — don't retry, surface immediately.
    if (code === 1) throw err;
    return await fetch(true, 10_000);
  }
}
