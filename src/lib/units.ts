import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { getMyProfile } from "./profiles.functions";


export type UnitSystem = "mi" | "km";

const IMPERIAL_LOCALES = /^en-(US|GB|LR|MM)\b/i;

export function detectLocaleUnits(): UnitSystem {
  if (typeof navigator === "undefined") return "km";
  const lang = navigator.language || "en-US";
  return IMPERIAL_LOCALES.test(lang) ? "mi" : "km";
}

export function resolveUnits(pref: "auto" | "mi" | "km" | undefined | null): UnitSystem {
  if (pref === "mi" || pref === "km") return pref;
  return detectLocaleUnits();
}

export function formatDistance(meters: number, units: UnitSystem): string {
  if (!isFinite(meters) || meters <= 0) return units === "mi" ? "0 mi" : "0 km";
  if (units === "mi") {
    const miles = meters / 1609.344;
    if (miles < 0.1) return `${Math.round(meters * 3.28084)} ft`;
    return `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
  }
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}

export function formatSpeed(kmh: number, units: UnitSystem): { value: number; unit: string } {
  if (units === "mi") return { value: Math.round(kmh * 0.621371), unit: "mph" };
  return { value: Math.round(kmh), unit: "km/h" };
}

/** Hook: resolves the user's unit system. Falls back to locale detection when not signed in / loading. */
export function useUnits(): UnitSystem {
  const getProfileFn = useServerFn(getMyProfile);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => { if (active) setSignedIn(!!data.session); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSignedIn(!!s));
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);
  const { data } = useQuery({
    queryKey: ["my-profile"],
    queryFn: () => getProfileFn(),
    staleTime: 5 * 60_000,
    retry: false,
    enabled: signedIn === true,
  });
  return resolveUnits(data?.units as ("auto" | "mi" | "km" | undefined));
}

