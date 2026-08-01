import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { readStoredConsent, grantConsent, denyConsent } from "@/lib/analytics/client";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";

/**
 * Strict-GDPR opt-in banner. Shows on first visit until the user chooses.
 * PostHog stays disabled until the user clicks "Accept".
 */
export function ConsentBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (readStoredConsent() === "unknown") setVisible(true);
  }, []);

  if (!visible) return null;

  function accept() {
    grantConsent();
    setVisible(false);
  }
  function decline() {
    denyConsent();
    setVisible(false);
  }

  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label="Analytics consent"
      className="fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-[60] mx-auto max-h-[calc(100dvh-1.5rem)] max-w-2xl overflow-y-auto rounded-2xl border border-border bg-card p-4 shadow-stamp sm:p-5"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-base font-semibold text-ink">Help us improve Scenik</h2>
          <p className="mt-1 text-sm leading-snug text-muted-foreground">
            We'd like to use privacy-friendly analytics (PostHog, EU-hosted) to see which
            features drivers use, so we can build better scenic routes. No adverts, no data
            sold, and you can change your mind any time. See our{" "}
            <Link to="/privacy" className="underline hover:text-primary">
              Privacy Notice
            </Link>
            .
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={accept} className="shadow-stamp">
              Accept analytics
            </Button>
            <Button size="sm" variant="ghost" onClick={decline}>
              Decline
            </Button>
          </div>
        </div>
        <button
          type="button"
          onClick={decline}
          aria-label="Decline and close"
          className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-ink"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
