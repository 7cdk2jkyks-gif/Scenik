import type { Database } from "@/integrations/supabase/types";
import { canonicalVerifiedUserId } from "./verified-user-id.server";

export const FREE_ROUTE_GENERATION_LIMIT = 3;

export type MeteringFailureCode =
  | "ROUTE_GENERATION_METERING_READ_FAILED"
  | "ROUTE_GENERATION_METERING_INSERT_FAILED";

type MeteringClient = {
  from(table: "route_generations"): {
    select(
      columns: "*",
      options: { count: "exact"; head: true },
    ): {
      eq(
        column: "user_id",
        value: string,
      ): {
        gte(
          column: "created_at",
          value: string,
        ): PromiseLike<{
          count: number | null;
          error: { code?: string } | null;
        }>;
      };
    };
    insert(row: Database["public"]["Tables"]["route_generations"]["Insert"]): PromiseLike<{
      error: { code?: string } | null;
    }>;
  };
};

export class RouteGenerationMeteringError extends Error {
  constructor(readonly code: MeteringFailureCode) {
    super(code);
    this.name = "RouteGenerationMeteringError";
  }
}

export function currentCalendarMonthStart(now = new Date()): Date {
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

export function enforceRouteGenerationAllowance(input: {
  usedThisMonth: number;
  isPremium: boolean;
  internalTester: boolean;
}): void {
  if (
    !input.internalTester &&
    !input.isPremium &&
    input.usedThisMonth >= FREE_ROUTE_GENERATION_LIMIT
  ) {
    throw new Error(`FREE_LIMIT_REACHED:${FREE_ROUTE_GENERATION_LIMIT}`);
  }
}

function requireVerifiedUserId(userId: string): string {
  const canonicalUserId = canonicalVerifiedUserId(userId);
  if (!canonicalUserId) {
    throw new RouteGenerationMeteringError("ROUTE_GENERATION_METERING_READ_FAILED");
  }
  return canonicalUserId;
}

export async function readRouteGenerationUsage(input: {
  client: MeteringClient;
  verifiedUserId: string;
  monthStart?: Date;
}): Promise<number> {
  const userId = requireVerifiedUserId(input.verifiedUserId);
  try {
    const { count, error } = await input.client
      .from("route_generations")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", (input.monthStart ?? currentCalendarMonthStart()).toISOString());
    if (error || count == null || !Number.isSafeInteger(count) || count < 0) {
      throw new RouteGenerationMeteringError("ROUTE_GENERATION_METERING_READ_FAILED");
    }
    return count;
  } catch (error) {
    if (error instanceof RouteGenerationMeteringError) throw error;
    throw new RouteGenerationMeteringError("ROUTE_GENERATION_METERING_READ_FAILED");
  }
}

export async function recordRouteGeneration(input: {
  client: MeteringClient;
  verifiedUserId: string;
}): Promise<void> {
  const userId = requireVerifiedUserId(input.verifiedUserId);
  try {
    const { error } = await input.client.from("route_generations").insert({ user_id: userId });
    if (error) {
      throw new RouteGenerationMeteringError("ROUTE_GENERATION_METERING_INSERT_FAILED");
    }
  } catch (error) {
    if (error instanceof RouteGenerationMeteringError) throw error;
    throw new RouteGenerationMeteringError("ROUTE_GENERATION_METERING_INSERT_FAILED");
  }
}

export async function readServerRouteGenerationUsage(verifiedUserId: string): Promise<number> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return readRouteGenerationUsage({ client: supabaseAdmin, verifiedUserId });
}

export async function recordServerRouteGeneration(verifiedUserId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return recordRouteGeneration({ client: supabaseAdmin, verifiedUserId });
}
