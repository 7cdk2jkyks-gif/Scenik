import { WifiOff } from "lucide-react";

/**
 * Persistent banner shown while the device has no network connection.
 * Reassures the user that cached route data + GPS-based navigation
 * still work, and that only the map imagery is unavailable.
 */
export function OfflineBanner({ className = "" }: { className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-paper ${className}`}
    >
      <WifiOff className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">Offline Mode</div>
        <p className="mt-0.5 text-xs leading-relaxed text-amber-900/90">
          Map imagery unavailable. Navigation continues using saved route data.
        </p>
      </div>
    </div>
  );
}
