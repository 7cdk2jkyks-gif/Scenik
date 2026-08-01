DROP POLICY IF EXISTS "Users manage own searches" ON public.saved_searches;
CREATE POLICY "Users manage own searches" ON public.saved_searches
FOR ALL
TO authenticated
USING (auth.uid() = user_id AND COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false) = false)
WITH CHECK (auth.uid() = user_id AND COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false) = false);