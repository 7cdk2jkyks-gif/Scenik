import { describe, expect, it } from "bun:test";
import { beginArrivalTracking, observeArrival } from "./journey-completion";

const sample = (percent: number, remainingMeters: number, onRoute = true) => ({
  percent,
  remainingMeters,
  onRoute,
});

describe("arrival tracking", () => {
  it("completes after a journey and two genuine arrival samples", () => {
    let state = beginArrivalTracking("selected-route");
    state = observeArrival(state, "selected-route", sample(20, 8_000));
    state = observeArrival(state, "selected-route", sample(99.2, 45));
    expect(state.completed).toBe(false);
    state = observeArrival(state, "selected-route", sample(99.4, 35));
    expect(state.completed).toBe(true);
  });

  it("does not complete after restart, GPS loss, reroute, or route replacement", () => {
    let state = beginArrivalTracking("route-a");
    state = observeArrival(state, "route-a", sample(99.5, 20));
    state = observeArrival(state, "route-a", sample(99.7, 10));
    expect(state.completed).toBe(false);
    state = observeArrival(state, "route-a", sample(30, 4_000));
    state = observeArrival(state, "route-a", sample(99.2, 40));
    state = observeArrival(state, "route-a", null);
    expect(state.completed).toBe(false);
    state = observeArrival(state, "route-b", sample(99.8, 10));
    expect(state.completed).toBe(false);
    expect(state.routeIdentity).toBe("route-b");
  });

  it("supports legacy routes through their derived identity", () => {
    let state = beginArrivalTracking("legacy-derived-route");
    state = observeArrival(state, "legacy-derived-route", sample(0, 10_000));
    state = observeArrival(state, "legacy-derived-route", sample(99, 50));
    state = observeArrival(state, "legacy-derived-route", sample(100, 0));
    expect(state.completed).toBe(true);
  });
});
