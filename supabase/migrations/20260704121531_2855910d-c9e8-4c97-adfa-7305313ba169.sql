
REVOKE EXECUTE ON FUNCTION public.award_badge(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_route_badges() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_community_badges() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.count_generations_this_month(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_active_subscription(uuid, text) FROM PUBLIC, anon;
