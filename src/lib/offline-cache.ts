// Client-side cache for route data so navigation continues offline.
// We only cache app-generated route metadata, polylines, and turn-by-turn
// instructions — never Google Maps tiles or imagery (per Maps Platform ToS).

const LAST_PLAN_KEY = "scenik:offline:last-plan:v1";
const SAVED_ROUTES_KEY = "scenik:offline:saved-routes:v1";

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export interface CachedPlan<TResult> {
  result: TResult;
  savedAt: number;
}

export function saveLastPlan<T>(result: T): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.setItem(LAST_PLAN_KEY, JSON.stringify({ result, savedAt: Date.now() }));
  } catch {
    /* quota or serialization failure — silent, cache is best-effort */
  }
}

export function loadLastPlan<T>(): CachedPlan<T> | null {
  const s = safeStorage();
  if (!s) return null;
  try {
    const raw = s.getItem(LAST_PLAN_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CachedPlan<T>;
  } catch {
    return null;
  }
}

export function clearLastPlan(): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.removeItem(LAST_PLAN_KEY);
  } catch { /* noop */ }
}

export function saveSavedRoutes<T>(list: T): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.setItem(SAVED_ROUTES_KEY, JSON.stringify({ list, savedAt: Date.now() }));
  } catch { /* noop */ }
}

export function loadSavedRoutes<T>(): T | null {
  const s = safeStorage();
  if (!s) return null;
  try {
    const raw = s.getItem(SAVED_ROUTES_KEY);
    if (!raw) return null;
    return (JSON.parse(raw) as { list: T }).list ?? null;
  } catch {
    return null;
  }
}
