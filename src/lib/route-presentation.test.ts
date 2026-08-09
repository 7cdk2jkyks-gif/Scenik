import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mapRemainingDurationSeconds,
  selectedRouteDurationSeconds,
  selectedRoutePresentation,
} from "./route-presentation";

function result(selectedMinutes: number, polyline: string) {
  return {
    selectedRouteDurationSeconds: selectedMinutes * 60,
    directions: {
      encodedPolyline: polyline,
      durationSeconds: selectedMinutes * 60,
      duration: `${selectedMinutes} min`,
      distanceMeters: selectedMinutes * 100,
      distance: `${selectedMinutes / 10} km`,
      steps: [{ distanceMeters: selectedMinutes * 100, durationSeconds: selectedMinutes * 60 }],
    },
  };
}

describe("selected route presentation", () => {
  it("displays each selected candidate rather than the 381-minute baseline", () => {
    const plusFive = selectedRoutePresentation(result(385, "route-plus-five"));
    const plusSixty = selectedRoutePresentation(result(429, "route-plus-sixty"));
    assert.equal(plusFive?.durationSeconds / 60, 385);
    assert.equal(plusSixty?.durationSeconds / 60, 429);
    assert.notEqual(plusFive?.identityFingerprint, plusSixty?.identityFingerprint);
  });

  it("route B cannot retain route A duration", () => {
    const routeA = selectedRoutePresentation(result(381, "route-a"));
    const routeB = selectedRoutePresentation(result(429, "route-b"));
    assert.equal(routeA?.durationSeconds, 22_860);
    assert.equal(routeB?.durationSeconds, 25_740);
  });

  it("uses remaining navigation duration when available", () => {
    assert.equal(mapRemainingDurationSeconds(25_740, { remainingSeconds: 12_000 }), 12_000);
    assert.equal(mapRemainingDurationSeconds(25_740, null), 25_740);
  });

  it("supports legacy routes with only the older duration field", () => {
    assert.equal(selectedRouteDurationSeconds({ directions: { duration: "6 hr 21 min" } }), 22_860);
  });
});
