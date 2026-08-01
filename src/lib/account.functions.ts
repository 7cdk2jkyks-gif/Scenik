import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const deleteMyAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const userId = context.userId;

    // Explicit cleanup of user-owned rows. Most cascade via auth.users FK,
    // but we clear them explicitly so account deletion is auditable and
    // guarantees no residual location-linked data (road reports, saved
    // routes, ratings, preferences) remains.
    await Promise.all([
      supabaseAdmin.from("road_reports").delete().eq("user_id", userId),
      supabaseAdmin.from("route_ratings").delete().eq("user_id", userId),
      supabaseAdmin.from("route_likes").delete().eq("user_id", userId),
      supabaseAdmin.from("route_comments").delete().eq("user_id", userId),
      supabaseAdmin.from("saved_searches").delete().eq("user_id", userId),
      supabaseAdmin.from("route_generations").delete().eq("user_id", userId),
      supabaseAdmin.from("user_badges").delete().eq("user_id", userId),
      supabaseAdmin.from("subscriptions").delete().eq("user_id", userId),
      supabaseAdmin.from("routes").delete().eq("user_id", userId),
    ]);
    await supabaseAdmin.from("profiles").delete().eq("id", userId);

    const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

