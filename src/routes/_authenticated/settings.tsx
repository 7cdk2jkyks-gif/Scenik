import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getMyProfile, updateMyProfile } from "@/lib/profiles.functions";
import { deleteMyAccount } from "@/lib/account.functions";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Settings as SettingsIcon,
  Ruler,
  Award,
  Crown,
  ExternalLink,
  Loader2,
  LogOut,
  Trash2,
  ShieldAlert,
  RefreshCw,
  ShieldCheck,
  Volume2,
} from "lucide-react";
import { detectLocaleUnits } from "@/lib/units";
import { getMyBadges, getCustomerPortalUrl, restorePurchases } from "@/lib/payments.functions";
import { useSubscription, useUsage } from "@/hooks/useSubscription";
import { getPaddleEnvironment } from "@/lib/paddle";
import { BadgeGrid } from "@/components/BadgeGrid";
import { capture, reset as resetAnalytics } from "@/lib/analytics/client";
import { AnalyticsEvent } from "@/lib/analytics/events";
import {
  loadNarrationPreferences,
  saveNarrationPreferences,
  type NarrationPreferences,
  type NarrationMode,
  type NarrationVoiceStyle,
} from "@/lib/scenic-narration";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const qc = useQueryClient();
  const getFn = useServerFn(getMyProfile);
  const updateFn = useServerFn(updateMyProfile);
  const { data, isLoading } = useQuery({ queryKey: ["my-profile"], queryFn: () => getFn() });

  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [units, setUnits] = useState<"auto" | "mi" | "km">("auto");
  const subscription = useSubscription();
  const isPremium = !!subscription.data?.isPremium;
  const [narration, setNarration] = useState<NarrationPreferences>(() =>
    loadNarrationPreferences(typeof window === "undefined" ? null : window.localStorage),
  );
  const displayedNarrationMode =
    narration.mode === "full" && !isPremium ? "highlights" : narration.mode;
  const updateNarration = (next: NarrationPreferences) => {
    setNarration(next);
    try {
      saveNarrationPreferences(next, localStorage);
    } catch {
      toast.error("Narration settings could not be saved on this device.");
    }
  };
  useEffect(() => {
    if (!data) return;
    setDisplayName(data.display_name ?? "");
    setBio(data.bio ?? "");
    setUnits((data.units as "auto" | "mi" | "km") ?? "auto");
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      updateFn({ data: { display_name: displayName.trim(), bio: bio.trim(), units } }),
    onSuccess: () => {
      toast.success("Settings saved");
      qc.invalidateQueries({ queryKey: ["my-profile"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const detected = detectLocaleUnits();

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="flex items-center gap-2 font-serif text-2xl font-semibold text-ink sm:text-3xl">
        <SettingsIcon className="h-6 w-6 text-primary" /> Settings
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Your public profile and unit preferences.
      </p>

      {isLoading ? (
        <p className="mt-8 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <Card className="mt-6 border-border bg-card p-5 shadow-paper sm:p-6">
          <h2 className="font-serif text-base font-semibold text-ink">Public profile</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Shown next to any routes or comments you share.
          </p>

          <div className="mt-4 space-y-4">
            <div>
              <Label htmlFor="display_name">Display name</Label>
              <Input
                id="display_name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value.slice(0, 60))}
                placeholder="e.g. Coastal Wanderer"
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="bio">Bio</Label>
              <Textarea
                id="bio"
                value={bio}
                onChange={(e) => setBio(e.target.value.slice(0, 280))}
                placeholder="A line or two about the kind of drives you love…"
                rows={3}
                className="mt-1.5"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">{bio.length}/280</p>
            </div>
          </div>

          <div className="mt-6 border-t border-border pt-5">
            <h2 className="flex items-center gap-2 font-serif text-base font-semibold text-ink">
              <Ruler className="h-4 w-4 text-primary" /> Units
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              How distances and speeds are shown across the app.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {[
                {
                  id: "auto" as const,
                  label: "Auto",
                  hint: `Detected: ${detected === "mi" ? "Miles" : "Kilometres"}`,
                },
                { id: "mi" as const, label: "Miles", hint: "mi · mph · ft" },
                { id: "km" as const, label: "Kilometres", hint: "km · km/h · m" },
              ].map((opt) => {
                const active = units === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setUnits(opt.id)}
                    className={`rounded-xl border p-3 text-left transition ${
                      active
                        ? "border-primary bg-primary/5"
                        : "border-border bg-background hover:border-primary/40"
                    }`}
                  >
                    <div
                      className={`font-serif text-sm font-semibold ${active ? "text-primary" : "text-ink"}`}
                    >
                      {opt.label}
                    </div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">{opt.hint}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-6 border-t border-border pt-5">
            <h2 className="flex items-center gap-2 font-serif text-base font-semibold text-ink">
              <Volume2 className="h-4 w-4 text-primary" /> Journey Narration
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Discovery stories use your device&apos;s local voice. Turn guidance always takes
              priority.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {[
                { id: "off" as NarrationMode, label: "Off", hint: "Turn guidance only" },
                {
                  id: "highlights" as NarrationMode,
                  label: "Highlights",
                  hint: "A calm, occasional guide",
                },
                {
                  id: "full" as NarrationMode,
                  label: "Full Guide",
                  hint: isPremium ? "More discoveries" : "Premium — coming soon",
                },
              ].map((option) => {
                const locked = option.id === "full" && !isPremium;
                const active = displayedNarrationMode === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    disabled={locked}
                    onClick={() => updateNarration({ ...narration, mode: option.id })}
                    className={`rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-55 ${active ? "border-primary bg-primary/5" : "border-border bg-background hover:border-primary/40"}`}
                  >
                    <div
                      className={`font-serif text-sm font-semibold ${active ? "text-primary" : "text-ink"}`}
                    >
                      {option.label}
                    </div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">{option.hint}</div>
                  </button>
                );
              })}
            </div>

            <Label className="mt-5 block">Voice</Label>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {[
                { id: "default" as NarrationVoiceStyle, label: "Default" },
                { id: "calm" as NarrationVoiceStyle, label: "Calm" },
                { id: "warm" as NarrationVoiceStyle, label: "Warm" },
              ].map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => updateNarration({ ...narration, voice: option.id })}
                  className={`rounded-xl border px-3 py-2 text-sm font-medium transition ${narration.voice === option.id ? "border-primary bg-primary/5 text-primary" : "border-border bg-background text-ink hover:border-primary/40"}`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="mt-5">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="narration-volume">Narration volume</Label>
                <span className="text-xs text-muted-foreground">
                  {Math.round(narration.volume * 100)}%
                </span>
              </div>
              <input
                id="narration-volume"
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={narration.volume}
                disabled={narration.mode === "off"}
                onChange={(event) =>
                  updateNarration({ ...narration, volume: Number(event.target.value) })
                }
                className="mt-2 w-full accent-primary disabled:opacity-50"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">
                Device mute and accessibility settings are always respected.
              </p>
            </div>
          </div>

          <div className="mt-6 flex justify-end">
            <Button
              onClick={() => save.mutate()}
              disabled={save.isPending || !displayName.trim()}
              className="shadow-stamp"
            >
              {save.isPending ? "Saving…" : "Save settings"}
            </Button>
          </div>
        </Card>
      )}

      <SubscriptionSection />
      <BadgesSection />
      <PrivacySection />
      <DangerZone />
    </div>
  );
}

function PrivacySection() {
  return (
    <Card className="mt-6 border-border bg-card p-5 shadow-paper sm:p-6">
      <h2 className="flex items-center gap-2 font-serif text-base font-semibold text-ink">
        <ShieldCheck className="h-4 w-4 text-primary" /> Privacy &amp; location
      </h2>
      <p className="mt-2 text-sm text-ink/85">
        We use your location only to provide navigation and route guidance. Scenik does not store
        detailed location history or track your movements after navigation ends.
      </p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        <li>Live GPS is used in-session for turn-by-turn guidance and rerouting.</li>
        <li>We do not persist raw GPS coordinates after navigation ends.</li>
        <li>No continuous GPS tracks or background location history are collected.</li>
        <li>
          Analytics never receive precise coordinates — only aggregate events like route generated,
          started, completed.
        </li>
        <li>You can opt out of analytics any time from the consent banner.</li>
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">
        Read the full{" "}
        <Link to="/privacy" className="text-primary underline">
          Privacy Notice
        </Link>
        .
      </p>
    </Card>
  );
}

function DangerZone() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const deleteFn = useServerFn(deleteMyAccount);
  const [confirmText, setConfirmText] = useState("");
  const [signingOut, setSigningOut] = useState(false);

  const del = useMutation({
    mutationFn: () => deleteFn(),
    onSuccess: async () => {
      capture(AnalyticsEvent.AccountDeleted);
      toast.success("Your account has been deleted.");
      await qc.cancelQueries();
      qc.clear();
      resetAnalytics();
      await supabase.auth.signOut();
      navigate({ to: "/auth", replace: true });
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not delete account"),
  });

  async function handleSignOut() {
    setSigningOut(true);
    try {
      capture(AnalyticsEvent.UserSignedOut, { source: "settings" });
      await qc.cancelQueries();
      qc.clear();
      await supabase.auth.signOut();
      navigate({ to: "/auth", replace: true });
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <Card className="mt-6 border-destructive/40 bg-card p-5 shadow-paper sm:p-6">
      <h2 className="flex items-center gap-2 font-serif text-base font-semibold text-ink">
        <ShieldAlert className="h-4 w-4 text-destructive" /> Account
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Sign out on this device, or permanently delete your account.
      </p>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Button variant="outline" onClick={handleSignOut} disabled={signingOut}>
          {signingOut ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <LogOut className="mr-2 h-4 w-4" />
          )}
          Sign out
        </Button>

        <AlertDialog onOpenChange={(o) => !o && setConfirmText("")}>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">
              <Trash2 className="mr-2 h-4 w-4" /> Delete account
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete your account?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently deletes your profile, saved routes, and all associated data. This
                action cannot be undone. Type <strong>DELETE</strong> to confirm.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="Type DELETE to confirm"
              autoFocus
            />
            <AlertDialogFooter>
              <AlertDialogCancel disabled={del.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  del.mutate();
                }}
                disabled={confirmText !== "DELETE" || del.isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {del.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="mr-2 h-4 w-4" />
                )}
                Delete permanently
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </Card>
  );
}

function SubscriptionSection() {
  const qc = useQueryClient();
  const sub = useSubscription();
  const usage = useUsage();
  const portalFn = useServerFn(getCustomerPortalUrl);
  const restoreFn = useServerFn(restorePurchases);
  const [portalLoading, setPortalLoading] = useState(false);
  const isPremium = sub.data?.isPremium ?? false;
  const isNativePremium = sub.isNative && !!sub.rc?.isPremium;

  const restore = useMutation({
    mutationFn: async () => {
      // On native, ask the store first so RC updates the entitlement.
      if (sub.isNative) {
        const { restoreRC } = await import("@/lib/revenuecat");
        const state = await restoreRC();
        await qc.invalidateQueries({ queryKey: ["rc-premium"] });
        if (state.isPremium) return { restored: true as const };
      }
      return restoreFn({ data: { environment: getPaddleEnvironment() } });
    },
    onSuccess: (result) => {
      if (result?.restored) {
        toast.success("Subscription restored — welcome back to Premium!");
        qc.invalidateQueries({ queryKey: ["subscription", getPaddleEnvironment()] });
      } else if (result?.reason === "no_customer") {
        toast.error("No Paddle customer found for this email.");
      } else if (result?.reason === "no_subscription") {
        toast.error("No active subscription found to restore.");
      } else if (result?.reason === "missing_product_info") {
        toast.error("Subscription data is incomplete. Please contact support.");
      } else {
        toast.error("Could not restore purchases.");
      }
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not restore purchases"),
  });

  async function openPortal() {
    // Native purchases must be managed via Apple/Google, not a web portal.
    if (isNativePremium) {
      const url = sub.rc?.managementURL ?? "https://apps.apple.com/account/subscriptions";
      window.open(url, "_blank");
      return;
    }
    setPortalLoading(true);
    try {
      const url = await portalFn({ data: { environment: getPaddleEnvironment() } });
      window.open(url, "_blank");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Could not open portal");
    } finally {
      setPortalLoading(false);
    }
  }

  return (
    <Card className="mt-6 border-border bg-card p-5 shadow-paper sm:p-6">
      <h2 className="flex items-center gap-2 font-serif text-base font-semibold text-ink">
        <Crown className="h-4 w-4 text-primary" /> Plan
      </h2>
      {isPremium ? (
        <>
          <p className="mt-1 text-xs text-muted-foreground">
            You're on <strong className="text-ink">Scenik Premium</strong> — unlimited routes and
            all features unlocked.
          </p>
          <Button variant="outline" onClick={openPortal} disabled={portalLoading} className="mt-3">
            {portalLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <ExternalLink className="mr-2 h-4 w-4" />
            )}
            {isNativePremium ? "Manage in App Store" : "Manage subscription"}
          </Button>
        </>
      ) : (
        <>
          <p className="mt-1 text-xs text-muted-foreground">
            You're on <strong className="text-ink">Free</strong>
            {usage.data
              ? ` — ${usage.data.generationsThisMonth} of ${usage.data.freeLimit} routes used this month.`
              : "."}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Link to="/pricing">
              <Button className="shadow-stamp">
                <Crown className="mr-2 h-4 w-4" /> Upgrade to Premium
              </Button>
            </Link>
            <Button variant="outline" onClick={() => restore.mutate()} disabled={restore.isPending}>
              {restore.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Restore Purchases
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function BadgesSection() {
  const fn = useServerFn(getMyBadges);
  const { data } = useQuery({ queryKey: ["my-badges"], queryFn: () => fn() });
  const keys = (data ?? []).map((r) => r.badge_key);
  return (
    <Card className="mt-6 border-border bg-card p-5 shadow-paper sm:p-6">
      <h2 className="flex items-center gap-2 font-serif text-base font-semibold text-ink">
        <Award className="h-4 w-4 text-primary" /> Rewards
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Badges you've earned by exploring, saving, and sharing routes.
      </p>
      <div className="mt-4">
        <BadgeGrid badgeKeys={keys} />
      </div>
    </Card>
  );
}
