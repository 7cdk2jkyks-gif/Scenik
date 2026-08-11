import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRouteGenerationDiagnostic,
  runSequentialLongAttempts,
  serializeRouteGenerationDiagnostic,
} from "./route-generation-diagnostics";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("sequential long-budget attempts", () => {
  it("awaits both attempts before allowing final selection", async () => {
    const first = deferred<{ status: "COMPLETED"; actualAddedMinutes: number }>();
    const second = deferred<{ status: "COMPLETED"; actualAddedMinutes: number }>();
    const started: number[] = [];
    let explorationComplete = false;
    const exploration = runSequentialLongAttempts({
      intendedTargets: [50, 70],
      maximumExtraMinutes: 85,
      adaptiveTarget: () => 85,
      execute: ({ intendedTargetMinutes }) => {
        started.push(intendedTargetMinutes);
        return intendedTargetMinutes === 50 ? first.promise : second.promise;
      },
    }).then((result) => {
      explorationComplete = true;
      return result;
    });

    await Promise.resolve();
    assert.deepEqual(started, [50]);
    assert.equal(explorationComplete, false);
    first.resolve({ status: "COMPLETED", actualAddedMinutes: 39 });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(started, [50, 70]);
    assert.equal(explorationComplete, false);
    second.resolve({ status: "COMPLETED", actualAddedMinutes: 61 });

    const attempts = await exploration;
    assert.equal(explorationComplete, true);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].adaptiveTargetMinutes, 85);
  });

  it("records a failed attempt truthfully and still awaits the final attempt", async () => {
    const second = deferred<{ status: "NO_PLAN"; actualAddedMinutes: null }>();
    const attemptsPromise = runSequentialLongAttempts({
      intendedTargets: [50, 70],
      maximumExtraMinutes: 85,
      adaptiveTarget: () => 70,
      execute: ({ intendedTargetMinutes }) =>
        intendedTargetMinutes === 50
          ? Promise.resolve({ status: "FAILED", actualAddedMinutes: null })
          : second.promise,
    });
    let settled = false;
    void attemptsPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled, false);
    second.resolve({ status: "NO_PLAN", actualAddedMinutes: null });
    assert.deepEqual(
      (await attemptsPromise).map(({ status }) => status),
      ["FAILED", "NO_PLAN"],
    );
  });
});

describe("route-generation diagnostic log", () => {
  it("records duration and completed attempts without leaking sensitive fields", () => {
    const diagnostic = buildRouteGenerationDiagnostic({
      correlationId: "route-123",
      requestedExtraMinutes: 85,
      baselineDurationSeconds: 21_600,
      plannedExplorationStages: [
        {
          radiusMeters: 10_000,
          sampleCap: 3,
          cumulativePlaceCap: 70,
          cumulativeRouteCap: 6,
          targetExtraMinutes: [50, 70],
        },
      ],
      attemptsPlanned: 6,
      attemptsCompleted: 5,
      intendedTargetMinutes: [50, 70],
      adaptiveTargetMinutes: [50, 85],
      actualAddedMinutesReturned: 39,
      outcomeClassification: "SEVERE_UNDERSHOOT",
      candidateEligibility: [
        {
          intendedTargetMinutes: 50,
          adaptiveTargetMinutes: 50,
          actualAddedMinutes: null,
          outcomeClassification: "REQUEST_FAILED",
          duplicateEligible: null,
          budgetEligible: null,
          qualityEligible: null,
          scenicScore: null,
        },
      ],
      candidateScenicScores: [66, 72],
      finalSelectionReason: "HIGHEST_SCORE_IN_TARGET_BAND",
      totalServerProcessingDurationMs: 1_984,
      coordinates: [51.7, -1.2],
      address: "Oxford",
      placeId: "secret-place",
      polyline: "encoded-route",
      userId: "user-1",
      apiKey: "key-1",
      token: "token-1",
      secret: "secret-1",
    } as Parameters<typeof buildRouteGenerationDiagnostic>[0] & Record<string, unknown>);
    const serialized = JSON.stringify(diagnostic);

    assert.equal(diagnostic.attemptsCompleted, 5);
    assert.equal(diagnostic.totalServerProcessingDurationMs, 1_984);
    for (const forbidden of [
      "coordinates",
      "Oxford",
      "secret-place",
      "encoded-route",
      "user-1",
      "key-1",
      "token-1",
      "secret-1",
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  });

  it("serializes one searchable allow-listed line without sensitive extras", () => {
    const line = serializeRouteGenerationDiagnostic({
      correlationId: "route-456",
      requestedExtraMinutes: 85,
      baselineDurationSeconds: 21_600,
      plannedExplorationStages: [],
      attemptsPlanned: 6,
      attemptsCompleted: 6,
      intendedTargetMinutes: [50, 70],
      adaptiveTargetMinutes: [50, 85],
      actualAddedMinutesReturned: 61,
      outcomeClassification: "TARGET_MET",
      candidateEligibility: [],
      candidateScenicScores: [72],
      finalSelectionReason: "TARGET_BAND_HIGHEST_SCENIC_QUALITY",
      totalServerProcessingDurationMs: 2_100,
      coordinates: [51.7, -1.2],
      address: "Oxford",
      placeId: "secret-place",
      polyline: "encoded-route",
      userId: "user-1",
      authentication: "auth-1",
      apiKey: "key-1",
      token: "token-1",
      secret: "secret-1",
    } as Parameters<typeof serializeRouteGenerationDiagnostic>[0] & Record<string, unknown>);

    assert.equal(line.startsWith("scenik-route-engine-v2 {"), true);
    assert.equal(line.includes('"requestedExtraMinutes":85'), true);
    assert.equal(line.includes('"totalServerProcessingDurationMs":2100'), true);
    for (const forbidden of [
      "coordinates",
      "Oxford",
      "secret-place",
      "encoded-route",
      "user-1",
      "auth-1",
      "key-1",
      "token-1",
      "secret-1",
    ]) {
      assert.equal(line.includes(forbidden), false);
    }
  });
});
