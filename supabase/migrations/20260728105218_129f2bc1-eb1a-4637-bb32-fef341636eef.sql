-- 1. Restrict profiles SELECT to self only; expose safe public fields via a view.
DROP POLICY IF EXISTS "Users can view own or public-author profiles" ON public.profiles;

CREATE POLICY "Users view own profile"
ON public.profiles
FOR SELECT
TO authenticated
USING (auth.uid() = id);

-- Safe public view: only non-sensitive columns, only for users who have shared a public route.
-- Owned by postgres so it bypasses base-table RLS; readable by anon + authenticated.
CREATE OR REPLACE VIEW public.public_profiles
WITH (security_invoker = false) AS
SELECT p.id, p.display_name, p.avatar_url, p.bio, p.created_at
FROM public.profiles p
WHERE EXISTS (
  SELECT 1 FROM public.routes r WHERE r.user_id = p.id AND r.is_public = true
);

GRANT SELECT ON public.public_profiles TO anon, authenticated;

-- 2. Road reports: exclude anonymous guests from reading.
DROP POLICY IF EXISTS "Authenticated can read active reports" ON public.road_reports;

CREATE POLICY "Non-anonymous users read active reports"
ON public.road_reports
FOR SELECT
TO authenticated
USING (
  expires_at > now()
  AND COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
);

-- 3. Route likes: exclude anonymous guests from all actions.
DROP POLICY IF EXISTS "Likes on public routes readable" ON public.route_likes;
DROP POLICY IF EXISTS "Users delete own likes" ON public.route_likes;
DROP POLICY IF EXISTS "Users insert own likes on public routes" ON public.route_likes;

CREATE POLICY "Non-anon users read likes on public routes"
ON public.route_likes
FOR SELECT
TO authenticated
USING (
  COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
  AND EXISTS (
    SELECT 1 FROM public.routes r
    WHERE r.id = route_likes.route_id AND r.is_public = true
  )
);

CREATE POLICY "Non-anon users insert own likes on public routes"
ON public.route_likes
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
  AND EXISTS (
    SELECT 1 FROM public.routes r
    WHERE r.id = route_likes.route_id AND r.is_public = true
  )
);

CREATE POLICY "Non-anon users delete own likes"
ON public.route_likes
FOR DELETE
TO authenticated
USING (
  auth.uid() = user_id
  AND COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
);