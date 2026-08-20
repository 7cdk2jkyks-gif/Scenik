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
  it("keeps every processed ordinary target, including no-plan and collision outcomes", () => {
    const serialized = serializeRouteGenerationDiagnostic({
      correlationId: "route-target-lineage",
      requestedExtraMinutes: 180,
      baselineDurationSeconds: 3_600,
      plannedExplorationStages: [
        {
          radiusMeters: 1_000,
          sampleCap: 3,
          cumulativePlaceCap: 20,
          cumulativeRouteCap: 3,
          targetExtraMinutes: [30, 60, 70, 135],
        },
      ],
      attemptsPlanned: 4,
      attemptsCompleted: 1,
      processedTargetMinutes: [30, 60, 70],
      intendedTargetMinutes: [30, 60, 70],
      adaptiveTargetMinutes: [],
      actualAddedMinutesReturned: 0,
      outcomeClassification: "BASELINE_FALLBACK",
      candidateEligibility: [],
      candidateScenicScores: [],
      finalSelectionReason: null,
      totalServerProcessingDurationMs: 1,
      constructionSummary: {
        scheduled: 4,
        processed: 3,
        distinct: 1,
        collisions: 1,
        noPlan: 1,
      },
    });
    const summary = JSON.parse(serialized.slice("scenik-route-summary-v3 ".length));
    assert.deepEqual(summary.plannedTargets, [30, 60, 70, 135]);
    assert.deepEqual(summary.processedTargets, [30, 60, 70]);
    assert.deepEqual(summary.intendedTargets, [30, 60, 70]);
    assert.deepEqual(summary.adaptiveTargets, []);
  });

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
          },
          allowanceUtilisation: 0.6,
          evidenceEligible: true,
          targetBandEligible: false,
          selected: false,
          rejectionReason: "INCOHERENT_ROUTE",
          finalSelectionReason: "must-not-escape",
          geometryDistanceMeters: 560_000,
          evidenceSampleCount: 1_121,
          evidenceConsidered: 70,
          evidenceMatchedToGeometry: 4,
          evidenceMatchedThroughWaypoints: 1,
          naturalEvidenceCount: 3,
          themeEvidenceCount: 3,
          moodEvidenceCount: 1.5,
          evidenceAssociationStatus: "ANALYSED",
          routeShapeEligible: false,
          routeShapeRejectionReason: "WAYPOINT_SPUR",
          reverseOverlapDistanceMeters: 2_400,
          reverseOverlapRatio: 0.12,
          waypointSpurDetected: true,
          affectedWaypointIndex: 1,
          waypointAssociationStatus: "EXACT",
          routeShapeAnalysisStatus: "ANALYSED",
          requestedWaypointForm: "two-waypoint-arc",
          effectiveWaypointForm: "one-waypoint",
          effectiveProgress: "middle",
          effectiveOrientation: "left",
          effectiveWaypointCount: 1,
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
      geometryDistanceMeters: 560_000,
      evidenceSampleCount: 1_121,
      evidenceConsidered: 70,
      evidenceMatchedToGeometry: 4,
      evidenceMatchedThroughWaypoints: 1,
      naturalEvidenceCount: 3,
      themeEvidenceCount: 3,
      moodEvidenceCount: 1.5,
      evidenceAssociationStatus: "ANALYSED",
      routeShapeEligible: false,
      routeShapeRejectionReason: "WAYPOINT_SPUR",
      reverseOverlapDistanceMeters: 2_400,
      reverseOverlapRatio: 0.12,
      waypointSpurDetected: true,
      affectedWaypointIndex: 1,
      waypointAssociationStatus: "EXACT",
      routeShapeAnalysisStatus: "ANALYSED",
      requestedWaypointForm: "two-waypoint-arc",
      effectiveWaypointForm: "one-waypoint",
      effectiveProgress: "middle",
      effectiveOrientation: "left",
      effectiveWaypointCount: 1,
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

    assert.equal(line.startsWith("scenik-route-summary-v3 {"), true);
    assert.equal(line.includes('"requestedExtraMinutes":85'), true);
    assert.equal(line.includes("totalServerProcessingDurationMs"), false);
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

  it("rejects non-scalar association diagnostics from response, log and clipboard projections", () => {
    const sensitive = {
      coordinates: [51.7, -1.2],
      placeId: "place-secret",
      polyline: "polyline-secret",
      name: "name-secret",
      address: "address-secret",
      userId: "user-secret",
      authentication: "auth-secret",
      apiKey: "key-secret",
      token: "token-secret",
      secret: "value-secret",
    };
    const invalidCandidate = {
      candidateId: "scenic-stage-1",
      candidateSource: "scenik" as const,
      explorationStage: 1,
      intendedTargetMinutes: null,
      adaptiveTargetMinutes: null,
      actualAddedMinutes: 10,
      outcomeClassification: "ELIGIBLE",
      duplicateEligible: true,
      budgetEligible: true,
      qualityEligible: true,
      scenicScore: 70,
      geometryDistanceMeters: null,
      evidenceSampleCount: null,
      evidenceConsidered: null,
      evidenceMatchedToGeometry: null,
      evidenceMatchedThroughWaypoints: null,
      naturalEvidenceCount: null,
      themeEvidenceCount: null,
      moodEvidenceCount: null,
      evidenceAssociationStatus: null,
    };
    Object.defineProperties(invalidCandidate, {
      geometryDistanceMeters: { value: sensitive },
      evidenceSampleCount: { value: [sensitive] },
      evidenceConsidered: { value: "70" },
      evidenceMatchedToGeometry: { value: Number.NaN },
      evidenceMatchedThroughWaypoints: { value: -1 },
      naturalEvidenceCount: { value: Number.POSITIVE_INFINITY },
      themeEvidenceCount: { value: sensitive },
      moodEvidenceCount: { value: [] },
      evidenceAssociationStatus: { value: sensitive },
    });
    const input = {
      correlationId: "strict-scalars",
      requestedExtraMinutes: 30,
      baselineDurationSeconds: 3_600,
      plannedExplorationStages: [],
      attemptsPlanned: 1,
      attemptsCompleted: 1,
      intendedTargetMinutes: [],
      adaptiveTargetMinutes: [],
      actualAddedMinutesReturned: 10,
      outcomeClassification: "TARGET_MET",
      candidateEligibility: [invalidCandidate],
      candidateScenicScores: [70],
      finalSelectionReason: "ONLY_ELIGIBLE_ROUTE",
      totalServerProcessingDurationMs: 100,
    };
    const diagnostic = buildRouteGenerationDiagnostic(input);
    assert.deepEqual(
      {
        geometryDistanceMeters: diagnostic.candidateEligibility[0].geometryDistanceMeters,
        evidenceSampleCount: diagnostic.candidateEligibility[0].evidenceSampleCount,
        evidenceConsidered: diagnostic.candidateEligibility[0].evidenceConsidered,
        evidenceMatchedToGeometry: diagnostic.candidateEligibility[0].evidenceMatchedToGeometry,
        evidenceMatchedThroughWaypoints:
          diagnostic.candidateEligibility[0].evidenceMatchedThroughWaypoints,
        naturalEvidenceCount: diagnostic.candidateEligibility[0].naturalEvidenceCount,
        themeEvidenceCount: diagnostic.candidateEligibility[0].themeEvidenceCount,
        moodEvidenceCount: diagnostic.candidateEligibility[0].moodEvidenceCount,
        evidenceAssociationStatus: diagnostic.candidateEligibility[0].evidenceAssociationStatus,
      },
      {
        geometryDistanceMeters: null,
        evidenceSampleCount: null,
        evidenceConsidered: null,
        evidenceMatchedToGeometry: null,
        evidenceMatchedThroughWaypoints: null,
        naturalEvidenceCount: null,
        themeEvidenceCount: null,
        moodEvidenceCount: null,
        evidenceAssociationStatus: null,
      },
    );
    const outputs = [
      JSON.stringify(internalRouteDiagnosticResponse(true, diagnostic)),
      serializeRouteGenerationDiagnostic(input),
      formatRouteGenerationDiagnosticForClipboard(diagnostic),
    ];
    for (const output of outputs)
      for (const forbidden of Object.values(sensitive).flat())
        assert.equal(output.includes(String(forbidden)), false);
  });

  it("joins scored association details into final diagnostics only by request-local candidate ID", () => {
    const scored = [
      {
        candidateId: "scenic-stage-5",
        durationSeconds: 4_500,
        score: 73,
        scoreBreakdown: {
          naturalBeauty: 9.4,
          pointsOfInterest: 7,
          moodMatch: 6.7,
          roadCharacter: 8,
          themeMatch: 10,
          diversity: 6,
        },
        evidenceAssociation: {
          geometryDistanceMeters: 560_000,
          sampleCount: 1_121,
          evidenceConsidered: 70,
          evidenceMatchedToGeometry: 5,
          evidenceMatchedThroughWaypoints: 1,
          status: "ANALYSED",
        },
        routeShapeEligible: true,
        selected: true,
      },
      {
        candidateId: "scenic-stage-4",
        durationSeconds: 4_700,
        score: 42,
        scoreBreakdown: {
          naturalBeauty: 2.2,
          pointsOfInterest: 4,
          moodMatch: 2.5,
          roadCharacter: 8,
          themeMatch: 2.7,
          diversity: 5,
        },
        evidenceAssociation: {
          geometryDistanceMeters: 558_000,
          sampleCount: 1_117,
          evidenceConsidered: 70,
          evidenceMatchedToGeometry: 1,
          evidenceMatchedThroughWaypoints: 0,
          status: "ANALYSED",
        },
        routeShapeEligible: false,
        selected: false,
      },
    ];
    const eligibility = ["scenic-stage-4", "scenic-stage-5"].map((candidateId) => {
      const candidate = candidateByRequestLocalId(scored, candidateId)!;
      return {
        candidateId,
        candidateSource: "scenik" as const,
        explorationStage: candidateId === "scenic-stage-4" ? 4 : 5,
        intendedTargetMinutes: null,
        adaptiveTargetMinutes: null,
        actualAddedMinutes: candidate.durationSeconds / 60,
        outcomeClassification: candidate.routeShapeEligible ? "ELIGIBLE" : "INCOHERENT_ROUTE",
        duplicateEligible: true,
        budgetEligible: true,
        qualityEligible: candidate.score >= 60,
        scenicScore: candidate.score,
        scoreBreakdown: candidate.scoreBreakdown,
        selected: candidate.selected,
        geometryDistanceMeters: candidate.evidenceAssociation.geometryDistanceMeters,
        evidenceSampleCount: candidate.evidenceAssociation.sampleCount,
        evidenceConsidered: candidate.evidenceAssociation.evidenceConsidered,
        evidenceMatchedToGeometry: candidate.evidenceAssociation.evidenceMatchedToGeometry,
        evidenceMatchedThroughWaypoints:
          candidate.evidenceAssociation.evidenceMatchedThroughWaypoints,
        evidenceAssociationStatus: candidate.evidenceAssociation.status,
        routeShapeEligible: candidate.routeShapeEligible,
      };
    });
    const diagnostic = buildRouteGenerationDiagnostic({
      correlationId: "integration-lineage",
      requestedExtraMinutes: 85,
      baselineDurationSeconds: 3_600,
      plannedExplorationStages: [],
      attemptsPlanned: 2,
      attemptsCompleted: 2,
      intendedTargetMinutes: [],
      adaptiveTargetMinutes: [],
      actualAddedMinutesReturned: 15,
      outcomeClassification: "NO_TARGET_BAND_ROUTE",
      candidateEligibility: eligibility,
      candidateScenicScores: scored.map(({ score }) => score),
      finalSelectionReason: "BELOW_TARGET_BEST_BALANCE",
      totalServerProcessingDurationMs: 500,
    });
    assert.deepEqual(
      diagnostic.candidateEligibility.map((candidate) => ({
        candidateId: candidate.candidateId,
        score: candidate.scenicScore,
        sampleCount: candidate.evidenceSampleCount,
        geometryMatches: candidate.evidenceMatchedToGeometry,
        routeShapeEligible: candidate.routeShapeEligible,
        selected: candidate.selected,
      })),
      [
        {
          candidateId: "scenic-stage-4",
          score: 42,
          sampleCount: 1_117,
          geometryMatches: 1,
          routeShapeEligible: false,
          selected: false,
        },
        {
          candidateId: "scenic-stage-5",
          score: 73,
          sampleCount: 1_121,
          geometryMatches: 5,
          routeShapeEligible: true,
          selected: true,
        },
      ],
    );
    const log = serializeRouteGenerationDiagnostic(diagnostic);
    assert.ok(log.startsWith("scenik-route-summary-v3 "));
    assert.doesNotThrow(() => JSON.parse(log.slice("scenik-route-summary-v3 ".length)));
    assert.doesNotThrow(() => JSON.parse(formatRouteGenerationDiagnosticForClipboard(diagnostic)));
    assert.deepEqual(internalRouteDiagnosticResponse(true, diagnostic), {
      routeGenerationDiagnostics: diagnostic,
    });
  });

  it("projects null aggregates for mixed missing association diagnostics without throwing", () => {
    const scored = [
      { candidateId: "with", evidenceAssociation: { status: "ANALYSED", sampleCount: 12 } },
      { candidateId: "without", evidenceAssociation: undefined },
    ];
    const candidates = ["with", "without", "absent"].map((candidateId) => {
      const association = candidateByRequestLocalId(scored, candidateId)?.evidenceAssociation;
      return {
        candidateId,
        candidateSource: "scenik" as const,
        explorationStage: 1,
        intendedTargetMinutes: null,
        adaptiveTargetMinutes: null,
        actualAddedMinutes: null,
        outcomeClassification: "ELIGIBLE",
        duplicateEligible: true,
        budgetEligible: true,
        qualityEligible: true,
        scenicScore: null,
        evidenceSampleCount: association?.sampleCount ?? null,
        evidenceAssociationStatus: association?.status ?? null,
      };
    });
    const diagnostic = buildRouteGenerationDiagnostic({
      correlationId: "mixed-association",
      requestedExtraMinutes: 30,
      baselineDurationSeconds: 3_600,
      plannedExplorationStages: [],
      attemptsPlanned: 3,
      attemptsCompleted: 3,
      intendedTargetMinutes: [],
      adaptiveTargetMinutes: [],
      actualAddedMinutesReturned: 0,
      outcomeClassification: "NO_TARGET_BAND_ROUTE",
      candidateEligibility: candidates,
      candidateScenicScores: [],
      finalSelectionReason: null,
      totalServerProcessingDurationMs: 100,
    });
    assert.deepEqual(
      diagnostic.candidateEligibility.map((candidate) => [
        candidate.candidateId,
        candidate.evidenceSampleCount,
        candidate.evidenceAssociationStatus,
      ]),
      [
        ["with", 12, "ANALYSED"],
        ["without", null, null],
        ["absent", null, null],
      ],
    );
    assert.doesNotThrow(() => formatRouteGenerationDiagnosticForClipboard(diagnostic));
    assert.doesNotThrow(() => serializeRouteGenerationDiagnostic(diagnostic));
    assert.deepEqual(internalRouteDiagnosticResponse(true, diagnostic), {
      routeGenerationDiagnostics: diagnostic,
    });
  });

  it("allow-lists aggregate duration-refinement lineage without route or place data", () => {
    const diagnostic = buildRouteGenerationDiagnostic({
      correlationId: "refinement-lineage",
      requestedExtraMinutes: 30,
      baselineDurationSeconds: 22_064,
      plannedExplorationStages: [],
      attemptsPlanned: 5,
      attemptsCompleted: 5,
      intendedTargetMinutes: [27],
      adaptiveTargetMinutes: [27],
      actualAddedMinutesReturned: 26.2,
      outcomeClassification: "TARGET_MET",
      candidateEligibility: [
        {
          candidateId: "duration-refinement-8",
          candidateSource: "scenik",
          explorationStage: 2,
          intendedTargetMinutes: 27,
          adaptiveTargetMinutes: 27,
          actualAddedMinutes: 26.2,
          outcomeClassification: "TARGET_BAND",
          duplicateEligible: true,
          budgetEligible: true,
          qualityEligible: true,
          scenicScore: 78,
          refinementParentCandidateId: "scenic-stage-5",
          refinementUpperCandidateId: "scenic-stage-4",
          refinementAttemptNumber: 1,
          refinementStrategy: "RELATED_BRACKET",
          refinementBracketLowerMinutes: 18.1,
          refinementBracketUpperMinutes: 41.4,
          refinementTargetBandReached: true,
          refinementStopReason: "TARGET_REACHED",
          coordinates: [{ lat: 51, lng: -1 }],
          waypoints: [{ lat: 52, lng: -2 }],
          placeId: "private-place",
          polyline: "private-polyline",
          displayName: "private-name",
          providerResponse: { private: true },
        } as Parameters<typeof buildRouteGenerationDiagnostic>[0]["candidateEligibility"][number] &
          Record<string, unknown>,
      ],
      candidateScenicScores: [78],
      finalSelectionReason: "TARGET_BAND_HIGHEST_SCENIC_QUALITY",
      totalServerProcessingDurationMs: 3_327,
      durationRefinement: {
        attempted: true,
        reachedTargetBand: true,
        attemptsUsed: 1,
        safeConstructionsProduced: 1,
        providerRequestsStarted: 1,
        providerResponsesReturned: 1,
        providerRequestsFailed: 0,
        providerResponsesEvaluated: 1,
        stopReason: "TARGET_REACHED",
      },
    });
    const serialized = JSON.stringify(diagnostic);
    assert.equal(serialized.includes("private"), false);
    assert.deepEqual(diagnostic.durationRefinement, {
      attempted: true,
      reachedTargetBand: true,
      attemptsUsed: 1,
      safeConstructionsProduced: 1,
      providerRequestsStarted: 1,
      providerResponsesReturned: 1,
      providerRequestsFailed: 0,
      providerResponsesEvaluated: 1,
      stopReason: "TARGET_REACHED",
    });
    assert.deepEqual(
      {
        refinementParentCandidateId: diagnostic.candidateEligibility[0].refinementParentCandidateId,
        refinementUpperCandidateId: diagnostic.candidateEligibility[0].refinementUpperCandidateId,
        refinementAttemptNumber: diagnostic.candidateEligibility[0].refinementAttemptNumber,
        refinementStrategy: diagnostic.candidateEligibility[0].refinementStrategy,
        refinementBracketLowerMinutes:
          diagnostic.candidateEligibility[0].refinementBracketLowerMinutes,
        refinementBracketUpperMinutes:
          diagnostic.candidateEligibility[0].refinementBracketUpperMinutes,
        refinementTargetBandReached: diagnostic.candidateEligibility[0].refinementTargetBandReached,
        refinementStopReason: diagnostic.candidateEligibility[0].refinementStopReason,
      },
      {
        refinementParentCandidateId: "scenic-stage-5",
        refinementUpperCandidateId: "scenic-stage-4",
        refinementAttemptNumber: 1,
        refinementStrategy: "RELATED_BRACKET",
        refinementBracketLowerMinutes: 18.1,
        refinementBracketUpperMinutes: 41.4,
        refinementTargetBandReached: true,
        refinementStopReason: "TARGET_REACHED",
      },
    );
  });

  it("allow-lists provider failure as one attempted refinement without raw failure data", () => {
    const diagnostic = buildRouteGenerationDiagnostic({
      correlationId: "provider-failure",
      requestedExtraMinutes: 30,
      baselineDurationSeconds: 3_600,
      plannedExplorationStages: [],
      attemptsPlanned: 5,
      attemptsCompleted: 5,
      intendedTargetMinutes: [27],
      adaptiveTargetMinutes: [27],
      actualAddedMinutesReturned: 18,
      outcomeClassification: "NO_TARGET_BAND_ROUTE",
      candidateEligibility: [],
      candidateScenicScores: [],
      finalSelectionReason: null,
      totalServerProcessingDurationMs: 10_000,
      durationRefinement: {
        attempted: true,
        reachedTargetBand: false,
        attemptsUsed: 1,
        safeConstructionsProduced: 1,
        providerRequestsStarted: 1,
        providerResponsesReturned: 0,
        providerRequestsFailed: 1,
        providerResponsesEvaluated: 0,
        stopReason: "PROVIDER_REQUEST_FAILED",
        providerError: "secret provider body",
        coordinates: [{ lat: 1, lng: 2 }],
      } as Parameters<typeof buildRouteGenerationDiagnostic>[0]["durationRefinement"] &
        Record<string, unknown>,
    });
    assert.deepEqual(diagnostic.durationRefinement, {
      attempted: true,
      reachedTargetBand: false,
      attemptsUsed: 1,
      safeConstructionsProduced: 1,
      providerRequestsStarted: 1,
      providerResponsesReturned: 0,
      providerRequestsFailed: 1,
      providerResponsesEvaluated: 0,
      stopReason: "PROVIDER_REQUEST_FAILED",
    });
    assert.equal(JSON.stringify(diagnostic).includes("secret provider body"), false);
    assert.equal(JSON.stringify(diagnostic).includes('"lat"'), false);

    const responseRejected = buildRouteGenerationDiagnostic({
      ...diagnostic,
      correlationId: "provider-response-rejected",
      durationRefinement: {
        attempted: true,
        reachedTargetBand: false,
        attemptsUsed: 1,
        safeConstructionsProduced: 1,
        providerRequestsStarted: 1,
        providerResponsesReturned: 1,
        providerRequestsFailed: 0,
        providerResponsesEvaluated: 1,
        stopReason: "PROVIDER_RESPONSE_REJECTED",
        rawProviderResponse: "must-not-escape",
      } as Parameters<typeof buildRouteGenerationDiagnostic>[0]["durationRefinement"] &
        Record<string, unknown>,
    });
    assert.equal(responseRejected.durationRefinement?.stopReason, "PROVIDER_RESPONSE_REJECTED");
    assert.equal(JSON.stringify(responseRejected).includes("must-not-escape"), false);

    const invalidCounts = buildRouteGenerationDiagnostic({
      correlationId: "invalid-refinement-counts",
      requestedExtraMinutes: 30,
      baselineDurationSeconds: 3_600,
      plannedExplorationStages: [],
      attemptsPlanned: 0,
      attemptsCompleted: 0,
      intendedTargetMinutes: [],
      adaptiveTargetMinutes: [],
      actualAddedMinutesReturned: 0,
      outcomeClassification: "NO_TARGET_BAND_ROUTE",
      candidateEligibility: [],
      candidateScenicScores: [],
      finalSelectionReason: null,
      totalServerProcessingDurationMs: 1,
      durationRefinement: {
        attempted: false,
        reachedTargetBand: false,
        attemptsUsed: 3,
        safeConstructionsProduced: -1,
        providerRequestsStarted: 2.5,
        providerResponsesReturned: Number.NaN,
        providerRequestsFailed: Number.POSITIVE_INFINITY,
        providerResponsesEvaluated: 4,
        stopReason: "NO_RELATED_PLAN",
      },
    });
    assert.deepEqual(invalidCounts.durationRefinement, {
      attempted: false,
      reachedTargetBand: false,
      attemptsUsed: 0,
      safeConstructionsProduced: 0,
      providerRequestsStarted: 0,
      providerResponsesReturned: 0,
      providerRequestsFailed: 0,
      providerResponsesEvaluated: 0,
      stopReason: "NO_SAFE_REFINEMENT_BRACKET",
    });
  });

  it("allow-lists bounded recovery aggregates without construction or provider data", () => {
    const diagnostic = buildRouteGenerationDiagnostic({
      correlationId: "recovery-aggregate",
      requestedExtraMinutes: 30,
      baselineDurationSeconds: 3_600,
      plannedExplorationStages: [],
      attemptsPlanned: 4,
      attemptsCompleted: 4,
      intendedTargetMinutes: [15, 23, 27],
      adaptiveTargetMinutes: [],
      actualAddedMinutesReturned: 27,
      outcomeClassification: "TARGET_MET",
      candidateEligibility: [],
      candidateScenicScores: [],
      finalSelectionReason: "TARGET_BAND_ELIGIBLE",
      totalServerProcessingDurationMs: 1,
      constructionRecovery: {
        attempted: true,
        seedsConsidered: 3,
        safeConstructionsProduced: 1,
        providerRequestsStarted: 1,
        providerResponsesReturned: 1,
        providerRequestsFailed: 0,
        responsesEvaluated: 1,
        stopReason: "TARGET_REACHED",
        coordinates: [{ lat: 51, lng: -1 }],
        signature: "private-signature",
        providerPayload: "private-provider-payload",
      } as Parameters<typeof buildRouteGenerationDiagnostic>[0]["constructionRecovery"] &
        Record<string, unknown>,
    });
    assert.deepEqual(diagnostic.constructionRecovery, {
      attempted: true,
      seedsConsidered: 3,
      safeConstructionsProduced: 1,
      providerRequestsStarted: 1,
      providerResponsesReturned: 1,
      providerRequestsFailed: 0,
      responsesEvaluated: 1,
      stopReason: "TARGET_REACHED",
    });
    const serialized = serializeRouteGenerationDiagnostic(diagnostic);
    assert.equal(serialized.includes("private-signature"), false);
    assert.equal(serialized.includes("private-provider-payload"), false);
    assert.equal(serialized.includes('"lat"'), false);
  });
});
