import { useCallback, useEffect, useRef, type ComponentProps } from "react";
import { ScenicMap, type RouteProgress } from "@/components/ScenicMap";

type ScenicMapProps = ComponentProps<typeof ScenicMap>;

export type ActiveNavigationMapProps = Omit<ScenicMapProps, "onProgress"> & {
  journeyIdentity: string;
  onProgress(progress: RouteProgress | null): void;
};

/** The active GPS boundary deliberately exposes no route-replacement callback. */
export function ActiveNavigationMap({
  journeyIdentity,
  onProgress,
  ...mapProps
}: ActiveNavigationMapProps) {
  const currentJourneyIdentityRef = useRef(journeyIdentity);
  currentJourneyIdentityRef.current = journeyIdentity;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleProgress = useCallback(
    (progress: RouteProgress | null) => {
      if (!mountedRef.current || currentJourneyIdentityRef.current !== journeyIdentity) return;
      onProgressRef.current(progress);
    },
    [journeyIdentity],
  );

  return <ScenicMap {...mapProps} onProgress={handleProgress} />;
}
