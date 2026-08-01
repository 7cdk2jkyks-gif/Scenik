
-- user_badges: restrict SELECT to own rows
DROP POLICY IF EXISTS "Authenticated users can view badges" ON public.user_badges;
CREATE POLICY "Users view own badges" ON public.user_badges
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- subscriptions: restrict to non-anonymous authenticated users
DROP POLICY IF EXISTS "Users view own subscription" ON public.subscriptions;
CREATE POLICY "Users view own subscription" ON public.subscriptions
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id AND ((auth.jwt() ->> 'is_anonymous')::boolean IS NOT TRUE));

-- route_generations: allow authenticated users to insert their own usage rows
GRANT INSERT ON public.route_generations TO authenticated;
CREATE POLICY "Users insert own generations" ON public.route_generations
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
