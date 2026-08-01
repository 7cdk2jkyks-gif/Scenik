
-- profiles: restrict SELECT to authenticated users only
DROP POLICY IF EXISTS "Profiles are public to read" ON public.profiles;
CREATE POLICY "Authenticated users can view profiles" ON public.profiles
  FOR SELECT TO authenticated USING (true);

-- route_ratings: only ratings on public routes are visible
DROP POLICY IF EXISTS "Ratings are readable by anyone" ON public.route_ratings;
CREATE POLICY "Ratings on public routes are viewable" ON public.route_ratings
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.routes r WHERE r.id = route_ratings.route_id AND r.is_public = true));
CREATE POLICY "Users can view own ratings" ON public.route_ratings
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- user_badges: restrict SELECT to authenticated only
DROP POLICY IF EXISTS "Anyone can view badges" ON public.user_badges;
DROP POLICY IF EXISTS "Service role manages badges" ON public.user_badges;
CREATE POLICY "Authenticated users can view badges" ON public.user_badges
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages badges" ON public.user_badges
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Revoke anon SELECT on these tables (they had public/anon read access via policies)
REVOKE SELECT ON public.profiles FROM anon;
REVOKE SELECT ON public.route_ratings FROM anon;
REVOKE SELECT ON public.user_badges FROM anon;
