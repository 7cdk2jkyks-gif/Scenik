import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";
import { toast } from "sonner";
import { Logo } from "@/components/Logo";
import { AppleSignInButton } from "@/components/AppleSignInButton";
import { capture } from "@/lib/analytics/client";
import { AnalyticsEvent } from "@/lib/analytics/events";
import { canUseNativeAuth, nativeSignIn } from "@/lib/native-auth";
import { getPublicOrigin, isNativePlatform, isIOS } from "@/lib/native";
import { exchangeNativeGoogleToken } from "@/lib/native-google.functions";
import { markNativeAuthCompleted, restoreNativeSession } from "@/lib/native-auth-transition";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — Scenik" },
      { name: "description", content: "Sign in to save and revisit your scenic drives." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const googleBridge = useServerFn(exchangeNativeGoogleToken);
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  // `loading` is ONLY ever set by an explicit user interaction. Nothing on
  // mount — native or web — may set it true.
  const [loading, setLoading] = useState(false);
  const [loadingSource, setLoadingSource] = useState<string>("none");
  const [authError, setAuthError] = useState<string | null>(null);
  const [debug, setDebug] = useState<string[]>([]);

  function startLoading(source: string) {
    setLoadingSource(source);
    setLoading(true);
  }
  function stopLoading() {
    setLoading(false);
    setLoadingSource("none");
  }
  function log(line: string) {
    console.log("[Auth]", line);
    setDebug((d) => [...d.slice(-8), line]);
  }

  function reportStageFailure(stage: string, error: unknown) {
    const exception = error instanceof Error ? error : new Error(String(error));
    const detail = `${stage} failed: ${exception.message}\n${exception.stack ?? "Source line unavailable"}`;
    console.error(`[Auth] ${detail}`);
    setAuthError(detail);
    setDebug((current) => [...current.slice(-8), detail]);
    toast.error(`${stage} failed: ${exception.message}`);
  }

  function withAuthTimeout<T>(promise: PromiseLike<T>, label: string, ms = 30_000): Promise<T> {
    return Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out. Please try again.`)), ms),
      ),
    ]);
  }

  useEffect(() => {
    let cancelled = false;
    const native = isNativePlatform();
    // Defensive: nothing may leave a persisted "loading" flag behind.
    try {
      for (const store of [window.localStorage, window.sessionStorage]) {
        for (const key of Object.keys(store)) {
          if (/auth[-_.]?loading|scenik[-_.]?loading|pending[-_.]?auth/i.test(key))
            store.removeItem(key);
        }
      }
    } catch {
      /* storage unavailable */
    }
    setLoading(false);
    setLoadingSource("none");
    log(`native platform detected: ${native ? (isIOS() ? "ios" : "android") : "no (web)"}`);
    log("auth page mounted");

    // Passive session restore. Never touches the loading state, always bounded,
    // always resolves — failure leaves every sign-in option enabled.
    log("session restore started");
    const restore = native
      ? restoreNativeSession("auth page")
      : withAuthTimeout(supabase.auth.getSession(), "Session restore", 8_000).then(
          ({ data }) => data.session,
        );
    restore
      .then((session) => {
        if (cancelled) return;
        log(`session restore completed (session: ${session ? "yes" : "no"})`);
      })
      .catch((err) => {
        if (cancelled) return;
        log(
          `session restore timed out or failed: ${err instanceof Error ? err.message : "unknown"}`,
        );
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setLoadingSource("none");
      });

    return () => {
      cancelled = true;
    };
  }, [navigate]);

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!acceptedTerms) {
      toast.error("Please accept the Terms & Conditions to continue.");
      return;
    }

    startLoading("email");
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: getPublicOrigin() + "/auth" },
        });
        if (error) throw error;
        capture(AnalyticsEvent.UserSignedUp, { method: "email" });
        toast.success("Account created. Check your email if confirmation is required.");
        navigate({ to: "/plan" });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        capture(AnalyticsEvent.UserSignedIn, { method: "email" });
        navigate({ to: "/plan" });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      stopLoading();
    }
  }

  async function handleOAuth(provider: "google" | "apple") {
    console.log(`[Auth] ${provider === "google" ? "Google" : "Apple"} button tapped`);
    if (!acceptedTerms) {
      toast.error("Please accept the Terms & Conditions to continue.");
      return;
    }

    setAuthError(null);
    startLoading(provider);
    try {
      log(`${provider} OAuth started (user interaction)`);
      // On iOS/Android, use the native sign-in sheet so users never leave the app.
      if (canUseNativeAuth(provider)) {
        const result = await nativeSignIn(
          provider,
          provider === "google" ? googleBridge : undefined,
        );
        log(`[${result.requestId}] ${provider} native result received`);
        log(`[${result.requestId}] Supabase session confirmed`);
        capture(mode === "signup" ? AnalyticsEvent.UserSignedUp : AnalyticsEvent.UserSignedIn, {
          method: provider,
        });
        stopLoading();
        log(`[${result.requestId}] loading cleared`);
        markNativeAuthCompleted();
        log(`[${result.requestId}] home/root auth refresh requested`);
        log(`[${result.requestId}] navigation to /plan started`);
        console.log(`[Auth][${result.requestId}] RevenueCat identification started`);
        void import("@/lib/revenuecat")
          .then((module) => module.configureRevenueCat(result.session.user.id))
          .then(() => log(`[${result.requestId}] RevenueCat identification completed`))
          .catch((error: unknown) =>
            console.warn(
              `[Auth][${result.requestId}] RevenueCat identification non-fatal failure`,
              error instanceof Error ? error.message : "unknown error",
            ),
          );
        void navigate({ to: "/plan", replace: true }).then(
          () => log(`[${result.requestId}] navigation to /plan completed`),
          (error: unknown) =>
            console.warn(
              `[Auth][${result.requestId}] post-auth navigation failed`,
              error instanceof Error ? error.message : "unknown error",
            ),
        );
        return;
      }

      if (provider === "google") {
        console.log("[WebAuth] Google OAuth started");
        const { error } = await supabase.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: getPublicOrigin() + "/plan" },
        });
        if (error) throw error;
        return;
      }

      console.log("[Auth] platform: web");
      console.log("[Auth] provider and selected flow:", provider, "lovable-broker");
      console.log("[Auth] token exchange started (web)");
      const res = await withAuthTimeout(
        lovable.auth.signInWithOAuth(provider, {
          redirect_uri: getPublicOrigin() + "/auth",
        }),
        `${provider === "apple" ? "Apple" : "Google"} OAuth`,
      );
      if (res.error) {
        const msg =
          res.error.message || `${provider === "apple" ? "Apple" : "Google"} sign-in failed`;
        console.log("[Auth] token exchange error:", msg);
        setAuthError(msg);
        toast.error(msg);
        return;
      }
      if (res.redirected) return;
      console.log("[Auth] token exchange success (web)");
      console.log("[Auth] session created");
      capture(mode === "signup" ? AnalyticsEvent.UserSignedUp : AnalyticsEvent.UserSignedIn, {
        method: provider,
      });
      console.log("[Auth] navigation to /plan");
      navigate({ to: "/plan" });
    } catch (err) {
      reportStageFailure(provider === "apple" ? "Apple sign-in" : "Google sign-in", err);
    } finally {
      stopLoading();
      console.log("[Auth] loading state cleared");
    }
  }

  return (
    <div className="app-screen keyboard-scroll flex items-start justify-center overflow-y-auto px-4 py-5 sm:items-center sm:px-6 sm:py-12">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-5 flex items-center justify-center gap-2 sm:mb-8">
          <Logo className="h-6 w-6 text-primary" />
          <span className="font-serif text-xl font-semibold text-ink">Scenik</span>
        </Link>

        <Card className="border-border bg-card p-4 shadow-paper sm:p-8">
          <h1 className="font-serif text-2xl font-semibold text-ink sm:text-3xl">
            {mode === "signin" ? "Welcome back" : "Begin your Scenik"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "signin"
              ? "Sign in to plan and save scenic drives."
              : "Create an account to save your drives."}
          </p>

          <label className="mt-5 flex items-start gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={acceptedTerms}
              onChange={(e) => setAcceptedTerms(e.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 rounded border-border accent-primary"
            />
            <span className="leading-snug">
              I agree to the{" "}
              <Link to="/terms" target="_blank" className="text-primary underline">
                Terms &amp; Conditions
              </Link>{" "}
              and{" "}
              <Link to="/privacy" target="_blank" className="text-primary underline">
                Privacy Notice
              </Link>
              .
            </span>
          </label>

          <Button
            type="button"
            variant="outline"
            className="mt-6 w-full"
            onClick={() => handleOAuth("google")}
            disabled={loading}
          >
            <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" aria-hidden>
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.75 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.99.66-2.25 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.11A6.6 6.6 0 0 1 5.48 12c0-.73.13-1.45.36-2.11V7.05H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.95l3.66-2.84z"
              />
              <path
                fill="#EA4335"
                d="M12 4.97c1.62 0 3.06.56 4.21 1.65l3.15-3.15C17.45 1.62 14.97.58 12 .58 7.7.58 3.99 3.04 2.18 7.05l3.66 2.84C6.71 6.9 9.14 4.97 12 4.97z"
              />
            </svg>
            Continue with Google
          </Button>

          <AppleSignInButton onClick={() => handleOAuth("apple")} disabled={loading} />

          {authError && (
            <p className="mt-3 whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {authError}
            </p>
          )}

          <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-widest text-muted-foreground">
            <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
          </div>

          <form onSubmit={handleEmail} className="space-y-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full shadow-stamp" disabled={loading}>
              {loading ? "Just a moment…" : mode === "signin" ? "Sign in" : "Create account"}
            </Button>
          </form>

          <button
            type="button"
            onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            className="mt-6 w-full text-center text-sm text-muted-foreground hover:text-primary"
          >
            {mode === "signin"
              ? "Don't have an account? Sign up"
              : "Already have an account? Sign in"}
          </button>

          <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-widest text-muted-foreground">
            <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
          </div>

          <Button
            type="button"
            variant="ghost"
            className="w-full"
            disabled={loading}
            onClick={async () => {
              if (!acceptedTerms) {
                toast.error("Please accept the Terms & Conditions to continue.");
                return;
              }
              startLoading("guest");
              try {
                const { error } = await supabase.auth.signInAnonymously();
                if (error) throw error;
                capture(AnalyticsEvent.UserSignedIn, { method: "guest" });
                toast.success("You're in — try Scenik as a guest.");
                navigate({ to: "/plan" });
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Couldn't start guest session");
              } finally {
                stopLoading();
              }
            }}
          >
            Continue as guest
          </Button>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            No account needed. Create one later to save routes across devices.
          </p>
        </Card>

        {/* Temporary native diagnostics — remove once iOS sign-in is confirmed. */}
        <div className="mt-4 rounded-md border border-border bg-muted/40 p-3 text-[11px] leading-snug text-muted-foreground">
          <div className="font-semibold">Debug</div>
          <div>
            loading: {String(loading)} · source: {loadingSource}
          </div>
          {debug.map((line, i) => (
            <div key={i}>· {line}</div>
          ))}
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          <Link to="/privacy" className="hover:text-primary">
            Privacy
          </Link>
          {" · "}
          <Link to="/terms" className="hover:text-primary">
            Terms
          </Link>
          {" · "}
          <Link to="/delete-account" className="hover:text-primary">
            Delete account
          </Link>
        </p>
      </div>
    </div>
  );
}
