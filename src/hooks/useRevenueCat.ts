import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { isNativePlatform } from "@/lib/native";
import {
  getCurrentOffering,
  getPremiumState,
  initRevenueCat,
  rcLogIn,
  rcLogOut,
  type RCOffering,
  type RCPremiumState,
} from "@/lib/revenuecat";

const EMPTY_STATE: RCPremiumState = {
  isPremium: false,
  willRenew: false,
  expirationDate: null,
  productIdentifier: null,
  managementURL: null,
};

/**
 * Bootstraps RevenueCat once per app session on native platforms:
 * - configure() with the user's stable Supabase UUID (or anonymous)
 * - logIn on SIGNED_IN, logOut on SIGNED_OUT
 * - refresh CustomerInfo on foreground
 *
 * Safe no-op on web.
 */
export function useRevenueCatBootstrap() {
  const qc = useQueryClient();
  useEffect(() => {
    if (!isNativePlatform()) return;
    let unsubbed = false;

    (async () => {
      const { data } = await supabase.auth.getUser();
      const u = data.user;
      const stableId = u && !(u as { is_anonymous?: boolean }).is_anonymous ? u.id : undefined;
      if (unsubbed) return;
      await initRevenueCat(stableId);
      qc.invalidateQueries({ queryKey: ["rc-premium"] });
    })();

    const { data: authSub } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user;
      const stableId = u && !(u as { is_anonymous?: boolean }).is_anonymous ? u.id : undefined;
      if (event === "SIGNED_IN" || event === "USER_UPDATED") {
        if (stableId) void rcLogIn(stableId);
      } else if (event === "SIGNED_OUT") {
        void rcLogOut();
      }
      qc.invalidateQueries({ queryKey: ["rc-premium"] });
    });

    // Refresh entitlement whenever the tab/app returns to the foreground.
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        qc.invalidateQueries({ queryKey: ["rc-premium"] });
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      unsubbed = true;
      authSub.subscription.unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [qc]);
}

export function useRCPremium() {
  return useQuery<RCPremiumState>({
    queryKey: ["rc-premium"],
    queryFn: async () => (isNativePlatform() ? await getPremiumState() : EMPTY_STATE),
    enabled: isNativePlatform(),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    initialData: EMPTY_STATE,
  });
}

export function useRCOffering() {
  return useQuery<RCOffering | null>({
    queryKey: ["rc-offering"],
    queryFn: async () => (isNativePlatform() ? await getCurrentOffering() : null),
    enabled: isNativePlatform(),
    staleTime: 5 * 60_000,
  });
}
