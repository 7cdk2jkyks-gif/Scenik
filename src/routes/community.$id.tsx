import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getCommunityRoute,
  toggleRouteLike,
  myLikedRouteIds,
  copyRouteToMine,
  rateRoute,
  myRouteRatings,
} from "@/lib/community.functions";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StarRating, RatingDisplay } from "@/components/StarRating";
import { ArrowLeft, BookmarkPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Logo } from "@/components/Logo";
import { ScenicMap } from "@/components/ScenicMap";
import { capture } from "@/lib/analytics/client";
import { AnalyticsEvent } from "@/lib/analytics/events";
import { CommunityLikeButton } from "@/components/CommunityControls";
import {
  AUTHENTICATED_PAGE_BOTTOM_PADDING,
  CommunityBottomNavigation,
} from "@/components/AuthenticatedBottomNavigation";

export const Route = createFileRoute("/community/$id")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Shared drive — Scenik" },
      { name: "description", content: "A scenic drive shared by an Scenik traveler." },
    ],
  }),
  component: CommunityRoutePage,
  errorComponent: ({ error }) => (
    <div className="p-8 text-center text-sm text-muted-foreground">
      Couldn't load route: {error.message}
    </div>
  ),
  notFoundComponent: () => <div className="p-8 text-center text-sm">Route not found.</div>,
});

function CommunityRoutePage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const getFn = useServerFn(getCommunityRoute);
  const likeFn = useServerFn(toggleRouteLike);
  const myLikesFn = useServerFn(myLikedRouteIds);
  const copyFn = useServerFn(copyRouteToMine);
  const rateFn = useServerFn(rateRoute);
  const myRatingsFn = useServerFn(myRouteRatings);

  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  const route = useQuery({
    queryKey: ["community-route", id],
    queryFn: () => getFn({ data: { id } }),
  });
  const likedQ = useQuery({
    queryKey: ["liked", id, userId],
    queryFn: () => (userId ? myLikesFn({ data: { ids: [id] } }) : Promise.resolve([] as string[])),
    enabled: !!userId,
  });
  const isLiked = (likedQ.data ?? []).includes(id);

  const myRatingQ = useQuery({
    queryKey: ["my-rating", id, userId],
    queryFn: () =>
      userId
        ? myRatingsFn({ data: { ids: [id] } })
        : Promise.resolve([] as Array<{ route_id: string; rating: number }>),
    enabled: !!userId,
  });
  const myRating = myRatingQ.data?.find((x) => x.route_id === id)?.rating ?? 0;

  const rate = useMutation({
    mutationFn: (rating: number) => rateFn({ data: { route_id: id, rating } }),
    onSuccess: (_r, rating) => {
      capture(AnalyticsEvent.RouteRated, { route_id: id, rating, source: "community_detail" });
      toast.success("Thanks for rating!");
      qc.invalidateQueries({ queryKey: ["community-route", id] });
      qc.invalidateQueries({ queryKey: ["my-rating", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const like = useMutation({
    mutationFn: () => likeFn({ data: { route_id: id } }),
    onSuccess: () => {
      capture(isLiked ? AnalyticsEvent.RouteUnliked : AnalyticsEvent.RouteLiked, {
        route_id: id,
        source: "community_detail",
      });
      qc.invalidateQueries({ queryKey: ["community-route", id] });
      qc.invalidateQueries({ queryKey: ["liked", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const copy = useMutation({
    mutationFn: () => copyFn({ data: { id } }),
    onSuccess: () => {
      capture(AnalyticsEvent.CommunityRouteSaved, {
        route_id: id,
        title: r?.title,
        scenic_score: r?.scenic_score,
        author_id: r?.author?.id,
      });
      toast.success("Saved to your routes");
      navigate({ to: "/routes" });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const r = route.data;
  const waypoints = (r?.waypoints ?? []) as Array<{
    name: string;
    lat: number;
    lng: number;
    description: string;
  }>;
  const highlights = (r?.highlights ?? []) as string[];
  const points = r
    ? [
        { lat: r.start_lat, lng: r.start_lng, label: r.start_address, kind: "start" as const },
        ...waypoints.map((w) => ({
          lat: w.lat,
          lng: w.lng,
          label: w.name,
          kind: "waypoint" as const,
        })),
        { lat: r.end_lat, lng: r.end_lng, label: r.end_address, kind: "end" as const },
      ]
    : [];

  return (
    <div
      className="min-h-screen"
      style={userId ? { paddingBottom: AUTHENTICATED_PAGE_BOTTOM_PADDING } : undefined}
    >
      <header className="border-b border-border bg-card/70 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3 sm:px-6 sm:py-4">
          <Link
            to="/community"
            className="inline-flex items-center gap-2 text-sm text-ink hover:text-primary"
          >
            <ArrowLeft className="h-4 w-4" /> Community
          </Link>
          <Link to="/" className="flex items-center gap-2">
            <Logo className="h-5 w-5 text-primary" />
            <span className="font-serif text-lg font-semibold text-ink">Scenik</span>
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        {route.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {r && (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                  {r.mood} {r.theme ? `· ${r.theme}` : ""}{" "}
                  {r.extra_minutes ? `· +${r.extra_minutes} min` : ""}
                </div>
                <h1 className="mt-1 font-serif text-2xl font-semibold text-ink sm:text-3xl">
                  {r.title}
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {r.start_address} → {r.end_address}
                </p>
                <Link
                  to="/u/$id"
                  params={{ id: r.author.id }}
                  className="mt-2 inline-block text-xs text-muted-foreground hover:text-primary hover:underline"
                >
                  by {r.author.display_name || "Traveler"}
                </Link>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <div className="rounded-xl border border-border bg-background px-3 py-2 text-center">
                  <div className="text-[9px] font-medium uppercase tracking-widest text-muted-foreground">
                    Scenic
                  </div>
                  <div className="font-serif text-2xl font-semibold text-primary">
                    {r.scenic_score}
                  </div>
                </div>
                <CommunityLikeButton
                  variant="detail"
                  title={r.title}
                  count={r.like_count}
                  isLiked={isLiked}
                  onToggle={() => {
                    if (!userId) {
                      toast("Sign in to like");
                      return;
                    }
                    like.mutate();
                  }}
                />
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-3 shadow-paper">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                  Community rating
                </span>
                <RatingDisplay
                  avg={Number(r.rating_avg ?? 0)}
                  count={r.rating_count ?? 0}
                  size={16}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {userId ? (myRating ? "Your rating" : "Rate it") : "Sign in to rate"}
                </span>
                <StarRating
                  value={myRating}
                  readOnly={!userId}
                  size={20}
                  onChange={(v) => rate.mutate(v)}
                />
              </div>
            </div>

            <div className="mt-5 h-72 overflow-hidden rounded-2xl border border-border bg-muted sm:h-96">
              <ScenicMap points={points} className="h-full w-full" />
            </div>

            <Card className="mt-5 border-border bg-card p-5 shadow-paper">
              <p className="font-serif text-base italic text-ink/90">"{r.narrative}"</p>
              {highlights.length > 0 && (
                <div className="mt-4">
                  <h3 className="font-serif text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    Highlights
                  </h3>
                  <ul className="mt-2 space-y-1.5">
                    {highlights.map((h, i) => (
                      <li key={i} className="flex gap-2 text-sm">
                        <span className="text-primary">·</span>
                        <span>{h}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {waypoints.length > 0 && (
                <div className="mt-4">
                  <h3 className="font-serif text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    Waypoints
                  </h3>
                  <ol className="mt-2 space-y-2">
                    {waypoints.map((w, i) => (
                      <li key={i} className="rounded-xl border border-border bg-background p-3">
                        <div className="flex items-center gap-2">
                          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                            {i + 1}
                          </span>
                          <span className="font-serif text-base font-semibold text-ink">
                            {w.name}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{w.description}</p>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                {userId ? (
                  <Button
                    onClick={() => copy.mutate()}
                    disabled={copy.isPending}
                    className="shadow-stamp"
                  >
                    <BookmarkPlus className="mr-2 h-4 w-4" /> Save to my routes
                  </Button>
                ) : (
                  <Link to="/auth">
                    <Button className="shadow-stamp">Sign in to save</Button>
                  </Link>
                )}
              </div>
            </Card>
          </>
        )}
      </div>
      <CommunityBottomNavigation authenticated={Boolean(userId)} />
    </div>
  );
}
