import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { bootstrapAnalytics, identify, reset, pageview } from "@/lib/analytics/client";
import { ConsentBanner } from "@/components/ConsentBanner";

/**
 * Mounts PostHog (respecting stored consent), wires auth-state → identify/reset,
 * and captures pageviews on TanStack Router navigation.
 *
 * Renders the strict-GDPR opt-in banner as a sibling.
 */
export function AnalyticsProvider() {
  const router = useRouter();

  // Bootstrap once, then hook auth state.
  useEffect(() => {
    bootstrapAnalytics();

    // Identify the current user if a session already exists.
    supabase.auth.getUser().then(({ data }) => {
      const u = data.user;
      if (u) identify(u.id, { email_domain: u.email?.split("@")[1] });
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if ((event === "SIGNED_IN" || event === "USER_UPDATED") && session?.user) {
        identify(session.user.id, { email_domain: session.user.email?.split("@")[1] });
      }
      if (event === "SIGNED_OUT") reset();
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Client-side pageviews on route change.
  useEffect(() => {
    // Initial view
    pageview(window.location.pathname);
    const unsub = router.subscribe("onResolved", ({ toLocation }) => {
      pageview(toLocation.pathname);
    });
    return () => unsub();
  }, [router]);

  return <ConsentBanner />;
}
