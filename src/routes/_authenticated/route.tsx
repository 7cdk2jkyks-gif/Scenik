import { createFileRoute, Outlet, redirect, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { LogOut, Map, Users, Settings, Crown, Navigation } from "lucide-react";

import { Logo } from "@/components/Logo";
import { useQueryClient } from "@tanstack/react-query";
import { useSubscription } from "@/hooks/useSubscription";
import { TermsGate } from "@/components/TermsGate";
import { capture } from "@/lib/analytics/client";
import { AnalyticsEvent } from "@/lib/analytics/events";
import { isNativePlatform } from "@/lib/native";

const OAUTH_RESTORE_TIMEOUT_MS = 2_000;

function isOAuthReturn(): boolean {
  if (typeof window === "undefined") return false;
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.slice(1));
  return query.has("code") || query.has("error") || hash.has("access_token") || hash.has("error");
}

async function restoreBrowserOAuthSession() {
  console.log("[WebAuth] session restore started");
  const initial = await supabase.auth.getSession();
  if (initial.error || initial.data.session) {
    console.log("[WebAuth] session restore completed:", Boolean(initial.data.session));
    return initial;
  }

  const restored = await new Promise<typeof initial>((resolve) => {
    let settled = false;
    const finish = (result: typeof initial) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      subscription.subscription.unsubscribe();
      resolve(result);
    };
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) finish({ data: { session }, error: null });
    });
    const timeout = window.setTimeout(() => {
      void supabase.auth.getSession().then(finish);
    }, OAUTH_RESTORE_TIMEOUT_MS);
  });
  console.log("[WebAuth] session restore completed:", Boolean(restored.data.session));
  return restored;
}

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    console.log("[WebAuth] /plan guard started");
    const oauthReturn = isOAuthReturn();
    if (oauthReturn) console.log("[WebAuth] OAuth return detected");
    if (typeof window !== "undefined")
      console.log("[WebAuth] current pathname:", window.location.pathname);
    const { data: sessionData, error } = oauthReturn
      ? await restoreBrowserOAuthSession()
      : await supabase.auth.getSession();
    console.log("[WebAuth] /plan guard session:", Boolean(sessionData.session));
    if (error) {
      console.error(
        "[Auth] /plan client session check failed",
        error.message,
        error.stack ?? "Source line unavailable",
      );
      throw error;
    }
    if (sessionData.session?.user) {
      console.log("[Auth] /plan auth check resolved from session");
      console.log("[WebAuth] navigation completed");
      return { user: sessionData.session.user };
    }
    console.log("[Auth] /plan auth check redirected to /auth");
    console.log("[WebAuth] redirecting to:", "/auth");
    throw redirect({ to: "/auth" });
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const sub = useSubscription();
  const isPremium = sub.data?.isPremium ?? false;
  const user = Route.useRouteContext().user as { id?: string; is_anonymous?: boolean } | undefined;
  const isGuest = user?.is_anonymous === true;

  // On native (iOS/Android), configure RevenueCat with the signed-in user id
  // so purchases and entitlements are attached to the correct account.
  useEffect(() => {
    if (!isNativePlatform() || !user?.id || isGuest) return;
    void import("@/lib/revenuecat").then((m) => m.configureRevenueCat(user.id!));
  }, [user?.id, isGuest]);

  async function signOut() {
    capture(AnalyticsEvent.UserSignedOut, { source: "nav_header" });
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div
      className="min-h-screen pb-20"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
        paddingBottom: "calc(5rem + env(safe-area-inset-bottom))",
      }}
    >
      <header className="border-b border-border bg-card/70 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <Link to="/" aria-label="Home" className="flex min-w-0 items-center gap-2">
            <Logo className="h-5 w-5 shrink-0 text-primary" />
            <span className="truncate font-serif text-lg font-semibold text-ink">Scenik</span>
          </Link>
          <div className="flex items-center gap-1">
            <Link to="/pricing">
              <Button
                variant="ghost"
                size="sm"
                className={isPremium ? "text-primary" : "text-muted-foreground"}
                aria-label={isPremium ? "Manage Premium" : "View Premium"}
              >
                <Crown className="h-4 w-4" />
                <span className="hidden sm:inline">{isPremium ? "Premium" : "Upgrade"}</span>
              </Button>
            </Link>
            <Button
              variant="ghost"
              size="sm"
              onClick={signOut}
              title={isGuest ? "Exit guest" : "Sign out"}
              aria-label={isGuest ? "Exit guest session" : "Sign out"}
              className="px-3"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>
      {isGuest && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs text-amber-900 sm:text-sm">
          You're browsing as a guest.{" "}
          <Link to="/auth" className="font-medium underline">
            Create an account
          </Link>{" "}
          to save routes across devices.
        </div>
      )}
      <Outlet />
      {!isGuest && <TermsGate />}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 backdrop-blur"
      >
        <div className="mx-auto grid max-w-lg grid-cols-4 items-center gap-1 px-2 pb-[max(0.35rem,env(safe-area-inset-bottom))] pt-1.5 sm:px-6">
          <Link to="/plan" className="flex-1">
            {({ isActive }) => (
              <Button
                variant={isActive ? "secondary" : "ghost"}
                size="sm"
                className="h-auto w-full flex-col gap-0.5 rounded-xl px-2 py-1.5 text-[10px] sm:flex-row sm:gap-1.5 sm:text-xs"
                aria-label="Plan"
              >
                <Navigation className="h-4 w-4 sm:mr-1.5" />
                <span>Plan</span>
              </Button>
            )}
          </Link>
          <Link to="/routes" className="flex-1">
            {({ isActive }) => (
              <Button
                variant={isActive ? "secondary" : "ghost"}
                size="sm"
                className="h-auto w-full flex-col gap-0.5 rounded-xl px-2 py-1.5 text-[10px] sm:flex-row sm:gap-1.5 sm:text-xs"
                aria-label="My routes"
              >
                <Map className="h-4 w-4" />
                <span>Routes</span>
              </Button>
            )}
          </Link>
          <Link to="/community" className="flex-1">
            {({ isActive }) => (
              <Button
                variant={isActive ? "secondary" : "ghost"}
                size="sm"
                className="h-auto w-full flex-col gap-0.5 rounded-xl px-2 py-1.5 text-[10px] sm:flex-row sm:gap-1.5 sm:text-xs"
                aria-label="Explore community routes"
              >
                <Users className="h-4 w-4" />
                <span>Explore</span>
              </Button>
            )}
          </Link>
          <Link to="/settings" className="flex-1">
            {({ isActive }) => (
              <Button
                variant={isActive ? "secondary" : "ghost"}
                size="sm"
                className="h-auto w-full flex-col gap-0.5 rounded-xl px-2 py-1.5 text-[10px] sm:flex-row sm:gap-1.5 sm:text-xs"
                aria-label="Settings"
              >
                <Settings className="h-4 w-4" />
                <span>Settings</span>
              </Button>
            )}
          </Link>
        </div>
      </nav>
    </div>
  );
}
