import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const ReportKind = z.enum(["camera", "closure", "works", "hazard"]);

const CreateInput = z.object({
  kind: ReportKind,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  note: z.string().max(280).default(""),
});

export const createRoadReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => CreateInput.parse(input))
  .handler(async ({ data, context }) => {
    const { error, data: row } = await context.supabase
      .from("road_reports")
      .insert({ ...data, user_id: context.userId })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

const ListInput = z.object({
  // Bounding box (optional). If omitted, returns recent reports.
  minLat: z.number().optional(),
  maxLat: z.number().optional(),
  minLng: z.number().optional(),
  maxLng: z.number().optional(),
});

export const listRoadReports = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ListInput.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("road_reports")
      .select("id,user_id,kind,lat,lng,note,expires_at,created_at")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(500);
    if (data.minLat !== undefined && data.maxLat !== undefined) {
      q = q.gte("lat", data.minLat).lte("lat", data.maxLat);
    }
    if (data.minLng !== undefined && data.maxLng !== undefined) {
      q = q.gte("lng", data.minLng).lte("lng", data.maxLng);
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const deleteRoadReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("road_reports").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
