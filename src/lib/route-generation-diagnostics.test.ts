import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRouteGenerationDiagnostic,
  candidateByRequestLocalId,
  formatRouteGenerationDiagnosticForClipboard,
  internalRouteDiagnosticResponse,
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
  it("joins null-target candidates by request-local ID rather than the first matching target", () => {
    const candidates = [
      { candidateId: "baseline-0", intended: null, score: 77 },
      { candidateId: "google-alternative-1", intended: null, score: 35 },
      { candidateId: "scenic-stage-2", intended: null, score: 73 },
    ];
    assert.equal(candidateByRequestLocalId(candidates, "google-alternative-1")?.score, 35);
    assert.equal(candidateByRequestLocalId(candidates, "scenic-stage-2")?.score, 73);
  });

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
          candidateId: "long-target-5",
          candidateSource: "scenik",
          explorationStage: 3,
          intendedTargetMinutes: 50,
          adaptiveTargetMinutes: 50,
          actualAddedMinutes: null,
          outcomeClassification: "REQUEST_FAILED",
          duplicateEligible: null,
          budgetEligible: null,
          qualityEligible: null,
          scenicScore: null,
          scoreBreakdown: {
            naturalBeauty: 7,
            pointsOfInterest: 6,
            moodMatch: 5,
            roadCharacter: 8,
            themeMatch: 4,
            diversity: 6,
            rationale: "must-not-escape",
          },
          allowanceUtilisation: 0.6,
          evidenceEligible: true,
          targetBandEligible: false,
          selected: false,
          rejectionReason: "INCOHERENT_ROUTE",
          finalSelectionReason: "must-not-escape",
          routeShapeEligible: false,
          routeShapeRejectionReason: "WAYPOINT_SPUR",
          reverseOverlapDistanceMeters: 2_400,
          reverseOverlapRatio: 0.12,
          waypointSpurDetected: true,
          affectedWaypointIndex: 1,
          waypointAssociationStatus: "EXACT",
          routeShapeAnalysisStatus: "ANALYSED",
          polyline: "nested-secret-polyline",
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
    assert.deepEqual(diagnostic.candidateEligibility[0], {
      candidateId: "long-target-5",
      candidateSource: "scenik",
      explorationStage: 3,
      intendedTargetMinutes: 50,
      adaptiveTargetMinutes: 50,
      actualAddedMinutes: null,
      outcomeClassification: "REQUEST_FAILED",
      duplicateEligible: null,
      budgetEligible: null,
      qualityEligible: null,
      scenicScore: null,
      scoreBreakdown: {
        naturalBeauty: 7,
        pointsOfInterest: 6,
        moodMatch: 5,
        roadCharacter: 8,
        themeMatch: 4,
        diversity: 6,
      },
      allowanceUtilisation: 0.6,
      evidenceEligible: true,
      targetBandEligible: false,
      selected: false,
      rejectionReason: "INCOHERENT_ROUTE",
      finalSelectionReason: null,
      routeShapeEligible: false,
      routeShapeRejectionReason: "WAYPOINT_SPUR",
      reverseOverlapDistanceMeters: 2_400,
      reverseOverlapRatio: 0.12,
      waypointSpurDetected: true,
      affectedWaypointIndex: 1,
      waypointAssociationStatus: "EXACT",
      routeShapeAnalysisStatus: "ANALYSED",
    });
    for (const forbidden of [
      "coordinates",
      "Oxford",
      "secret-place",
      "encoded-route",
      "nested-secret-polyline",
      "user-1",
      "key-1",
      "token-1",
      "secret-1",
      "must-not-escape",
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

  it("distinguishes each privacy-safe route-shape outcome", () => {
    const outcomes = [
      [true, null, "ANALYSED"],
      [false, "WAYPOINT_SPUR", "ANALYSED"],
      [false, "MATERIAL_REVERSE_RETRACE", "ANALYSED"],
      [false, "MISSING_GEOMETRY", "MISSING_GEOMETRY"],
      [false, "MALFORMED_GEOMETRY", "MALFORMED_GEOMETRY"],
      [false, "GEOMETRY_LIMIT_EXCEEDED", "GEOMETRY_LIMIT_EXCEEDED"],
      [false, "ANALYSIS_WORK_LIMIT", "WORK_LIMIT_EXCEEDED"],
      [true, null, "TRUSTED_BASELINE"],
      [true, null, "LEGACY_UNAVAILABLE"],
    ] as const;
    const diagnostic = buildRouteGenerationDiagnostic({
      correlationId: "route-shapes",
      requestedExtraMinutes: 85,
      baselineDurationSeconds: 21_600,
      plannedExplorationStages: [],
      attemptsPlanned: outcomes.length,
      attemptsCompleted: outcomes.length,
      intendedTargetMinutes: [],
      adaptiveTargetMinutes: [],
      actualAddedMinutesReturned: 41,
      outcomeClassification: "TARGET_MET",
      candidateEligibility: outcomes.map(([eligible, reason, status]) => ({
        candidateId: `candidate-${status}-${String(reason)}`,
        candidateSource: "scenik" as const,
        explorationStage: 1,
        intendedTargetMinutes: null,
        adaptiveTargetMinutes: null,
        actualAddedMinutes: null,
        outcomeClassification: "COMPLETED",
        duplicateEligible: true,
        budgetEligible: true,
        qualityEligible: eligible,
        scenicScore: null,
        routeShapeEligible: eligible,
        routeShapeRejectionReason: reason,
        reverseOverlapDistanceMeters: 0,
        reverseOverlapRatio: 0,
        waypointSpurDetected: reason === "WAYPOINT_SPUR",
        affectedWaypointIndex: reason === "WAYPOINT_SPUR" ? 0 : null,
        waypointAssociationStatus: reason === "WAYPOINT_SPUR" ? "EXACT" : "UNAVAILABLE",
        routeShapeAnalysisStatus: status,
        encodedPolyline: "must-not-escape",
      })),
      candidateScenicScores: [],
      finalSelectionReason: "BASELINE_FALLBACK",
      totalServerProcessingDurationMs: 100,
    } as Parameters<typeof buildRouteGenerationDiagnostic>[0]);

    assert.deepEqual(
      diagnostic.candidateEligibility.map((candidate) => [
        candidate.routeShapeEligible,
        candidate.routeShapeRejectionReason,
        candidate.routeShapeAnalysisStatus,
      ]),
      outcomes,
    );
    assert.equal(JSON.stringify(diagnostic).includes("must-not-escape"), false);
  });

  it("excludes diagnostics entirely from an unauthorised response", () => {
    const diagnostic = buildRouteGenerationDiagnostic({
      correlationId: "route-normal",
      requestedExtraMinutes: 30,
      baselineDurationSeconds: 3_600,
      plannedExplorationStages: [],
      attemptsPlanned: 4,
      attemptsCompleted: 4,
      intendedTargetMinutes: [],
      adaptiveTargetMinutes: [],
      actualAddedMinutesReturned: 28,
      outcomeClassification: "TARGET_MET",
      candidateEligibility: [],
      candidateScenicScores: [82],
      finalSelectionReason: "TARGET_BAND_HIGHEST_SCENIC_QUALITY",
      totalServerProcessingDurationMs: 900,
    });
    assert.deepEqual(internalRouteDiagnosticResponse(false, diagnostic), {});
    assert.equal(
      "routeGenerationDiagnostics" in internalRouteDiagnosticResponse(false, diagnostic),
      false,
    );
    assert.deepEqual(internalRouteDiagnosticResponse(true, diagnostic), {
      routeGenerationDiagnostics: diagnostic,
    });
  });

  it("formats exactly the allowed clipboard fields and strips arbitrary extras", () => {
    const diagnostic = buildRouteGenerationDiagnostic({
      correlationId: "route-copy",
      requestedExtraMinutes: 85,
      baselineDurationSeconds: 21_600,
      plannedExplorationStages: [],
      attemptsPlanned: 6,
      attemptsCompleted: 5,
      intendedTargetMinutes: [50, 70],
      adaptiveTargetMinutes: [50, 85],
      actualAddedMinutesReturned: 61,
      outcomeClassification: "TARGET_MET",
      candidateEligibility: [],
      candidateScenicScores: [72, 76],
      finalSelectionReason: "TARGET_BAND_HIGHEST_SCENIC_QUALITY",
      totalServerProcessingDurationMs: 2_100,
      address: "Oxford",
      coordinates: [51.7, -1.2],
      polyline: "secret-polyline",
      arbitraryExtra: "must-not-copy",
    } as Parameters<typeof buildRouteGenerationDiagnostic>[0] & Record<string, unknown>);
    const copied = JSON.parse(formatRouteGenerationDiagnosticForClipboard(diagnostic));
    assert.deepEqual(Object.keys(copied), [
      "correlationId",
      "requestedExtraMinutes",
      "baselineDurationSeconds",
      "plannedExplorationStages",
      "attemptsPlanned",
      "attemptsCompleted",
      "intendedTargetMinutes",
      "adaptiveTargetMinutes",
      "actualAddedMinutesReturned",
      "outcomeClassification",
      "candidateEligibility",
      "candidateScenicScores",
      "finalSelectionReason",
      "totalServerProcessingDurationMs",
    ]);
    assert.equal(JSON.stringify(copied).includes("Oxford"), false);
    assert.equal(JSON.stringify(copied).includes("secret-polyline"), false);
    assert.equal(JSON.stringify(copied).includes("must-not-copy"), false);
  });

  it("keeps candidate scores and safe breakdowns attached to their exact request-local IDs", () => {
    const candidate = (candidateId: string, scenicScore: number) => ({
      candidateId,
      candidateSource: "scenik" as const,
      explorationStage: 2,
      intendedTargetMinutes: null,
      adaptiveTargetMinutes: null,
      actualAddedMinutes: 12,
      outcomeClassification: "ELIGIBLE",
      duplicateEligible: true,
      budgetEligible: true,
      qualityEligible: true,
      scenicScore,
      scoreBreakdown: {
        naturalBeauty: scenicScore,
        pointsOfInterest: 1,
        moodMatch: 2,
        roadCharacter: 3,
        themeMatch: 4,
        diversity: 5,
      },
      allowanceUtilisation: 0.4,
      evidenceEligible: true,
      targetBandEligible: false,
      selected: scenicScore === 73,
      rejectionReason: scenicScore === 73 ? null : "BELOW_QUALITY_GUARDRAIL",
      finalSelectionReason: scenicScore === 73 ? "BELOW_TARGET_BEST_BALANCE" : null,
    });
    const diagnostic = buildRouteGenerationDiagnostic({
      correlationId: "lineage",
      requestedExtraMinutes: 30,
      baselineDurationSeconds: 21_600,
      plannedExplorationStages: [],
      attemptsPlanned: 4,
      attemptsCompleted: 4,
      intendedTargetMinutes: [],
      adaptiveTargetMinutes: [],
      actualAddedMinutesReturned: 11.8,
      outcomeClassification: "LONGER_WEAKENED_QUALITY",
      candidateEligibility: [candidate("scenic-stage-2", 42), candidate("scenic-stage-3", 73)],
      candidateScenicScores: [42, 73],
      finalSelectionReason: "BELOW_TARGET_BEST_BALANCE",
      totalServerProcessingDurationMs: 1_000,
    });

    assert.deepEqual(
      diagnostic.candidateEligibility.map(({ candidateId, scenicScore }) => [
        candidateId,
        scenicScore,
      ]),
      [
        ["scenic-stage-2", 42],
        ["scenic-stage-3", 73],
      ],
    );
    assert.equal(JSON.stringify(diagnostic).includes("coordinates"), false);
    assert.equal(JSON.stringify(diagnostic).includes("polyline"), false);
  });
});
