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
      timeBudgetExplanation(63 * 60, 180, true, "MEANINGFUL_FALLBACK").explanation,
      "This useful longer route safely uses part of your allowance; no suitable route used more.",
    );
    assert.equal(
      timeBudgetExplanation(6 * 60, 180, true, "WEAK_ROUTE_SELECTED").explanation,
      "We found a worthwhile longer route, although the full allowance could not be used safely.",
    );
    assert.equal(
      timeBudgetExplanation(0, 180, true, "BASELINE_FALLBACK").explanation,
      "No safe, coherent longer route met the minimum journey-quality requirements.",
    );
    assert.equal(
      timeBudgetExplanation(15 * 60, 85, true, "LONGER_WEAKENED_QUALITY").explanation,
      "Longer routes were available, but they weakened the journey too much.",
    );
    assert.equal(
      timeBudgetExplanation(28 * 60, 85, true, "NO_TARGET_BAND_ROUTE").explanation,
      "We couldn’t find a suitable route using all of your requested time, so we chose the strongest journey available.",
    );
  });

  it("uses authoritative seconds and outcome precedence at every utilisation boundary", () => {
    const allowanceMinutes = 400 / 60;
    const targetCopy = "Your larger allowance unlocked this route.";
    const meaningfulCopy =
      "This useful longer route safely uses part of your allowance; no suitable route used more.";
    const balancedCopy = "This was the best balance of scenery and journey time.";

    assert.notEqual(timeBudgetExplanation(139, allowanceMinutes).explanation, meaningfulCopy);
    assert.equal(timeBudgetExplanation(140, allowanceMinutes).explanation, meaningfulCopy);
    assert.equal(timeBudgetExplanation(299, allowanceMinutes).explanation, balancedCopy);
    assert.equal(timeBudgetExplanation(300, allowanceMinutes).explanation, targetCopy);
    assert.equal(timeBudgetExplanation(400, allowanceMinutes).explanation, targetCopy);
    assert.notEqual(timeBudgetExplanation(401, allowanceMinutes).explanation, targetCopy);

    assert.equal(timeBudgetExplanation(179, 4).utilisation, 179 / 240);
    assert.equal(timeBudgetExplanation(179, 4).explanation, balancedCopy);
    assert.notEqual(timeBudgetExplanation(83, 4).explanation, meaningfulCopy);

    assert.equal(
      timeBudgetExplanation(179, 4, true, "MEANINGFUL_FALLBACK").explanation,
      meaningfulCopy,
    );
    assert.equal(timeBudgetExplanation(179, 4, true, "TARGET_MET").explanation, targetCopy);
    assert.equal(
      timeBudgetExplanation(Number.NaN, Number.NaN).explanation,
      "Fastest route selected.",
    );
  });
});
