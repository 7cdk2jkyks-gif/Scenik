import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Check, Loader2, ExternalLink } from "lucide-react";
import { Logo } from "@/components/Logo";
import { supabase } from "@/integrations/supabase/client";
import { useState } from "react";
import { useSubscription, useUsage } from "@/hooks/useSubscription";
import { useRCOffering, useRCPremium } from "@/hooks/useRevenueCat";
import { usePaddleCheckout } from "@/hooks/usePaddleCheckout";
import { PaymentTestModeBanner } from "@/components/PaymentTestModeBanner";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import {
  cancelMySubscription,
  getCustomerPortalUrl,
  resumeMySubscription,
} from "@/lib/payments.functions";
import { getPaddleEnvironment } from "@/lib/paddle";
import { toast } from "sonner";
import { Crown } from "lucide-react";
import { capture } from "@/lib/analytics/client";
import { AnalyticsEvent } from "@/lib/analytics/events";
import { isNativePlatform, getPlatform } from "@/lib/native";
import { APPLE_MANAGE_SUBSCRIPTIONS_URL, purchaseRCPackage, restoreRC } from "@/lib/revenuecat";
import { getPublicOrigin } from "@/lib/native";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: "Scenik Premium — unlock unlimited scenic drives" },
      {
        name: "description",
        content:
          "Go Premium for unlimited routes, multi-stop planning, community collections, personalised AI, and the full rewards programme.",
      },
    ],
  }),
  component: PricingPage,
});

const FREE_FEATURES = [
  "3 routes per month",
  "Basic scenic routing",
  "Turn-by-turn navigation",
  "Save routes",
  "Limited community access",
];

const PREMIUM_FEATURES = [
  "Unlimited routes",
  "Advanced mood & theme preferences",
  "Full community routes",
  "Curated scenic collections",
  "Multi-stop planning",
  "Personalised AI routing",
  "Rewards programme with badges",
];

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function PricingPage() {
  const navigate = useNavigate();
  const [userEmail, setUserEmail] = useState<string | undefined>();
  const [userId, setUserId] = useState<string | undefined>();
  const [authed, setAuthed] = useState(false);
  const sub = useSubscription();
  const usage = useUsage();
  const { openCheckout, loading } = usePaddleCheckout();
  const portalFn = useServerFn(getCustomerPortalUrl);
  const cancelFn = useServerFn(cancelMySubscription);
  const resumeFn = useServerFn(resumeMySubscription);
  const qc = useQueryClient();
  const [portalLoading, setPortalLoading] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [purchaseLoading, setPurchaseLoading] = useState(false);
  const [billing, setBilling] = useState<"monthly" | "annual">("monthly");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const u = data.user;
      const realUser = !!u && !(u as { is_anonymous?: boolean }).is_anonymous;
      setUserEmail(realUser ? (u!.email ?? undefined) : undefined);
      setUserId(realUser ? u!.id : undefined);
      setAuthed(realUser);
    });
  }, []);

  const native = isNativePlatform();
  const rcOffering = useRCOffering();
  const rcPremium = useRCPremium();
  const isPremium = sub.data?.isPremium ?? false;
  const isNativePremium = native && !!rcPremium.data?.isPremium;
  const priceId = billing === "monthly" ? "scenik_premium_monthly_v2" : "scenik_premium_annual_v2";

  // On native, prefer localised Apple/Play pricing from RevenueCat so the UI
  // matches what StoreKit will actually charge. Fall back to Paddle web
  // pricing when RC hasn't loaded yet.
  const rcPkg = billing === "monthly" ? rcOffering.data?.monthly : rcOffering.data?.annual;
  const priceLabel =
    native && rcPkg?.priceString ? rcPkg.priceString : billing === "monthly" ? "£4.99" : "£49.99";
  const periodLabel = billing === "monthly" ? "/ month" : "/ year";
  const renewalCopy = native
    ? `Billed ${priceLabel} per ${billing === "monthly" ? "month" : "year"}. Automatically renews until you cancel in Settings › Apple ID › Subscriptions.`
    : billing === "monthly"
      ? "Billed £4.99 every month. Automatically renews until you cancel."
      : "Billed £49.99 every year — get 2 months free (works out at £4.17/month). Automatically renews until you cancel.";

  async function handleUpgrade() {
    if (!authed) {
      navigate({ to: "/auth" });
      return;
    }
    // App Store & Google Play policy: digital subscriptions inside a native
    // app must go through StoreKit / Play Billing. Route native purchases
    // through RevenueCat instead of Paddle.
    if (native) {
      capture(AnalyticsEvent.PremiumCheckoutOpened, {
        price_id: priceId,
        billing_period: billing,
        plan: "scenik_premium",
        source: "pricing_page_native",
        platform: getPlatform(),
      });

      setPurchaseLoading(true);
      try {
        let offering = rcOffering.data;
        if (!offering) {
          const refreshed = await rcOffering.refetch();
          offering = refreshed.data ?? null;
        }
        const purchasePackage = billing === "monthly" ? offering?.monthly : offering?.annual;
        if (!purchasePackage) {
          toast.error("Subscriptions aren’t available in this test build yet.");
          return;
        }
        const outcome = await purchaseRCPackage(purchasePackage);
        if (outcome.status === "cancelled") return;
        if (outcome.status === "error") {
          capture(AnalyticsEvent.PremiumCheckoutError, {
            message: "RC_PURCHASE_UNAVAILABLE",
            billing_period: billing,
            platform: getPlatform(),
          });
          toast.error(outcome.message);
          return;
        }
        await qc.invalidateQueries({ queryKey: ["rc-premium"] });
        await qc.invalidateQueries({ queryKey: ["subscription"] });
        toast.success("Welcome to Premium!");
        return;
      } catch {
        toast.error("Subscriptions aren’t available in this test build yet.");
        return;
      } finally {
        setPurchaseLoading(false);
      }
    }
    capture(AnalyticsEvent.PremiumCheckoutOpened, {
      price_id: priceId,
      billing_period: billing,
      plan: "scenik_premium",
      source: "pricing_page",
    });

    try {
      await openCheckout({
        priceId,
        customerEmail: userEmail,
        customData: userId ? { userId } : undefined,
        successUrl: `${getPublicOrigin()}/pricing?checkout=success`,
      });
    } catch (e: unknown) {
      capture(AnalyticsEvent.PremiumCheckoutError, {
        message: errorMessage(e, "unknown"),
        billing_period: billing,
      });
      toast.error(errorMessage(e, "Checkout failed to open"));
    }
  }

  async function handleRestore() {
    setRestoreLoading(true);
    try {
      let nativePremium = false;
      if (native) {
        try {
          const state = await restoreRC();
          nativePremium = state.isPremium;
        } catch (e) {
          console.warn("[restore] native restore failed", e);
        }
      }
      await qc.invalidateQueries({ queryKey: ["rc-premium"] });
      await qc.invalidateQueries({ queryKey: ["subscription"] });
      await qc.invalidateQueries({ queryKey: ["usage"] });
      await sub.refetch();
      const found = nativePremium || !!sub.data?.isPremium;
      capture(AnalyticsEvent.PremiumSubscriptionRestored, { found });
      if (found) toast.success("Premium restored.");
      else toast.message("No active Premium subscription found on this account.");
    } catch (e: unknown) {
      toast.error(errorMessage(e, "Could not refresh subscription status"));
    } finally {
      setRestoreLoading(false);
    }
  }

  async function openPortal() {
    // Apple/Google policy: manage subs from the OS store, not a web portal.
    if (isNativePremium || (native && !sub.data?.subscription)) {
      const url = rcPremium.data?.managementURL ?? APPLE_MANAGE_SUBSCRIPTIONS_URL;
      window.open(url, "_blank");
      return;
    }
    setPortalLoading(true);
    try {
      const url = await portalFn({ data: { environment: getPaddleEnvironment() } });
      window.open(url, "_blank");
    } catch (e: unknown) {
      toast.error(errorMessage(e, "Could not open portal"));
    } finally {
      setPortalLoading(false);
    }
  }

  async function handleDowngrade() {
    if (
      !confirm(
        "Cancel Premium? You'll keep access until the end of your current billing period, then move to the Free plan.",
      )
    )
      return;
    setCancelLoading(true);
    try {
      await cancelFn({ data: { environment: getPaddleEnvironment() } });
      await qc.invalidateQueries({ queryKey: ["subscription"] });
      capture(AnalyticsEvent.PremiumSubscriptionCanceled, {
        plan: "scenik_premium",
        source: "pricing_page",
      });
      toast.success("Premium canceled. You'll stay on Premium until the end of the period.");
    } catch (e: unknown) {
      toast.error(errorMessage(e, "Could not cancel subscription"));
    } finally {
      setCancelLoading(false);
    }
  }

  async function handleResume() {
    setResumeLoading(true);
    try {
      await resumeFn({ data: { environment: getPaddleEnvironment() } });
      await qc.invalidateQueries({ queryKey: ["subscription"] });
      capture(AnalyticsEvent.PremiumSubscriptionResumed, { plan: "scenik_premium" });
      toast.success("Premium resumed. Your subscription will continue.");
    } catch (e: unknown) {
      toast.error(errorMessage(e, "Could not resume subscription"));
    } finally {
      setResumeLoading(false);
    }
  }

  return (
    <div className="min-h-screen">
      <PaymentTestModeBanner />
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6 sm:py-6">
        <Link to="/" className="flex items-center gap-2">
          <Logo className="h-6 w-6 text-primary" />
          <span className="font-serif text-xl font-semibold text-ink">Scenik</span>
        </Link>
        <Link to="/plan">
          <Button variant="ghost" size="sm">
            Back to app
          </Button>
        </Link>
      </header>

      <section className="mx-auto max-w-3xl px-4 pt-6 pb-4 text-center sm:px-6">
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
          Take the <span className="italic text-primary">Scenik route.</span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
          Free is enough to try Scenik. Premium is for the drivers who never want to be told "you've
          used all your routes this month."
        </p>
        {isPremium && (
          <div className="mx-auto mt-4 inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-sm font-semibold text-primary">
            <Crown className="h-4 w-4" /> You're on Premium
            {sub.data?.subscription?.cancel_at_period_end && (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                (cancels{" "}
                {sub.data.subscription.current_period_end
                  ? new Date(sub.data.subscription.current_period_end).toLocaleDateString()
                  : "at period end"}
                )
              </span>
            )}
          </div>
        )}
        {usage.data && !isPremium && (
          <p className="mt-3 text-sm text-muted-foreground">
            You've used <strong className="text-ink">{usage.data.generationsThisMonth}</strong> of{" "}
            {usage.data.freeLimit} routes this month.
          </p>
        )}
      </section>

      <section className="mx-auto grid max-w-4xl gap-6 px-4 pb-16 sm:px-6 md:grid-cols-2">
        <Card className="p-6 shadow-paper">
          <div className="font-serif text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground">
            Free
          </div>
          <div className="mt-2 flex items-baseline gap-1">
            <span className="font-serif text-4xl font-semibold text-ink">£0</span>
            <span className="text-sm text-muted-foreground">/ month</span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">Get a feel for scenic routing.</p>
          <ul className="mt-5 space-y-2 text-sm">
            {FREE_FEATURES.map((f) => (
              <li key={f} className="flex items-start gap-2 text-ink">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> {f}
              </li>
            ))}
          </ul>
          {isPremium ? (
            isNativePremium ? (
              <Button variant="outline" className="mt-6 w-full" onClick={openPortal}>
                <ExternalLink className="mr-2 h-4 w-4" /> Manage in App Store
              </Button>
            ) : (
              <Button
                variant="outline"
                className="mt-6 w-full"
                onClick={handleDowngrade}
                disabled={cancelLoading || !!sub.data?.subscription?.cancel_at_period_end}
              >
                {cancelLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {sub.data?.subscription?.cancel_at_period_end
                  ? "Downgrade scheduled"
                  : "Downgrade to Free"}
              </Button>
            )
          ) : (
            <Button variant="outline" className="mt-6 w-full" disabled={authed}>
              {authed ? "You're on Free" : "Current plan"}
            </Button>
          )}
        </Card>

        <Card className="relative overflow-hidden border-primary/40 p-6 shadow-stamp">
          <div className="absolute right-4 top-4 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary-foreground">
            Recommended
          </div>
          <div className="flex items-center gap-2 font-serif text-xs font-semibold uppercase tracking-[0.3em] text-primary">
            <Crown className="h-3.5 w-3.5" /> Premium
          </div>

          {!isPremium && (
            <div className="mt-3 inline-flex rounded-full border border-border bg-muted p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setBilling("monthly")}
                className={`rounded-full px-3 py-1 font-medium transition ${billing === "monthly" ? "bg-background text-ink shadow-sm" : "text-muted-foreground"}`}
              >
                Monthly
              </button>
              <button
                type="button"
                onClick={() => setBilling("annual")}
                className={`rounded-full px-3 py-1 font-medium transition ${billing === "annual" ? "bg-background text-ink shadow-sm" : "text-muted-foreground"}`}
              >
                Annual <span className="ml-1 text-primary">2 months free</span>
              </button>
            </div>
          )}

          <div className="mt-3 flex items-baseline gap-1">
            <span className="font-serif text-4xl font-semibold text-ink">{priceLabel}</span>
            <span className="text-sm text-muted-foreground">{periodLabel}</span>
          </div>
          {!isPremium && <p className="mt-1 text-xs text-muted-foreground">{renewalCopy}</p>}
          <p className="mt-2 text-sm text-muted-foreground">
            Unlimited scenic drives + the full rewards programme.
          </p>
          <ul className="mt-5 space-y-2 text-sm">
            {PREMIUM_FEATURES.map((f) => (
              <li key={f} className="flex items-start gap-2 text-ink">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> {f}
              </li>
            ))}
          </ul>
          {isPremium && sub.data?.subscription?.cancel_at_period_end && !isNativePremium ? (
            <div className="mt-6 space-y-2">
              <Button
                className="w-full shadow-stamp"
                onClick={handleResume}
                disabled={resumeLoading}
              >
                {resumeLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Crown className="mr-2 h-4 w-4" />
                )}
                Resume Premium
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={openPortal}
                disabled={portalLoading}
              >
                {portalLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <ExternalLink className="mr-2 h-4 w-4" />
                )}
                Manage in portal
              </Button>
            </div>
          ) : isPremium ? (
            <Button className="mt-6 w-full" onClick={openPortal} disabled={portalLoading}>
              {portalLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ExternalLink className="mr-2 h-4 w-4" />
              )}
              {isNativePremium ? "Manage in App Store" : "Manage subscription"}
            </Button>
          ) : (
            <Button
              className="mt-6 w-full shadow-stamp"
              onClick={handleUpgrade}
              disabled={loading || purchaseLoading}
            >
              {loading || purchaseLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Crown className="mr-2 h-4 w-4" />
              )}
              {authed ? `Upgrade to Premium — ${priceLabel}${periodLabel}` : "Sign in to upgrade"}
            </Button>
          )}
        </Card>
      </section>

      <section className="mx-auto max-w-3xl px-4 pb-16 sm:px-6">
        <div className="rounded-lg border border-border bg-muted/40 p-5 text-sm text-muted-foreground">
          <h2 className="mb-2 font-serif text-base font-semibold text-ink">Subscription details</h2>
          {native ? (
            <ul className="space-y-1.5">
              <li>
                <strong className="text-ink">Plans:</strong> Scenik Premium Monthly and Scenik
                Premium Annual. Prices shown above are the localised prices from the App Store for
                your region.
              </li>
              <li>
                <strong className="text-ink">Billing:</strong> charged to your Apple ID at
                confirmation of purchase.
              </li>
              <li>
                <strong className="text-ink">Renewal:</strong> renews automatically at the same
                price unless auto-renew is turned off at least 24 hours before the end of the
                current period.
              </li>
              <li>
                <strong className="text-ink">Manage &amp; cancel:</strong> anytime in Settings ›
                Apple ID › Subscriptions on your device. You keep Premium until the end of the
                current billing period.
              </li>
              <li>
                <strong className="text-ink">Refunds:</strong> refunds are handled by Apple at{" "}
                <a
                  href="https://reportaproblem.apple.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  reportaproblem.apple.com
                </a>
                .
              </li>
              <li>
                <strong className="text-ink">No hidden charges:</strong> the price shown at purchase
                is what Apple will charge. Local taxes may apply and are shown at checkout.
              </li>
            </ul>
          ) : (
            <ul className="space-y-1.5">
              <li>
                <strong className="text-ink">Price:</strong> £4.99/month or £49.99/year — get 2
                months free (equivalent to £4.17/month).
              </li>
              <li>
                <strong className="text-ink">Billing period:</strong> monthly or annual, chosen at
                checkout.
              </li>
              <li>
                <strong className="text-ink">Renewal:</strong> your subscription renews
                automatically at the end of each billing period at the same price, until you cancel.
              </li>
              <li>
                <strong className="text-ink">Cancellation:</strong> cancel any time in "Manage
                subscription" — you'll keep Premium until the end of the current billing period,
                then move to Free. No cancellation fee.
              </li>
              <li>
                <strong className="text-ink">Refunds:</strong> 30-day money-back guarantee. Request
                a refund at any time via{" "}
                <a
                  href="https://paddle.net"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  paddle.net
                </a>{" "}
                or by contacting support.
              </li>
              <li>
                <strong className="text-ink">No hidden charges:</strong> the price shown is the
                price you pay. Local taxes (e.g. VAT) may be added at checkout where required by law
                and are always shown before you pay.
              </li>
              <li>
                <strong className="text-ink">Payment provider:</strong> payments are processed by
                Paddle, our Merchant of Record.
              </li>
            </ul>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
            <Button variant="ghost" size="sm" onClick={handleRestore} disabled={restoreLoading}>
              {restoreLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Restore purchases
            </Button>
            <span className="text-muted-foreground">
              Already paid on this account? Tap restore to refresh your Premium status.
            </span>
          </div>
          <p className="mt-4 text-xs">
            By subscribing you agree to our{" "}
            <Link to="/terms" className="underline">
              Terms of Use
            </Link>{" "}
            and{" "}
            <Link to="/privacy" className="underline">
              Privacy Policy
            </Link>
            {native ? (
              "."
            ) : (
              <>
                {" "}
                and Paddle's{" "}
                <a
                  href="https://www.paddle.com/legal/checkout-buyer-terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Buyer Terms
                </a>
                .
              </>
            )}
          </p>
        </div>
      </section>
    </div>
  );
}
