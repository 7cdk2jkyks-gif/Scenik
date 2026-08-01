import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { getPublicProfile } from "@/lib/profiles.functions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { ArrowLeft, MapPin, Heart, MessageCircle } from "lucide-react";

export const Route = createFileRoute("/u/$id")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Traveler — Scenik" },
      { name: "description", content: "An Scenik traveler's shared drives." },
    ],
  }),
  component: ProfilePage,
  errorComponent: ({ error }) => (
    <div className="p-8 text-center text-sm text-muted-foreground">Couldn't load profile: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-8 text-center text-sm">Profile not found.</div>,
});

function ProfilePage() {
  const { id } = Route.useParams();
  const getFn = useServerFn(getPublicProfile);
  const { data, isLoading } = useQuery({
    queryKey: ["public-profile", id],
    queryFn: () => getFn({ data: { id } }),
  });

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card/70 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3 sm:px-6 sm:py-4">
          <Link to="/community" className="inline-flex items-center gap-2 text-sm text-ink hover:text-primary">
            <ArrowLeft className="h-4 w-4" /> Community
          </Link>
          <Link to="/" className="flex items-center gap-2">
            <Logo className="h-5 w-5 text-primary" />
            <span className="font-serif text-lg font-semibold text-ink">Scenik</span>
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {data && (
          <>
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 font-serif text-2xl font-semibold text-primary">
                {(data.profile.display_name || "T").slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0">
                <h1 className="font-serif text-2xl font-semibold text-ink sm:text-3xl">{data.profile.display_name || "Traveler"}</h1>
                {data.profile.bio && <p className="mt-1 text-sm text-muted-foreground">{data.profile.bio}</p>}
                <p className="mt-1 text-xs text-muted-foreground">Joined {new Date(data.profile.created_at).toLocaleDateString()}</p>
              </div>
            </div>

            <h2 className="mt-8 font-serif text-lg font-semibold text-ink">Shared drives ({data.routes.length})</h2>
            {data.routes.length === 0 && (
              <Card className="mt-3 border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
                Nothing shared yet.
              </Card>
            )}
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {data.routes.map((r: any) => (
                <Link key={r.id} to="/community/$id" params={{ id: r.id }}>
                  <Card className="border-border bg-card p-4 shadow-paper transition hover:shadow-stamp">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                          {r.mood} {r.theme ? `· ${r.theme}` : ""}
                        </div>
                        <h3 className="mt-1 font-serif text-base font-semibold text-ink">{r.title}</h3>
                        <p className="mt-1 break-words text-xs text-muted-foreground">{r.start_address} → {r.end_address}</p>
                      </div>
                      <div className="shrink-0 rounded-lg border border-border bg-background px-2 py-1 text-center">
                        <div className="font-serif text-lg font-semibold text-primary">{r.scenic_score}</div>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1"><Heart className="h-3 w-3" /> {r.like_count}</span>
                      <span className="inline-flex items-center gap-1"><MessageCircle className="h-3 w-3" /> {r.comment_count}</span>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
            <div className="mt-8">
              <Link to="/community"><Button variant="outline"><MapPin className="mr-2 h-4 w-4" /> More from the community</Button></Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
