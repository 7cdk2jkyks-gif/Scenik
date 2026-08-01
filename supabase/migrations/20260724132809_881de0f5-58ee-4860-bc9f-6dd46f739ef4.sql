DROP POLICY IF EXISTS "Users manage own routes" ON public.routes;

CREATE POLICY "Users manage own routes"
ON public.routes
FOR ALL
TO authenticated
USING (
  auth.uid() = user_id
  AND (auth.jwt() ->> 'is_anonymous')::boolean IS NOT TRUE
)
WITH CHECK (
  auth.uid() = user_id
  AND (auth.jwt() ->> 'is_anonymous')::boolean IS NOT TRUE
);