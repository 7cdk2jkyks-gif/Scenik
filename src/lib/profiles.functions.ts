import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function publicClient() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

export const getMyProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("profiles")
      .select("*")
      .eq("id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return data;
    // ensure a row exists (idempotent fallback if trigger didn't fire)
    const { data: created, error: insErr } = await context.supabase
      .from("profiles")
      .insert({ id: context.userId, display_name: "Traveler" })
      .select()
      .single();
    if (insErr) throw new Error(insErr.message);
    return created;
  });

const UpdateInput = z.object({
  display_name: z.string().trim().min(1).max(60),
  bio: z.string().trim().max(280).default(""),
  units: z.enum(["auto", "mi", "km"]).default("auto"),
});

export const updateMyProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => UpdateInput.parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("profiles")
      .update(data)
      .eq("id", context.userId)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const acceptTerms = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: row, error } = await context.supabase
      .from("profiles")
      .update({ terms_accepted_at: new Date().toISOString() })
      .eq("id", context.userId)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const getPublicProfile = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const sb = await publicClient();
    // get_public_profile is a SECURITY DEFINER RPC that returns only safe
    // columns (display_name, avatar_url, bio, created_at) and only for
    // users who have shared at least one public route.
    const { data: rows, error } = await sb.rpc("get_public_profile", { _user_id: data.id });
    if (error) throw new Error(error.message);
    const profile = rows?.[0];
    if (!profile) throw new Error("Profile not found.");
    const { data: routes } = await sb
      .from("routes")
      .select(
        "id, title, mood, theme, extra_minutes, start_address, end_address, scenic_score, like_count, created_at",
      )
      .eq("user_id", data.id)
      .eq("is_public", true)
      .order("created_at", { ascending: false })
      .limit(40);
    return { profile, routes: routes ?? [] };
  });
