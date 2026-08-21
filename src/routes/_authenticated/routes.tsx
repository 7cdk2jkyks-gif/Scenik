import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect } from "react";
import { listMyRoutes, deleteRoute } from "@/lib/routes.functions";
import { toggleRouteShare } from "@/lib/community.functions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Trash2, MapPin, Share2, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { capture } from "@/lib/analytics/client";
import { AnalyticsEvent } from "@/lib/analytics/events";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { saveSavedRoutes, loadSavedRoutes } from "@/lib/offline-cache";
import { OfflineBanner } from "@/components/OfflineBanner";
import { OfflineUpgradeBanner } from "@/components/OfflineUpgradeBanner";
import { useSubscription } from "@/hooks/useSubscription";
import { getPublicOrigin } from "@/lib/native";

export const Route = createFileRoute("/_authenticated/routes")({
  component: RoutesPage,
});

type SavedRoute = Awaited<ReturnType<typeof listMyRoutes>>[number];

export function SavedRouteDeleteButton({
  disabled,
  pending,
  onDelete,
  confirmDelete = () => window.confirm("Delete this saved route? This cannot be undone."),
}: {
  disabled: boolean;
  pending: boolean;
  onDelete(): void;
  confirmDelete?: () => boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Delete route"
      title={disabled ? "Make this route private before deleting" : "Delete route"}
      disabled={disabled || pending}
      className="h-11 w-11 shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-50"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (pending || disabled || !confirmDelete()) return;
        onDelete();
      }}
    >
      <Trash2 className="h-4 w-4" aria-hidden="true" />
    </Button>
  );
}

function RoutesPage() {
  const listFn = useServerFn(listMyRoutes);
  const deleteFn = useServerFn(deleteRoute);
  const shareFn = useServerFn(toggleRouteShare);
  const qc = useQueryClient();
  const online = useOnlineStatus();

  const { data: subData } = useSubscription();
  const isPremium = !!subData?.isPremium;

  const { data, isLoading } = useQuery<SavedRoute[]>({
    queryKey: ["routes"],
    queryFn: () => listFn(),
    // Offline hydration is Premium-only.
    initialData: () => (isPremium ? (loadSavedRoutes<SavedRoute[]>() ?? undefined) : undefined),
    retry: online ? 3 : false,
    networkMode: isPremium ? "offlineFirst" : "online",
  });

  // Persist the latest list to localStorage so the routes page stays useful
  // when the device is offline. Premium-only. Route metadata only — no map tiles.
  useEffect(() => {
    if (isPremium && data) saveSavedRoutes(data);
  }, [data, isPremium]);

  const del = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: (_r, id) => {
      capture(AnalyticsEvent.RouteDeleted, { route_id: id });
      toast.success("Route deleted");
      qc.invalidateQueries({ queryKey: ["routes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const share = useMutation({
    mutationFn: (vars: { id: string; is_public: boolean }) => shareFn({ data: vars }),
    onSuccess: (r, vars) => {
      capture(vars.is_public ? AnalyticsEvent.RouteShared : AnalyticsEvent.RouteUnshared, {
        route_id: vars.id,
      });
      toast.success(r.is_public ? "Shared with the community" : "Made private");
      qc.invalidateQueries({ queryKey: ["routes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function copyShareLink(id: string) {
    if (typeof window === "undefined") return;
    const url = `${getPublicOrigin()}/community/${id}`;
    capture(AnalyticsEvent.ShareLinkCopied, { route_id: id });
    navigator.clipboard?.writeText(url).then(
      () => toast.success("Share link copied"),
      () => toast(url),
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      {!online &&
        (isPremium ? (
          <OfflineBanner className="mb-4" />
        ) : (
          <OfflineUpgradeBanner className="mb-4" />
        ))}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-serif text-2xl font-semibold text-ink sm:text-3xl">Saved routes</h1>
          <p className="mt-1 text-sm text-muted-foreground">Your journeys, ready when you are.</p>
        </div>
        <Link to="/plan" className="shrink-0">
          <Button className="w-full shadow-stamp sm:w-auto">Plan another</Button>
        </Link>
      </div>

      {isLoading && <p className="mt-10 text-sm text-muted-foreground">Loading…</p>}

      {!isLoading && (!data || data.length === 0) && (
        <Card className="mt-8 border-dashed border-border bg-card p-8 text-center shadow-paper sm:p-12">
          <MapPin
            className="mx-auto h-10 w-10 text-muted-foreground opacity-40"
            strokeWidth={1.25}
          />
          <h2 className="mt-4 font-serif text-xl font-semibold text-ink">No routes yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Plan your first scenic drive to see it here.
          </p>
          <Link to="/plan">
            <Button className="mt-5 shadow-stamp">Plan a drive</Button>
          </Link>
        </Card>
      )}

      <div className="mt-6 grid gap-4 sm:mt-8 md:grid-cols-2">
        {data?.map((r) => {
          const isPublic = !!(r as { is_public?: boolean }).is_public;
          return (
            <Card key={r.id} className="border-border bg-card p-4 shadow-paper sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                    {r.mood} · {r.theme} · +{r.extra_minutes} min
                  </div>
                  <h3 className="mt-1 font-serif text-lg font-semibold text-ink sm:text-xl">
                    {r.title}
                  </h3>
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    {r.start_address} → {r.end_address}
                  </p>
                </div>
                <div className="shrink-0 rounded-xl border border-border bg-background px-3 py-2 text-center">
                  <div className="text-[9px] font-medium uppercase tracking-widest text-muted-foreground">
                    Scenic
                  </div>
                  <div className="font-serif text-xl font-semibold text-primary">
                    {r.scenic_score}
                  </div>
                </div>
              </div>
              <p className="mt-3 line-clamp-3 font-serif text-sm italic text-ink/80">
                "{r.narrative}"
              </p>

              <div className="mt-4 flex items-center justify-between gap-2 rounded-lg border border-border bg-background p-2.5">
                <div className="flex items-center gap-2 text-xs">
                  <Share2
                    className={`h-3.5 w-3.5 ${isPublic ? "text-primary" : "text-muted-foreground"}`}
                  />
                  <span className="font-medium text-ink">{isPublic ? "Shared" : "Private"}</span>
                  {isPublic && (
                    <button
                      type="button"
                      onClick={() => copyShareLink(r.id)}
                      className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary"
                      title="Copy share link"
                    >
                      <ExternalLink className="h-3 w-3" /> link
                    </button>
                  )}
                </div>
                <Switch
                  checked={isPublic}
                  onCheckedChange={(v) => share.mutate({ id: r.id, is_public: v })}
                  disabled={share.isPending}
                  className="shrink-0 h-4 w-12 [&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-8"
                />
              </div>

              <div className="mt-3 flex justify-end">
                <SavedRouteDeleteButton
                  disabled={isPublic}
                  pending={del.isPending}
                  onDelete={() => del.mutate(r.id)}
                />
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
