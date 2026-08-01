import { Link } from "@tanstack/react-router";
import { WifiOff, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shown to non-premium users when they lose connectivity. Offline route data
 * (cached polylines, turn-by-turn, saved routes) is a Premium-only feature.
 */
export function OfflineUpgradeBanner({ className = "" }: { className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col gap-3 rounded-xl border border-amber-500/40 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-paper sm:flex-row sm:items-center sm:justify-between ${className}`}
    >
      <div className="flex items-start gap-3">
        <WifiOff className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">You're offline</div>
          <p className="mt-0.5 text-xs leading-relaxed text-amber-900/90">
            Offline navigation with cached routes is a Premium feature. Upgrade to keep driving when the signal drops.
          </p>
        </div>
      </div>
      <Link to="/pricing" className="shrink-0">
        <Button size="sm" className="shadow-stamp">
          <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Upgrade
        </Button>
      </Link>
    </div>
  );
}
