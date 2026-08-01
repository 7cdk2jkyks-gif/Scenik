import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getMySubscription, getMyUsage } from "@/lib/payments.functions";
import { getPaddleEnvironment } from "@/lib/paddle";
import { isNativePlatform } from "@/lib/native";
import { useRCPremium } from "@/hooks/useRevenueCat";

/**
 * On the web this is the Paddle subscription record.
 * On native (iOS/Android) RevenueCat's `premium` entitlement is the source of
 * truth for Apple/Google purchases, but we still surface the Paddle record
 * (in case the same account previously bought via the website).
 */
export function useSubscription() {
  const fn = useServerFn(getMySubscription);
  const paddle = useQuery({
    queryKey: ["subscription", getPaddleEnvironment()],
    queryFn: () => fn({ data: { environment: getPaddleEnvironment() } }),
    staleTime: 30_000,
  });
  const rc = useRCPremium();

  const paddlePremium = paddle.data?.isPremium ?? false;
  const rcPremium = isNativePlatform() ? !!rc.data?.isPremium : false;
  const isPremium = paddlePremium || rcPremium;

  return {
    ...paddle,
    data: paddle.data
      ? { ...paddle.data, isPremium }
      : rcPremium
      ? { subscription: null, isPremium: true }
      : paddle.data,
    rc: rc.data,
    isNative: isNativePlatform(),
  };
}

export function useUsage() {
  const fn = useServerFn(getMyUsage);
  return useQuery({
    queryKey: ["usage"],
    queryFn: () => fn(),
    staleTime: 15_000,
  });
}
