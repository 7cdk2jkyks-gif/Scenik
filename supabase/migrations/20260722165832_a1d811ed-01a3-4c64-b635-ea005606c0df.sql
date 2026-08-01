
-- 1. profiles: restrict SELECT
DROP POLICY IF EXISTS "Authenticated users can view profiles" ON public.profiles;

CREATE POLICY "Users can view own or public-author profiles"
ON public.profiles
FOR SELECT
TO authenticated
USING (
  auth.uid() = id
  OR EXISTS (
    SELECT 1 FROM public.routes r
    WHERE r.user_id = profiles.id AND r.is_public = true
  )
);

-- 2. route_ratings: consolidate overlapping SELECT policies
DROP POLICY IF EXISTS "Users can view own ratings" ON public.route_ratings;
DROP POLICY IF EXISTS "Ratings on public routes are viewable" ON public.route_ratings;

CREATE POLICY "View own ratings or ratings on public routes"
ON public.route_ratings
FOR SELECT
TO authenticated
USING (
  auth.uid() = user_id
  OR EXISTS (
    SELECT 1 FROM public.routes r
    WHERE r.id = route_ratings.route_id AND r.is_public = true
  )
);

-- 3. subscriptions: scope policies to authenticated / service_role, not public
DROP POLICY IF EXISTS "Users view own subscription" ON public.subscriptions;
DROP POLICY IF EXISTS "Service role manages subscriptions" ON public.subscriptions;

CREATE POLICY "Users view own subscription"
ON public.subscriptions
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Service role manages subscriptions"
ON public.subscriptions
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
