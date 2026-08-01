-- 1) Tighten route_generations policies to non-anonymous authenticated users only
DROP POLICY IF EXISTS "Users view own generations" ON public.route_generations;
DROP POLICY IF EXISTS "Users insert own generations" ON public.route_generations;
DROP POLICY IF EXISTS "Service role manages generations" ON public.route_generations;

CREATE POLICY "Users view own generations"
  ON public.route_generations FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id
    AND COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
  );

CREATE POLICY "Users insert own generations"
  ON public.route_generations FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
  );

CREATE POLICY "Service role manages generations"
  ON public.route_generations FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.route_generations FROM anon;

-- 2) Lock down SECURITY DEFINER function EXECUTE grants.
--    Trigger-only and server-only helpers: revoke from PUBLIC / anon / authenticated.
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.route_ratings_aggregate_trigger() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.route_likes_count_trigger() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.route_comments_count_trigger() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.award_badge(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_community_badges() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_route_badges() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.has_active_subscription(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.count_generations_this_month(uuid) FROM PUBLIC, anon, authenticated;

-- 3) Safe public-profile lookups remain callable via the Data API.
--    They are SECURITY DEFINER wrappers that only return non-sensitive columns
--    for users who have shared at least one public route.
REVOKE EXECUTE ON FUNCTION public.get_public_profile(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_public_profiles(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_profile(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_profiles(uuid[]) TO anon, authenticated;