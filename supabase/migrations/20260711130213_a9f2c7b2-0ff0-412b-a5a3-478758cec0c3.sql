ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'paddle',
  ADD COLUMN IF NOT EXISTS revenuecat_app_user_id TEXT,
  ADD COLUMN IF NOT EXISTS entitlement_id TEXT,
  ADD COLUMN IF NOT EXISTS store_transaction_id TEXT;

ALTER TABLE public.subscriptions
  ALTER COLUMN paddle_subscription_id DROP NOT NULL,
  ALTER COLUMN paddle_customer_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS subscriptions_rc_app_user_id_idx
  ON public.subscriptions (revenuecat_app_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_store_transaction_uniq
  ON public.subscriptions (provider, store_transaction_id)
  WHERE store_transaction_id IS NOT NULL;