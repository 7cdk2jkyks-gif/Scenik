
-- Subscriptions
CREATE TABLE public.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  paddle_subscription_id text NOT NULL UNIQUE,
  paddle_customer_id text NOT NULL,
  product_id text NOT NULL,
  price_id text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean DEFAULT false,
  environment text NOT NULL DEFAULT 'sandbox',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX idx_subscriptions_user_id ON public.subscriptions(user_id);
CREATE INDEX idx_subscriptions_paddle_id ON public.subscriptions(paddle_subscription_id);

GRANT SELECT ON public.subscriptions TO authenticated;
GRANT ALL ON public.subscriptions TO service_role;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own subscription" ON public.subscriptions FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "Service role manages subscriptions" ON public.subscriptions FOR ALL
  USING (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION public.has_active_subscription(user_uuid uuid, check_env text DEFAULT 'live')
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.subscriptions
    WHERE user_id = user_uuid
      AND environment = check_env
      AND (
        (status IN ('active','trialing','past_due') AND (current_period_end IS NULL OR current_period_end > now()))
        OR (status = 'canceled' AND current_period_end > now())
      )
  );
$$;

-- Route generation counter (for free-tier 10/month cap)
CREATE TABLE public.route_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX idx_route_generations_user_time ON public.route_generations(user_id, created_at DESC);

GRANT SELECT ON public.route_generations TO authenticated;
GRANT ALL ON public.route_generations TO service_role;
ALTER TABLE public.route_generations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own generations" ON public.route_generations FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "Service role manages generations" ON public.route_generations FOR ALL
  USING (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION public.count_generations_this_month(user_uuid uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COUNT(*)::int FROM public.route_generations
  WHERE user_id = user_uuid AND created_at >= date_trunc('month', now());
$$;

-- Badges
CREATE TABLE public.user_badges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  badge_key text NOT NULL,
  awarded_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE (user_id, badge_key)
);
CREATE INDEX idx_user_badges_user ON public.user_badges(user_id);

GRANT SELECT ON public.user_badges TO authenticated;
GRANT SELECT ON public.user_badges TO anon;
GRANT ALL ON public.user_badges TO service_role;
ALTER TABLE public.user_badges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view badges" ON public.user_badges FOR SELECT USING (true);
CREATE POLICY "Service role manages badges" ON public.user_badges FOR ALL USING (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION public.award_badge(user_uuid uuid, key text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.user_badges (user_id, badge_key) VALUES (user_uuid, key)
  ON CONFLICT (user_id, badge_key) DO NOTHING;
$$;

-- Milestone + explorer badges on route save
CREATE OR REPLACE FUNCTION public.check_route_badges()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  route_count int;
  theme_count int;
  theme_lower text;
BEGIN
  SELECT COUNT(*) INTO route_count FROM public.routes WHERE user_id = NEW.user_id;

  IF route_count >= 1 THEN PERFORM public.award_badge(NEW.user_id, 'first_route'); END IF;
  IF route_count >= 10 THEN PERFORM public.award_badge(NEW.user_id, 'ten_routes'); END IF;
  IF route_count >= 50 THEN PERFORM public.award_badge(NEW.user_id, 'fifty_routes'); END IF;
  IF route_count >= 100 THEN PERFORM public.award_badge(NEW.user_id, 'hundred_routes'); END IF;

  -- Explorer badges: 5 routes of the same theme
  theme_lower := lower(coalesce(NEW.theme, ''));
  IF theme_lower <> '' AND theme_lower <> 'open' AND theme_lower <> 'direct route' THEN
    SELECT COUNT(*) INTO theme_count FROM public.routes
      WHERE user_id = NEW.user_id AND lower(theme) = theme_lower;
    IF theme_count >= 5 THEN
      PERFORM public.award_badge(NEW.user_id, 'theme_' || regexp_replace(theme_lower, '[^a-z0-9]+', '_', 'g'));
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_route_badges AFTER INSERT ON public.routes
  FOR EACH ROW EXECUTE FUNCTION public.check_route_badges();

-- Community badges (likes received + first share)
CREATE OR REPLACE FUNCTION public.check_community_badges()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  route_owner uuid;
  total_likes int;
BEGIN
  SELECT user_id, like_count INTO route_owner, total_likes
    FROM public.routes WHERE id = NEW.route_id;
  IF route_owner IS NULL THEN RETURN NEW; END IF;
  PERFORM public.award_badge(route_owner, 'first_share');
  IF total_likes >= 10 THEN PERFORM public.award_badge(route_owner, 'ten_likes'); END IF;
  IF total_likes >= 50 THEN PERFORM public.award_badge(route_owner, 'fifty_likes'); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_community_badges AFTER INSERT ON public.route_likes
  FOR EACH ROW EXECUTE FUNCTION public.check_community_badges();
