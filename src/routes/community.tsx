import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listCommunityRoutes, toggleRouteLike, myLikedRouteIds, rateRoute, myRouteRatings } from "@/lib/community.functions";
import { StarRating, RatingDisplay } from "@/components/StarRating";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Heart, MessageCircle, MapPin, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Logo } from "@/components/Logo";
import { capture } from "@/lib/analytics/client";
import { AnalyticsEvent } from "@/lib/analytics/events";

export const Route = createFileRoute("/community")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Community drives — Scenik" },
      { name: "description", content: "Discover scenic routes shared by other drivers — and share your own." },
      { property: "og:title", content: "Community drives — Scenik" },
      { property: "og:description", content: "Discover scenic routes shared by other drivers." },
    ],
  }),
  component: CommunityPage,
  errorComponent: ({ error }) => (
    <div className="p-8 text-center text-sm text-muted-foreground">Couldn't load community: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-8 text-center text-sm">Not found.</div>,
});

function CommunityPage() {
  const listFn = useServerFn(listCommunityRoutes);
  const likeFn = useServerFn(toggleRouteLike);
  const myLikesFn = useServerFn(myLikedRouteIds);
  const rateFn = useServerFn(rateRoute);
  const myRatingsFn = useServerFn(myRouteRatings);
  const qc = useQueryClient();
  const [sort, setSort] = useState<"new" | "top" | "rated">("new");
  const [userId, setUserId] = useState<string | null>(null);
  const [country, setCountry] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
    try {
      const lang = (navigator.languages && navigator.languages[0]) || navigator.language || "";
      const region = lang.split("-")[1]?.toUpperCase();
      if (region && region.length === 2) {
        const name = new Intl.DisplayNames([lang || "en"], { type: "region" }).of(region);
        if (name) setCountry(name);
      }
    } catch { /* noop */ }
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["community", sort, country],
    queryFn: () => listFn({ data: { sort, limit: 30, country: sort === "top" && country ? country : undefined } }),
  });


  const ids = (data ?? []).map((r: any) => r.id);
  const likedKey = ids.join(",");
  const { data: liked } = useQuery({
    queryKey: ["community-liked", likedKey, userId],
    queryFn: () => userId ? myLikesFn({ data: { ids } }) : Promise.resolve([] as string[]),
    enabled: !!userId && ids.length > 0,
  });
  const likedSet = new Set(liked ?? []);

  const { data: myRatings } = useQuery({
    queryKey: ["community-my-ratings", likedKey, userId],
    queryFn: () => userId ? myRatingsFn({ data: { ids } }) : Promise.resolve([] as Array<{ route_id: string; rating: number }>),
    enabled: !!userId && ids.length > 0,
  });
  const myRatingMap = new Map((myRatings ?? []).map((r: any) => [r.route_id, r.rating]));

  const like = useMutation({
    mutationFn: (route_id: string) => likeFn({ data: { route_id } }),
    onSuccess: (_res, route_id) => {
      const wasLiked = likedSet.has(route_id);
      capture(wasLiked ? AnalyticsEvent.RouteUnliked : AnalyticsEvent.RouteLiked, {
        route_id,
        source: "community_list",
      });
      qc.invalidateQueries({ queryKey: ["community"] });
      qc.invalidateQueries({ queryKey: ["community-liked"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rate = useMutation({
    mutationFn: (vars: { route_id: string; rating: number }) => rateFn({ data: vars }),
    onSuccess: (_res, vars) => {
      capture(AnalyticsEvent.RouteRated, {
        route_id: vars.route_id,
        rating: vars.rating,
        source: "community_list",
      });
      toast.success("Thanks for rating!");
      qc.invalidateQueries({ queryKey: ["community"] });
      qc.invalidateQueries({ queryKey: ["community-my-ratings"] });
      qc.invalidateQueries({ queryKey: ["community-route"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="app-screen">
      <header className="border-b border-border bg-card/70 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <Link to="/" className="flex items-center gap-2">
            <Logo className="h-5 w-5 text-primary" />
            <span className="font-serif text-lg font-semibold text-ink">Scenik</span>
          </Link>
          <nav className="flex items-center gap-1">
            {userId ? (
              <>
                <Link to="/plan"><Button variant="ghost" size="sm">Plan</Button></Link>
                <Link to="/routes"><Button variant="ghost" size="sm"><MapPin className="h-4 w-4 mr-1.5" />My routes</Button></Link>
              </>
            ) : (
              <Link to="/auth"><Button size="sm" variant="outline">Sign in</Button></Link>
            )}
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="flex items-center gap-2 font-serif text-2xl font-semibold text-ink sm:text-3xl">
              <Users className="h-6 w-6 text-primary" /> Community drives
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Routes other Scenik travelers chose to share.
              {sort === "top" && country ? ` Most loved near ${country}.` : sort === "top" ? " Most loved worldwide." : sort === "rated" ? " Top rated worldwide." : ""}
            </p>

          </div>
          <div className="flex shrink-0 gap-1 rounded-full border border-border bg-background p-1">
            {(["new", "top", "rated"] as const).map((s) => (
              <button
                key={s}
                onClick={() => {
                  setSort(s);
                  capture(AnalyticsEvent.CommunityFeedSorted, { sort_by: s });
                }}
                className={`rounded-full px-4 py-1 text-xs font-medium transition ${sort === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-ink"}`}
              >
                {s === "new" ? "New" : s === "top" ? "Most loved" : "Top rated"}
              </button>
            ))}
          </div>
        </div>

        {isLoading && <p className="mt-10 text-sm text-muted-foreground">Loading…</p>}

        {!isLoading && (!data || data.length === 0) && (
          <Card className="mt-8 border-dashed border-border bg-card p-8 text-center shadow-paper sm:p-12">
            <MapPin className="mx-auto h-10 w-10 text-muted-foreground opacity-40" strokeWidth={1.25} />
            <h2 className="mt-4 font-serif text-xl font-semibold text-ink">No shared drives yet</h2>
            <p className="mt-1 text-sm text-muted-foreground">Be the first — plan a route, save it, and toggle Share.</p>
            {userId ? (
              <Link to="/plan"><Button className="mt-5 shadow-stamp">Plan a drive</Button></Link>
            ) : (
              <Link to="/auth"><Button className="mt-5 shadow-stamp">Sign in to share</Button></Link>
            )}
          </Card>
        )}

        <div className="mt-6 grid gap-4 sm:mt-8 md:grid-cols-2">
          {data?.map((r: any) => {
            const isLiked = likedSet.has(r.id);
            const myRating = myRatingMap.get(r.id) ?? 0;
            return (
              <Card key={r.id} className="border-border bg-card p-4 shadow-paper transition hover:shadow-stamp sm:p-5">
                <Link to="/community/$id" params={{ id: r.id }} className="block">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                        {r.mood} {r.theme ? `· ${r.theme}` : ""} {r.extra_minutes ? `· +${r.extra_minutes} min` : ""}
                      </div>
                      <h3 className="mt-1 font-serif text-lg font-semibold text-ink sm:text-xl">{r.title}</h3>
                      <p className="mt-1 break-words text-xs text-muted-foreground">
                        {r.start_address} → {r.end_address}
                      </p>
                    </div>
                    <div className="shrink-0 rounded-xl border border-border bg-background px-3 py-2 text-center">
                      <div className="text-[9px] font-medium uppercase tracking-widest text-muted-foreground">Scenic</div>
                      <div className="font-serif text-xl font-semibold text-primary">{r.scenic_score}</div>
                    </div>
                  </div>
                  <p className="mt-3 line-clamp-2 font-serif text-sm italic text-ink/80">"{r.narrative}"</p>
                </Link>
                <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5">
                  <RatingDisplay avg={Number(r.rating_avg ?? 0)} count={r.rating_count ?? 0} />
                  <div className="flex items-center gap-1.5">
                    {myRating > 0 && <span className="text-[10px] text-muted-foreground">Your rating</span>}
                    <StarRating
                      value={myRating}
                      size={16}
                      onChange={(v) => {
                        if (!userId) { toast("Sign in to rate routes"); return; }
                        rate.mutate({ route_id: r.id, rating: v });
                      }}
                    />
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <Link
                    to="/u/$id"
                    params={{ id: r.author.id }}
                    className="text-xs text-muted-foreground hover:text-primary hover:underline"
                  >
                    by {r.author.display_name || "Traveler"}
                  </Link>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <button
                      type="button"
                      onClick={() => {
                        if (!userId) { toast("Sign in to like routes"); return; }
                        like.mutate(r.id);
                      }}
                      className={`inline-flex items-center gap-1 transition ${isLiked ? "text-rose-600" : "hover:text-rose-600"}`}
                    >
                      <Heart className={`h-3.5 w-3.5 ${isLiked ? "fill-current" : ""}`} /> {r.like_count}
                    </button>
                    <Link to="/community/$id" params={{ id: r.id }} className="inline-flex items-center gap-1 hover:text-primary">
                      <MessageCircle className="h-3.5 w-3.5" /> {r.comment_count}
                    </Link>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
