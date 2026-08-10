import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mapRemainingDurationSeconds,
  selectedRouteDurationSeconds,
  selectedRoutePresentation,
  timeBudgetExplanation,
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

  it("explains strong, balanced and low allowance utilisation without implying failure", () => {
    assert.equal(
      timeBudgetExplanation(48 * 60, 60).explanation,
      "Your larger allowance unlocked this route.",
    );
    assert.equal(
      timeBudgetExplanation(30 * 60, 60).explanation,
      "This was the best balance of scenery and journey time.",
    );
    assert.equal(
      timeBudgetExplanation(18 * 60, 60).explanation,
      "We couldn’t find a suitable route using all of your requested time, so we chose the strongest journey available.",
    );
    assert.equal(
      timeBudgetExplanation(18 * 60, 60, false).explanation,
      "We found a scenic option without using your full allowance.",
    );
    assert.equal(
      timeBudgetExplanation(0, 85, false).explanation,
      "The selected journey stays close to the fastest route.",
    );
    assert.equal(
      timeBudgetExplanation(15 * 60, 85, true, "LONGER_WEAKENED_QUALITY").explanation,
      "Longer routes were available, but they weakened the journey too much.",
    );
  });

  it("explains below-target outcomes truthfully", () => {
    assert.equal(
      timeBudgetExplanation(15 * 60, 85, true, "LONGER_WEAKENED_QUALITY").explanation,
      "Longer routes were available, but they weakened the journey too much.",
    );
    assert.equal(
      timeBudgetExplanation(28 * 60, 85, true, "NO_TARGET_BAND_ROUTE").explanation,
      "We couldn’t find a suitable route using all of your requested time, so we chose the strongest journey available.",
    );
  });
});
