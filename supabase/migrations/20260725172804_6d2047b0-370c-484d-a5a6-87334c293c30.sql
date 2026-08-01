DROP POLICY IF EXISTS "Public routes readable by anyone" ON public.routes;
CREATE POLICY "Public routes readable by authenticated"
ON public.routes
FOR SELECT
TO authenticated
USING (
  is_public = true
  AND (auth.jwt() ->> 'is_anonymous')::boolean IS NOT TRUE
);
REVOKE SELECT ON public.routes FROM anon;