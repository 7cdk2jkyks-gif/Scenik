-- Tighten route_comments: no more `public` role access
DROP POLICY IF EXISTS "Comments on public routes readable" ON public.route_comments;
DROP POLICY IF EXISTS "Users comment on public routes" ON public.route_comments;
DROP POLICY IF EXISTS "Users delete own comments" ON public.route_comments;

CREATE POLICY "Comments on public routes readable by non-anon"
  ON public.route_comments FOR SELECT
  TO authenticated
  USING (
    (COALESCE(((auth.jwt() ->> 'is_anonymous')::boolean), false) = false)
    AND EXISTS (
      SELECT 1 FROM public.routes r
      WHERE r.id = route_comments.route_id AND r.is_public = true
    )
  );

CREATE POLICY "Non-anon users comment on public routes"
  ON public.route_comments FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND (COALESCE(((auth.jwt() ->> 'is_anonymous')::boolean), false) = false)
    AND EXISTS (
      SELECT 1 FROM public.routes r
      WHERE r.id = route_comments.route_id AND r.is_public = true
    )
  );

CREATE POLICY "Non-anon users delete own comments"
  ON public.route_comments FOR DELETE
  TO authenticated
  USING (
    auth.uid() = user_id
    AND (COALESCE(((auth.jwt() ->> 'is_anonymous')::boolean), false) = false)
  );

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.route_comments FROM anon;

-- Revoke EXECUTE on SECURITY DEFINER helpers from anon/authenticated;
-- these are now called only from privileged server code (service_role).
REVOKE EXECUTE ON FUNCTION public.get_public_profile(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_public_profiles(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_profile(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_public_profiles(uuid[]) TO service_role;