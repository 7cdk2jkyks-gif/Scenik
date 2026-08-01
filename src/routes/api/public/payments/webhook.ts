import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { verifyWebhook, EventName, type PaddleEnv } from "@/lib/paddle.server";
import { serverCapture } from "@/lib/analytics/server";
import { AnalyticsEvent } from "@/lib/analytics/events";

let _supabase: SupabaseClient<Database> | null = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient<Database>(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  }
  return _supabase;
}

function billingPeriodFromPriceId(priceId?: string): "monthly" | "annual" | "unknown" {
  if (!priceId) return "unknown";
  if (priceId.includes("annual")) return "annual";
  if (priceId.includes("monthly")) return "monthly";
  return "unknown";
}

async function handleSubscriptionCreated(data: any, env: PaddleEnv) {
  const { id, customerId, items, status, currentBillingPeriod, customData } = data;
  const userId = customData?.userId;
  if (!userId) {
    console.error("No userId in customData");
    return;
  }
  const item = items[0];
  const priceId = item.price.importMeta?.externalId;
  const productId = item.product.importMeta?.externalId;
  if (!priceId || !productId) {
    console.warn("Skipping subscription: missing importMeta.externalId");
    return;
  }
  await getSupabase().from("subscriptions").upsert(
    {
      user_id: userId,
      paddle_subscription_id: id,
      paddle_customer_id: customerId,
      product_id: productId,
      price_id: priceId,
      status,
      current_period_start: currentBillingPeriod?.startsAt,
      current_period_end: currentBillingPeriod?.endsAt,
      environment: env,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "paddle_subscription_id" },
  );

  const billing = billingPeriodFromPriceId(priceId);
  const isTrial = status === "trialing";
  await serverCapture(
    isTrial ? AnalyticsEvent.PremiumTrialStarted : AnalyticsEvent.PremiumSubscriptionCreatedWebhook,
    userId,
    {
      plan: productId,
      price_id: priceId,
      billing_period: billing,
      status,
      environment: env,
      paddle_subscription_id: id,
      country: data.billingDetails?.address?.countryCode ?? data.address?.countryCode ?? null,
    },
  );
}

async function handleSubscriptionUpdated(data: any, env: PaddleEnv) {
  const { id, status, currentBillingPeriod, scheduledChange } = data;
  await getSupabase()
    .from("subscriptions")
    .update({
      status,
      current_period_start: currentBillingPeriod?.startsAt,
      current_period_end: currentBillingPeriod?.endsAt,
      cancel_at_period_end: scheduledChange?.action === "cancel",
      updated_at: new Date().toISOString(),
    })
    .eq("paddle_subscription_id", id)
    .eq("environment", env);

  // Look up userId for the distinct ID.
  const { data: sub } = await getSupabase()
    .from("subscriptions")
    .select("user_id")
    .eq("paddle_subscription_id", id)
    .maybeSingle();
  if (sub?.user_id) {
    await serverCapture(AnalyticsEvent.PremiumSubscriptionUpdatedWebhook, sub.user_id, {
      status,
      cancel_at_period_end: scheduledChange?.action === "cancel",
      environment: env,
      paddle_subscription_id: id,
    });
  }
}

async function handleSubscriptionCanceled(data: any, env: PaddleEnv) {
  const { data: sub } = await getSupabase()
    .from("subscriptions")
    .select("user_id,price_id")
    .eq("paddle_subscription_id", data.id)
    .maybeSingle();

  await getSupabase()
    .from("subscriptions")
    .update({ status: "canceled", updated_at: new Date().toISOString() })
    .eq("paddle_subscription_id", data.id)
    .eq("environment", env);

  if (sub?.user_id) {
    await serverCapture(AnalyticsEvent.PremiumSubscriptionCanceledWebhook, sub.user_id, {
      environment: env,
      billing_period: billingPeriodFromPriceId(sub.price_id ?? undefined),
      cancellation_reason: data.cancellationReason ?? data.cancelReason ?? null,
      paddle_subscription_id: data.id,
    });
  }
}

async function handleWebhook(req: Request, env: PaddleEnv) {
  const event = await verifyWebhook(req, env);
  switch (event.eventType) {
    case EventName.SubscriptionCreated:
      await handleSubscriptionCreated(event.data, env);
      break;
    case EventName.SubscriptionUpdated:
      await handleSubscriptionUpdated(event.data, env);
      break;
    case EventName.SubscriptionCanceled:
      await handleSubscriptionCanceled(event.data, env);
      break;
    default:
      console.log("Unhandled event:", event.eventType);
  }
}

export const Route = createFileRoute("/api/public/payments/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const env = (url.searchParams.get("env") || "sandbox") as PaddleEnv;
        try {
          await handleWebhook(request, env);
          return Response.json({ received: true });
        } catch (e) {
          console.error("Webhook error:", e);
          return new Response("Webhook error", { status: 400 });
        }
      },
    },
  },
});
