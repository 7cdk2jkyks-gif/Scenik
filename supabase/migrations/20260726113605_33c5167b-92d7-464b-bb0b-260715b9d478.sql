
DROP POLICY IF EXISTS "Users can delete their own rating" ON public.route_ratings;
DROP POLICY IF EXISTS "Users can insert their own rating" ON public.route_ratings;
DROP POLICY IF EXISTS "Users can update their own rating" ON public.route_ratings;
DROP POLICY IF EXISTS "View own ratings or ratings on public routes" ON public.route_ratings;

CREATE POLICY "Users can delete their own rating" ON public.route_ratings
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id AND (auth.jwt()->>'is_anonymous')::boolean IS NOT TRUE);

CREATE POLICY "Users can insert their own rating" ON public.route_ratings
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND (auth.jwt()->>'is_anonymous')::boolean IS NOT TRUE);

CREATE POLICY "Users can update their own rating" ON public.route_ratings
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id AND (auth.jwt()->>'is_anonymous')::boolean IS NOT TRUE)
  WITH CHECK (auth.uid() = user_id AND (auth.jwt()->>'is_anonymous')::boolean IS NOT TRUE);

CREATE POLICY "View own ratings or ratings on public routes" ON public.route_ratings
  FOR SELECT TO authenticated
  USING (
    (auth.jwt()->>'is_anonymous')::boolean IS NOT TRUE
    AND (
      auth.uid() = user_id
      OR EXISTS (SELECT 1 FROM public.routes r WHERE r.id = route_ratings.route_id AND r.is_public = true)
    )
  );
