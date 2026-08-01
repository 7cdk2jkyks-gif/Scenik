DROP POLICY IF EXISTS "Authenticated users can view badges" ON public.user_badges;
CREATE POLICY "Authenticated users can view badges"
ON public.user_badges
FOR SELECT
TO authenticated
USING (auth.uid() IS NOT NULL AND (auth.jwt() ->> 'is_anonymous')::boolean IS NOT TRUE);