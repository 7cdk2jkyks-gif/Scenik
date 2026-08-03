import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { MapPin, Heart, Mountain, Users } from "lucide-react";
import { Logo } from "@/components/Logo";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { consumeNativeAuthCompleted } from "@/lib/native-auth-transition";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Scenik — take the Scenik route" },
      {
        name: "description",
        content:
          "An AI scenic-route planner. Tell it your mood and your spare time; it plans a drive worth taking.",
      },
    ],
  }),
  component: Landing,
});

function useIsAuthed() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    let mounted = true;
    const nativeCompletion = consumeNativeAuthCompleted();
    console.log("[Auth] home loaded");
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!mounted) return;
        if (error) {
          console.error(
            "[Auth] home session check failed",
            error,
            error.stack ?? "Source line unavailable",
          );
          setAuthed(false);
          return;
        }
        setAuthed(Boolean(data.session?.user));
        if (nativeCompletion) console.log("[Auth] auth context refreshed");
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        const exception = error instanceof Error ? error : new Error(String(error));
        console.error(
          "[Auth] home session check failed",
          exception.message,
          exception.stack ?? "Source line unavailable",
        );
        setAuthed(false);
      });
    return () => {
      mounted = false;
    };
  }, []);
  return authed;
}

function Landing() {
  const authed = useIsAuthed();
  const navigate = useNavigate();

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const oauthReturn =
      query.has("code") || query.has("error") || hash.has("access_token") || hash.has("error");
    if (!oauthReturn) return;

    console.log("[WebAuth] OAuth return detected");
    console.log("[WebAuth] current pathname:", window.location.pathname);
    console.log("[WebAuth] session restore started");
    void supabase.auth.getSession().then(
      ({ data }) => {
        console.log("[WebAuth] session restore completed:", Boolean(data.session));
        const destination = data.session ? "/plan" : "/auth";
        console.log("[WebAuth] redirecting to:", destination);
        void navigate({ to: destination, replace: true }).then(() => {
          console.log("[WebAuth] navigation completed");
        });
      },
      () => {
        console.log("[WebAuth] session restore completed:", false);
        console.log("[WebAuth] redirecting to:", "/auth");
        void navigate({ to: "/auth", replace: true });
      },
    );
  }, [navigate]);

  return (
    <div className="min-h-screen">
      {/* Nav */}
      <header className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-4 py-4 sm:flex sm:justify-between sm:px-6 sm:py-6">
        <Link to="/" className="flex min-w-0 items-center gap-2">
          <Logo className="h-6 w-6 shrink-0 text-primary" />
          <span className="truncate font-serif text-xl font-semibold tracking-tight text-ink">
            Scenik
          </span>
        </Link>
        <nav className="flex shrink-0 items-center gap-1 sm:gap-2">
          <Link to="/community">
            <Button
              variant="ghost"
              size="sm"
              className="px-2 font-medium sm:h-10 sm:px-4 sm:text-sm"
              aria-label="Community"
            >
              <Users className="h-4 w-4 sm:mr-1.5" />
              <span className="hidden sm:inline">Community</span>
            </Button>
          </Link>
          {authed === false && (
            <Link to="/auth">
              <Button variant="ghost" size="sm" className="font-medium sm:h-10 sm:px-4 sm:text-sm">
                Sign in
              </Button>
            </Link>
          )}
          {authed === null ? (
            <Button size="sm" className="shadow-stamp sm:h-10 sm:px-4 sm:text-sm" disabled>
              Checking account…
            </Button>
          ) : (
            <Link to="/plan">
              <Button size="sm" className="shadow-stamp sm:h-10 sm:px-4 sm:text-sm">
                <span className="sm:hidden">{authed ? "Continue" : "Plan"}</span>
                <span className="hidden sm:inline">{authed ? "Continue" : "Plan a drive"}</span>
              </Button>
            </Link>
          )}
        </nav>
      </header>

      <section className="mx-auto max-w-3xl px-4 pt-10 pb-16 text-center sm:px-6 sm:pt-12 sm:pb-20">
        <h1 className="mt-6 font-serif text-4xl font-semibold leading-[1.05] tracking-tight text-ink sm:text-5xl md:text-6xl lg:text-7xl">
          Take the
          <br />
          <span className="italic text-primary">Scenik route.</span>
        </h1>
        <p className="mx-auto mt-5 max-w-md text-base text-muted-foreground sm:mt-6 sm:text-lg">
          Tell Scenik your mood, your theme, and how many extra minutes you'll spare. We'll thread
          the prettiest drive between A and B — and score it out of 100.
        </p>
        <div className="mt-7 flex flex-col items-stretch justify-center gap-3 sm:mt-8 sm:flex-row sm:items-center">
          {authed === null ? (
            <Button size="lg" className="w-full shadow-stamp sm:w-auto" disabled>
              Checking account…
            </Button>
          ) : (
            <Link to="/plan" className="sm:w-auto">
              <Button size="lg" className="w-full shadow-stamp sm:w-auto">
                Plan my drive
              </Button>
            </Link>
          )}
          <Link to="/community" className="sm:w-auto">
            <Button size="lg" variant="outline" className="w-full sm:w-auto">
              <Users className="h-4 w-4 mr-2" />
              Browse community
            </Button>
          </Link>
        </div>

        <ul className="mx-auto mt-12 grid max-w-2xl gap-3 text-sm text-muted-foreground sm:grid-cols-3">
          {[
            { icon: Heart, t: "Mood-led", d: "Romantic, adventurous, melancholic." },
            { icon: Mountain, t: "Themed", d: "Historic, coastal, forested, foodie." },
            { icon: MapPin, t: "Scored", d: "Every route, rated /100." },
          ].map((f) => (
            <li
              key={f.t}
              className="rounded-2xl border border-border bg-card p-4 text-left shadow-paper"
            >
              <f.icon className="mb-2 h-4 w-4 text-primary" />
              <div className="font-serif text-base font-semibold text-ink">{f.t}</div>
              <div className="text-xs">{f.d}</div>
            </li>
          ))}
        </ul>
      </section>

      {/* How */}
      <section className="border-t border-border bg-parchment/60">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-14 sm:gap-10 sm:px-6 sm:py-20 md:grid-cols-3">
          {[
            {
              n: "01",
              t: "Where & when",
              d: "Drop a start and end, and how many extra minutes you can spare.",
            },
            {
              n: "02",
              t: "How it should feel",
              d: "Pick a mood and a theme — romantic coastal, adventurous historic, anything.",
            },
            {
              n: "03",
              t: "Drive it",
              d: "We thread real waypoints between A and B with a scenic score and highlights.",
            },
          ].map((s) => (
            <div key={s.n}>
              <div className="font-serif text-xs font-semibold uppercase tracking-[0.3em] text-primary">
                {s.n}
              </div>
              <h3 className="mt-3 font-serif text-2xl font-semibold text-ink">{s.t}</h3>
              <p className="mt-2 text-muted-foreground">{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 text-xs text-muted-foreground sm:px-6 sm:py-8 sm:text-sm">
          <nav className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Link to="/pricing" className="hover:text-ink">
              Pricing
            </Link>
            <Link to="/terms" className="hover:text-ink">
              Terms
            </Link>
            <Link to="/privacy" className="hover:text-ink">
              Privacy
            </Link>
            <Link to="/refund" className="hover:text-ink">
              Refunds
            </Link>
            <Link to="/community" className="hover:text-ink">
              Community
            </Link>
          </nav>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-serif italic">Scenik · take the Scenik route.</span>
            <span>© {new Date().getFullYear()}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
