import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { gatewayFetch, getPaddleClient, type PaddleEnv } from "@/lib/paddle.server";
import { serverCapture } from "@/lib/analytics/server";
import { AnalyticsEvent } from "@/lib/analytics/events";

export const resolvePaddlePrice = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    z.object({ priceId: z.string(), environment: z.enum(["sandbox", "live"]) }).parse(data),
  )
  .handler(async ({ data }) => {
    const response = await gatewayFetch(
      data.environment as PaddleEnv,
      `/prices?external_id=${encodeURIComponent(data.priceId)}`,
    );
    const result = await response.json();
    if (!result.data?.length) throw new Error("Price not found");
    return result.data[0].id as string;
  });

export const getMySubscription = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z.object({ environment: z.enum(["sandbox", "live"]) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const { data: rows } = await context.supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", context.userId)
      .eq("environment", data.environment)
      .order("created_at", { ascending: false })
      .limit(1);
    const sub = rows?.[0] ?? null;
    if (!sub) return { subscription: null, isPremium: false };
    const now = Date.now();
    const end = sub.current_period_end ? new Date(sub.current_period_end).getTime() : null;
    const isPremium =
      (["active", "trialing", "past_due"].includes(sub.status) && (!end || end > now)) ||
      (sub.status === "canceled" && !!end && end > now);
    return { subscription: sub, isPremium };
  });

export const getMyUsage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const { count } = await context.supabase
      .from("route_generations")
      .select("*", { count: "exact", head: true })
      .eq("user_id", context.userId)
      .gte("created_at", monthStart.toISOString());
    return { generationsThisMonth: count ?? 0, freeLimit: 3 };
  });

export const getMyBadges = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("user_badges")
      .select("badge_key, awarded_at")
      .eq("user_id", context.userId)
      .order("awarded_at", { ascending: false });
    return data ?? [];
  });

export const getUserBadges = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => z.object({ userId: z.string().uuid() }).parse(data))
  .handler(async ({ data }) => {
    const { createClient } = await import("@supabase/supabase-js");
    const supabasePublic = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_PUBLISHABLE_KEY!,
      { auth: { storage: undefined, persistSession: false, autoRefreshToken: false } },
    );
    const { data: rows } = await supabasePublic
      .from("user_badges")
      .select("badge_key, awarded_at")
      .eq("user_id", data.userId)
      .order("awarded_at", { ascending: false });
    return rows ?? [];
  });

export const getCustomerPortalUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z.object({ environment: z.enum(["sandbox", "live"]) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const { data: rows } = await context.supabase
      .from("subscriptions")
      .select("paddle_customer_id, paddle_subscription_id")
      .eq("user_id", context.userId)
      .eq("environment", data.environment)
      .eq("provider", "paddle")
      .order("created_at", { ascending: false })
      .limit(1);
    const sub = rows?.[0];
    if (!sub || !sub.paddle_customer_id || !sub.paddle_subscription_id) {
      throw new Error("No Paddle subscription found");
    }
    const paddle = getPaddleClient(data.environment as PaddleEnv);
    const session = await paddle.customerPortalSessions.create(sub.paddle_customer_id, [
      sub.paddle_subscription_id,
    ]);
    return session.urls.general.overview as string;
  });


export const cancelMySubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z.object({ environment: z.enum(["sandbox", "live"]) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const { data: rows } = await context.supabase
      .from("subscriptions")
      .select("paddle_subscription_id, status")
      .eq("user_id", context.userId)
      .eq("environment", data.environment)
      .eq("provider", "paddle")
      .order("created_at", { ascending: false })
      .limit(1);
    const sub = rows?.[0];
    if (!sub || !sub.paddle_subscription_id) throw new Error("No active Paddle subscription");
    if (sub.status === "canceled") return { ok: true, alreadyCanceled: true };
    const paddle = getPaddleClient(data.environment as PaddleEnv);
    await paddle.subscriptions.cancel(sub.paddle_subscription_id, {
      effectiveFrom: "next_billing_period",
    });
    return { ok: true };
  });


export const resumeMySubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z.object({ environment: z.enum(["sandbox", "live"]) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const { data: rows } = await context.supabase
      .from("subscriptions")
      .select("paddle_subscription_id, status, cancel_at_period_end")
      .eq("user_id", context.userId)
      .eq("environment", data.environment)
      .eq("provider", "paddle")
      .order("created_at", { ascending: false })
      .limit(1);
    const sub = rows?.[0];
    if (!sub || !sub.paddle_subscription_id) throw new Error("No Paddle subscription to resume");
    const paddle = getPaddleClient(data.environment as PaddleEnv);
    // Clear the scheduled cancellation
    await paddle.subscriptions.update(sub.paddle_subscription_id, {
      scheduledChange: null,
    });
    return { ok: true };
  });


export const restorePurchases = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z.object({ environment: z.enum(["sandbox", "live"]) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const env = data.environment as PaddleEnv;

    const { data: userData, error: userError } = await context.supabase.auth.getUser();
    if (userError || !userData.user?.email) {
      throw new Error("Could not retrieve your account email");
    }
    const email = userData.user.email;

    const customersResponse = await gatewayFetch(
      env,
      `/customers?email=${encodeURIComponent(email)}&status=active`,
    );
    if (!customersResponse.ok) {
      throw new Error("Could not look up customer record");
    }
    const customersResult = await customersResponse.json();
    const customers = Array.isArray(customersResult.data) ? customersResult.data : [];
    if (!customers.length) {
      return { restored: false, reason: "no_customer" };
    }

    const statusPriority: Record<string, number> = {
      active: 0,
      trialing: 1,
      past_due: 2,
      canceled: 3,
    };

    let bestSub: any = null;

    for (const customer of customers) {
      const subsResponse = await gatewayFetch(
        env,
        `/subscriptions?customer_id=${encodeURIComponent(customer.id)}&per_page=50`,
      );
      if (!subsResponse.ok) continue;
      const subsResult = await subsResponse.json();
      const subs = Array.isArray(subsResult.data) ? subsResult.data : [];

      for (const sub of subs) {
        if (!bestSub) {
          bestSub = sub;
          continue;
        }
        const aPriority = statusPriority[sub.status] ?? 99;
        const bPriority = statusPriority[bestSub.status] ?? 99;
        if (aPriority !== bPriority) {
          if (aPriority < bPriority) bestSub = sub;
          continue;
        }
        const aEnd = sub.currentBillingPeriod?.endsAt
          ? new Date(sub.currentBillingPeriod.endsAt).getTime()
          : 0;
        const bEnd = bestSub.currentBillingPeriod?.endsAt
          ? new Date(bestSub.currentBillingPeriod.endsAt).getTime()
          : 0;
        if (aEnd > bEnd) bestSub = sub;
      }
    }

    if (!bestSub) {
      return { restored: false, reason: "no_subscription" };
    }

    const item = bestSub.items?.[0];
    const priceId = item?.price?.importMeta?.externalId;
    const productId = item?.product?.importMeta?.externalId;
    if (!priceId || !productId) {
      return { restored: false, reason: "missing_product_info" };
    }

    const { error: upsertError } = await context.supabase.from("subscriptions").upsert(
      {
        user_id: context.userId,
        paddle_subscription_id: bestSub.id,
        paddle_customer_id: bestSub.customerId,
        product_id: productId,
        price_id: priceId,
        status: bestSub.status,
        current_period_start: bestSub.currentBillingPeriod?.startsAt,
        current_period_end: bestSub.currentBillingPeriod?.endsAt,
        cancel_at_period_end: bestSub.scheduledChange?.action === "cancel",
        environment: env,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "paddle_subscription_id" },
    );

    if (upsertError) throw new Error(upsertError.message);

    await serverCapture(AnalyticsEvent.PremiumSubscriptionRestored, context.userId, {
      paddle_subscription_id: bestSub.id,
      product_id: productId,
      price_id: priceId,
      status: bestSub.status,
      environment: env,
    });

    return { restored: true };
  });
