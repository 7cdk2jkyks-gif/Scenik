import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function publicClient() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

const PUBLIC_ROUTE_COLS =
  "id, user_id, title, mood, theme, extra_minutes, start_address, end_address, start_lat, start_lng, end_lat, end_lng, waypoints, scenic_score, narrative, highlights, like_count, comment_count, rating_avg, rating_count, created_at";

export const listCommunityRoutes = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z.object({
      sort: z.enum(["new", "top", "rated"]).default("new"),
      limit: z.number().int().min(1).max(60).default(30),
      country: z.string().trim().min(1).max(80).optional(),
    }).parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const sb = await publicClient();
    let q = sb.from("routes").select(PUBLIC_ROUTE_COLS).eq("is_public", true).limit(data.limit);
    if (data.sort === "top") {
      if (data.country) {
        const c = data.country.replace(/[,%]/g, "");
        q = q.or(`start_address.ilike.%${c}%,end_address.ilike.%${c}%`);
      }
      q = q.order("like_count", { ascending: false }).order("created_at", { ascending: false });
    } else if (data.sort === "rated") {
      q = q.order("rating_avg", { ascending: false }).order("rating_count", { ascending: false }).order("created_at", { ascending: false });
    } else {
      q = q.order("created_at", { ascending: false });
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const ids = Array.from(new Set((rows ?? []).map((r) => r.user_id)));
    const profiles = ids.length
      ? (await sb.rpc("get_public_profiles", { _user_ids: ids })).data ?? []
      : [];
    const byId = new Map(profiles.map((p) => [p.id, p]));
    return (rows ?? []).map((r) => ({
      ...r,
      author: byId.get(r.user_id) ?? { id: r.user_id, display_name: "Traveler", avatar_url: null },
    }));
  });


export const getCommunityRoute = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const sb = await publicClient();
    const { data: row, error } = await sb
      .from("routes").select(PUBLIC_ROUTE_COLS)
      .eq("id", data.id).eq("is_public", true).maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Route not found or not shared.");
    const { data: authorRows } = await sb.rpc("get_public_profile", { _user_id: row.user_id });
    const author = authorRows?.[0];
    return {
      ...row,
      author: author ?? { id: row.user_id, display_name: "Traveler", avatar_url: null, bio: "" },
    };
  });

export const listRouteComments = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => z.object({ route_id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const sb = await publicClient();
    const { data: rows, error } = await sb
      .from("route_comments")
      .select("id, route_id, user_id, body, created_at")
      .eq("route_id", data.route_id)
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) throw new Error(error.message);
    const ids = Array.from(new Set((rows ?? []).map((r) => r.user_id)));
    const profiles = ids.length
      ? (await sb.rpc("get_public_profiles", { _user_ids: ids })).data ?? []
      : [];
    const byId = new Map(profiles.map((p) => [p.id, p]));
    return (rows ?? []).map((c) => ({
      ...c,
      author: byId.get(c.user_id) ?? { id: c.user_id, display_name: "Traveler", avatar_url: null },
    }));
  });

export const toggleRouteShare = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid(), is_public: z.boolean() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("routes").update({ is_public: data.is_public }).eq("id", data.id).eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true, is_public: data.is_public };
  });

export const toggleRouteLike = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ route_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: existing } = await context.supabase
      .from("route_likes").select("user_id").eq("user_id", context.userId).eq("route_id", data.route_id).maybeSingle();
    if (existing) {
      const { error } = await context.supabase
        .from("route_likes").delete().eq("user_id", context.userId).eq("route_id", data.route_id);
      if (error) throw new Error(error.message);
      return { liked: false };
    }
    const { error } = await context.supabase
      .from("route_likes").insert({ user_id: context.userId, route_id: data.route_id });
    if (error) throw new Error(error.message);
    return { liked: true };
  });

export const myLikedRouteIds = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ ids: z.array(z.string().uuid()).max(120) }).parse(input))
  .handler(async ({ data, context }) => {
    if (!data.ids.length) return [] as string[];
    const { data: rows, error } = await context.supabase
      .from("route_likes").select("route_id").eq("user_id", context.userId).in("route_id", data.ids);
    if (error) throw new Error(error.message);
    return (rows ?? []).map((r) => r.route_id);
  });

export const addRouteComment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ route_id: z.string().uuid(), body: z.string().trim().min(1).max(1000) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("route_comments").insert({ route_id: data.route_id, user_id: context.userId, body: data.body })
      .select().single();
    if (error) throw new Error(error.message);
    return row;
  });

export const deleteRouteComment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("route_comments").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const copyRouteToMine = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const sb = await publicClient();
    const { data: src, error } = await sb
      .from("routes").select(PUBLIC_ROUTE_COLS).eq("id", data.id).eq("is_public", true).maybeSingle();
    if (error) throw new Error(error.message);
    if (!src) throw new Error("Route not found.");
    const { data: row, error: insErr } = await context.supabase.from("routes").insert({
      user_id: context.userId,
      title: src.title, mood: src.mood, theme: src.theme, extra_minutes: src.extra_minutes,
      start_address: src.start_address, end_address: src.end_address,
      start_lat: src.start_lat, start_lng: src.start_lng,
      end_lat: src.end_lat, end_lng: src.end_lng,
      waypoints: src.waypoints, scenic_score: src.scenic_score,
      narrative: src.narrative, highlights: src.highlights,
      is_public: false,
    }).select().single();
    if (insErr) throw new Error(insErr.message);
    return row;
  });

export const rateRoute = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ route_id: z.string().uuid(), rating: z.number().int().min(1).max(5) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("route_ratings")
      .upsert(
        { user_id: context.userId, route_id: data.route_id, rating: data.rating },
        { onConflict: "user_id,route_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true, rating: data.rating };
  });

export const clearRouteRating = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ route_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("route_ratings").delete()
      .eq("user_id", context.userId).eq("route_id", data.route_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const myRouteRatings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ ids: z.array(z.string().uuid()).max(120) }).parse(input))
  .handler(async ({ data, context }) => {
    if (!data.ids.length) return [] as Array<{ route_id: string; rating: number }>;
    const { data: rows, error } = await context.supabase
      .from("route_ratings").select("route_id, rating")
      .eq("user_id", context.userId).in("route_id", data.ids);
    if (error) throw new Error(error.message);
    return (rows ?? []) as Array<{ route_id: string; rating: number }>;
  });
