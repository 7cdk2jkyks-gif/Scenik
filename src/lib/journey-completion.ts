export type ArrivalProgress = {
  onRoute: boolean;
  percent: number;
  remainingMeters: number;
};

export type ArrivalState = {
  routeIdentity: string;
  lowestPercent: number;
  highestPercent: number;
  arrivalSamples: number;
  completed: boolean;
};

export function beginArrivalTracking(routeIdentity: string): ArrivalState {
  return {
    routeIdentity,
    lowestPercent: 100,
    highestPercent: 0,
    arrivalSamples: 0,
    completed: false,
  };
}

/**
 * Arrival is deliberately session-scoped. A route must be observed away from its
 * destination and then produce two consecutive, on-route arrival samples. This
 * prevents a restored/replaced route or one noisy GPS fix from completing itself.
 */
export function observeArrival(
  state: ArrivalState,
  routeIdentity: string,
  progress: ArrivalProgress | null,
): ArrivalState {
  if (state.routeIdentity !== routeIdentity) return beginArrivalTracking(routeIdentity);
  if (!progress || state.completed) return state;

  const percent = Math.max(0, Math.min(100, progress.percent));
  const lowestPercent = progress.onRoute
    ? Math.min(state.lowestPercent, percent)
    : state.lowestPercent;
  const highestPercent = progress.onRoute
    ? Math.max(state.highestPercent, percent)
    : state.highestPercent;
  const journeyObserved = lowestPercent <= 95 && highestPercent - lowestPercent >= 1;
  const atDestination = progress.onRoute && (percent >= 99 || progress.remainingMeters <= 60);
  const arrivalSamples = atDestination && journeyObserved ? state.arrivalSamples + 1 : 0;

  return {
    ...state,
    lowestPercent,
    highestPercent,
    arrivalSamples,
    completed: arrivalSamples >= 2,
  };
}
