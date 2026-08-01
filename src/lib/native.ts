// Runtime helpers for detecting whether the app is running inside a native
// Capacitor shell (iOS/Android) versus the plain web browser. Kept dependency-
// free so it is safe to import from SSR contexts.

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => "ios" | "android" | "web";
};

function getCapacitor(): CapacitorGlobal | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

export function isNativePlatform(): boolean {
  const cap = getCapacitor();
  return typeof cap?.isNativePlatform === "function" ? cap.isNativePlatform() : false;
}

export function getPlatform(): "ios" | "android" | "web" {
  const cap = getCapacitor();
  if (cap?.getPlatform) return cap.getPlatform();
  return "web";
}

export function isIOS(): boolean {
  return getPlatform() === "ios";
}

export function isAndroid(): boolean {
  return getPlatform() === "android";
}

/**
 * Public web origin for the app. When running inside the native shell the
 * document origin can be `capacitor://localhost` (locally bundled assets),
 * which is not a valid URL for OAuth redirects, checkout return URLs, or
 * shareable links. Fall back to the canonical public site in that case.
 */
export const PUBLIC_WEB_ORIGIN = "https://goscenik.com";

export function getPublicOrigin(): string {
  if (typeof window === "undefined") return PUBLIC_WEB_ORIGIN;
  const origin = window.location.origin;
  if (!origin || !/^https?:/i.test(origin) || /localhost|127\.0\.0\.1/.test(origin)) {
    // Dev server on http://localhost is fine for local web work, but a native
    // shell serving local assets must use the public origin.
    if (isNativePlatform()) return PUBLIC_WEB_ORIGIN;
  }
  if (!/^https?:/i.test(origin)) return PUBLIC_WEB_ORIGIN;
  return origin;
}
