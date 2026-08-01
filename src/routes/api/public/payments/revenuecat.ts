// RevenueCat server-to-server webhook.
//
// Configure this URL in the RevenueCat dashboard (Project → Integrations →
// Webhooks) as:
//   https://<your-domain>/api/public/payments/revenuecat
//
// RevenueCat authenticates the webhook with a bearer token you set in the
// dashboard. Store that same token as REVENUECAT_WEBHOOK_AUTH in the project
// secrets so this handler can verify inbound requests.

import { createFileRoute } from "@tanstack/react-router";

type RCEventType =
  | "INITIAL_PURCHASE"
  | "RENEWAL"
  | "NON_RENEWING_PURCHASE"
  | "PRODUCT_CHANGE"
  | "CANCELLATION"
  | "UNCANCELLATION"
  | "EXPIRATION"
  | "BILLING_ISSUE"
  | "SUBSCRIBER_ALIAS"
  | "SUBSCRIPTION_PAUSED"
  | "TEST";

interface RCEvent {
  type: RCEventType;
  app_user_id: string;
  original_app_user_id?: string;
  product_id?: string;
  entitlement_ids?: string[];
  entitlement_id?: string;
  store?: "APP_STORE" | "MAC_APP_STORE" | "PLAY_STORE" | "AMAZON" | "STRIPE" | "PROMOTIONAL";
  environment?: "SANDBOX" | "PRODUCTION";
  purchased_at_ms?: number;
  expiration_at_ms?: number | null;
  transaction_id?: string;
  original_transaction_id?: string;
  cancel_reason?: string | null;
}

interface RCPayload {
  api_version: string;
  event: RCEvent;
}

function providerFromStore(store: RCEvent["store"]): "apple" | "google" | "paddle" {
  if (store === "APP_STORE" || store === "MAC_APP_STORE") return "apple";
  if (store === "PLAY_STORE") return "google";
  return "paddle";
}

function statusFromEvent(type: RCEventType): string {
  switch (type) {
    case "INITIAL_PURCHASE":
    case "RENEWAL":
    case "UNCANCELLATION":
    case "PRODUCT_CHANGE":
    case "NON_RENEWING_PURCHASE":
      return "active";
    case "CANCELLATION":
      return "canceled";
    case "EXPIRATION":
      return "expired";
    case "BILLING_ISSUE":
      return "past_due";
    case "SUBSCRIPTION_PAUSED":
      return "paused";
    default:
      return "active";
  }
}

export const Route = createFileRoute("/api/public/payments/revenuecat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Verify RevenueCat bearer token.
        const expected = process.env.REVENUECAT_WEBHOOK_AUTH;
        const auth = request.headers.get("authorization") ?? "";
        if (!expected || auth !== `Bearer ${expected}`) {
          return new Response("Unauthorized", { status: 401 });
        }

        let payload: RCPayload;
        try {
          payload = (await request.json()) as RCPayload;
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }

        const event = payload.event;
        if (!event || event.type === "TEST") {
          return Response.json({ received: true, test: true });
        }

        const userId = event.app_user_id;
        if (!userId) return new Response("Missing app_user_id", { status: 400 });

        const provider = providerFromStore(event.store);
        const status = statusFromEvent(event.type);
        const environment = event.environment === "PRODUCTION" ? "live" : "sandbox";
        const entitlementId =
          event.entitlement_ids?.[0] ?? event.entitlement_id ?? "premium";

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Upsert by (provider, store_transaction_id) when we have one, otherwise
        // fall back to (user_id, provider, entitlement_id).
        const row = {
          user_id: userId,
          provider,
          revenuecat_app_user_id: userId,
          entitlement_id: entitlementId,
          store_transaction_id: event.original_transaction_id ?? event.transaction_id ?? null,
          product_id: event.product_id ?? entitlementId,
          price_id: event.product_id ?? entitlementId,

          status,
          environment,
          current_period_start: event.purchased_at_ms
            ? new Date(event.purchased_at_ms).toISOString()
            : null,
          current_period_end: event.expiration_at_ms
            ? new Date(event.expiration_at_ms).toISOString()
            : null,
          cancel_at_period_end: event.type === "CANCELLATION",
          updated_at: new Date().toISOString(),
        };

        if (row.store_transaction_id) {
          await supabaseAdmin
            .from("subscriptions")
            .upsert(row, { onConflict: "provider,store_transaction_id" });
        } else {
          const { data: existing } = await supabaseAdmin
            .from("subscriptions")
            .select("id")
            .eq("user_id", userId)
            .eq("provider", provider)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (existing) {
            await supabaseAdmin.from("subscriptions").update(row).eq("id", existing.id);
          } else {
            await supabaseAdmin.from("subscriptions").insert(row);
          }
        }

        return Response.json({ received: true });
      },
    },
  },
});
