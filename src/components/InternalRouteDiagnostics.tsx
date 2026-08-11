import { useState } from "react";
import { ClipboardCopy } from "lucide-react";
import { toast } from "sonner";
import {
  copyRouteDiagnostics,
  type RouteGenerationDiagnostic,
} from "@/lib/route-generation-diagnostics";

export function InternalRouteDiagnostics({
  diagnostics,
}: {
  diagnostics?: RouteGenerationDiagnostic | null;
}) {
  const [copying, setCopying] = useState(false);
  if (!diagnostics) return null;

  const copy = async () => {
    if (copying) return;
    setCopying(true);
    const copied = await copyRouteDiagnostics(
      diagnostics,
      typeof navigator === "undefined" ? undefined : navigator.clipboard,
    );
    setCopying(false);
    if (copied) toast.success("Diagnostics copied");
    else toast.error("Couldn’t copy diagnostics. Please try again.");
  };

  return (
    <aside
      aria-label="Internal route diagnostics"
      className="mt-5 border-t border-dashed border-border pt-3"
    >
      <button
        type="button"
        onClick={copy}
        disabled={copying}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
        {copying ? "Copying diagnostics…" : "Copy route diagnostics"}
      </button>
    </aside>
  );
}
