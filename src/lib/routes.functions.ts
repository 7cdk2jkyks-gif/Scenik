import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { verifiedDiscoveryDescription } from "./journey-timeline";
import type { RouteGenerationDiagnostic } from "./route-generation-diagnostics";
import {
  collectZeroAllowanceJourneyEvidence,
  journeyGenerationPath,
  journeyMode,
  normalizeJourneyPreferences,
} from "./journey-mode";

const PlanInput = z.object({
  start_address: z.string().min(2),
  end_address: z.string().min(2),
  mood: z.string().default(""),
  theme: z.string().default(""),
  extra_minutes: z.number().int().min(0).max(240),
  stops: z.array(z.string().min(2)).max(8).default([]),
});

export const planScenicRoute = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => PlanInput.parse(input))
  .handler(async ({ data, context }) => {
    const requestStartedAt = Date.now();
    const { geocodeAddress, computeDirections, searchNearbyScenicPlaces } =
      await import("./google-maps.server");
    const { internalDiagnosticsEnabled, isInternalTestUser } =
      await import("./internal-testers.server");
    const internalTester = isInternalTestUser(context.userId);
    const exposeInternalDiagnostics = internalDiagnosticsEnabled(context.userId);
    const requestCorrelationId = crypto.randomUUID().slice(0, 8);
    console.info("[route-generation-access]", { internalTester, requestCorrelationId });
    const geocodingCallCount = 2 + data.stops.length;
    let routesCallCount = 0;
    let placesCallCount = 0;
    let corridorSamplesUsed = 0;
    let deduplicatedPlaceCount = 0;
    let waypointPlansConsidered = 0;
    let waypointPlansRejectedDuplicate = 0;
    let waypointPlansRejectedBacktracking = 0;
    let scenicRouteRequestsAttempted = 0;
    let scenicRouteRequestsCompleted = 0;
    let scenicRoutesReturned = 0;
    let scenicRoutesRejectedOverBudget = 0;
    let scenicRoutesAccepted = 0;
    let placesRequestsSucceeded = 0;
    let placesRequestsFailed = 0;
    let evidenceRecordsReturned = 0;
    let ordinaryPlanningSummary = {
      scheduled: 0,
      processed: 0,
      distinct: 0,
      collisions: 0,
      noPlan: 0,
    };
    const evidenceSetSizes = new Set<number>();
    let explorationExhausted = false;
    let longAttemptExecutions: import("./route-generation-diagnostics").LongAttemptExecution[] = [];
    let durationRefinementResult:
      | import("./route-duration-refinement").DurationRefinementResult
      | null = null;
    const processedOrdinaryAttempts: Array<{ attemptId: string; targetMinutes: number }> = [];
    const constructionMetadataByCandidateId = new Map<
      string,
      import("./route-duration-refinement").DurationConstructionObservation
    >();
    const rejectionReasons = new Set<string>();

    const { executeProductionRouteGeneration } =
      await import("./route-generation-orchestration.server");
    return executeProductionRouteGeneration({
      verifiedUserId: context.userId,
      internalTester,
      readPremium: async () => {
        const { data: subRows } = await context.supabase
          .from("subscriptions")
          .select("status,current_period_end,environment")
          .eq("user_id", context.userId)
          .order("created_at", { ascending: false })
          .limit(1);
        const sub = subRows?.[0];
        const nowMs = Date.now();
        const subEndMs = sub?.current_period_end
          ? new Date(sub.current_period_end).getTime()
          : null;
        return (
          !!sub &&
          ((["active", "trialing", "past_due"].includes(sub.status) &&
            (!subEndMs || subEndMs > nowMs)) ||
            (sub.status === "canceled" && !!subEndMs && subEndMs > nowMs))
        );
      },
      generateRoute: async ({ isPremium }) => {
        if (!isPremium && data.stops.length > 0) {
          throw new Error("PREMIUM_REQUIRED:multi_stop");
        }

        const [start, end, ...stops] = await Promise.all([
          geocodeAddress(data.start_address),
          geocodeAddress(data.end_address),
          ...data.stops.map((s) => geocodeAddress(s)),
        ]);

        const normalizedPreferences = normalizeJourneyPreferences({
          mood: data.mood,
          theme: data.theme,
          extraMinutes: data.extra_minutes,
        });
        const moodIn = normalizedPreferences.mood;
        const themeIn = normalizedPreferences.theme;
        const requestJourneyMode = journeyMode(normalizedPreferences);
        const generationPath = journeyGenerationPath(normalizedPreferences);
        const waypoints = stops.map((stop) => ({
          name: stop.formatted,
          lat: stop.lat,
          lng: stop.lng,
          description: "Required stop",
        }));
        const routeInput = {
          origin: { lat: start.lat, lng: start.lng },
          destination: { lat: end.lat, lng: end.lng },
          waypoints: waypoints.map(({ lat, lng }) => ({ lat, lng })),
        };
        let baselineRequestSuccess = false;
        let stableErrorCode = "OK";
        let baseline;
        let internalRouteDiagnosticFields: {
          routeGenerationDiagnostics?: RouteGenerationDiagnostic;
        } = {};
        try {
          routesCallCount += 1;
          baseline = await computeDirections({ ...routeInput, alternatives: false });
          baselineRequestSuccess = true;
        } catch (error) {
          stableErrorCode =
            error instanceof Error && error.message === "MALFORMED_ROUTE_DURATION"
              ? "MALFORMED_ROUTE_DURATION"
              : "BASELINE_ROUTE_UNAVAILABLE";
          console.info("[route-selection]", {
            requestCorrelationId,
            baselineRequestSuccess,
            candidateCount: 0,
            eligibleCount: 0,
            requestedBudgetMinutes: data.extra_minutes,
            selectedExtraTimeMinutes: 0,
            errorCode: stableErrorCode,
          });
          if (error instanceof Error && error.message === "MAPS_NOT_CONFIGURED") throw error;
          throw new Error(stableErrorCode);
        }

        let alternativesUnavailableReason: string | null = null;
        let googleDirections = [baseline];
        if (waypoints.length > 0) {
          alternativesUnavailableReason = "REQUIRED_STOPS";
        } else {
          try {
            routesCallCount += 1;
            const alternativeResponse = await computeDirections({
              ...routeInput,
              alternatives: true,
            });
            googleDirections = [
              baseline,
              ...(alternativeResponse.candidates ?? [alternativeResponse]),
            ];
          } catch {
            alternativesUnavailableReason = "ALTERNATIVE_REQUEST_FAILED";
            stableErrorCode = "ALTERNATIVE_REQUEST_FAILED_FALLBACK";
          }
        }

        const {
          maximumAllowedDurationSeconds: durationCeiling,
          candidateBudgetUtilisation,
          candidateSelectionDiagnostics,
          routesAreNearIdentical,
          routesAreMeaningfullyDifferent,
          selectRouteCandidate,
        } = await import("./route-selection");
        const { safeEvaluateRouteCoherence, safeEvaluateRouteCoherenceWithAnchors } =
          await import("./route-coherence");
        const { verifiedMeaningfulPlaceName } = await import("./scenic-waypoint");
        const { routeResultNarrative, verifiedJourneyHighlights } =
          await import("./journey-timeline");
        const diagnosticDurationCeiling = durationCeiling(
          baseline.durationSeconds,
          data.extra_minutes,
        );
        const trustedBaselineShape = {
          routeShapeEligible: true,
          routeShapeRejectionReason: null,
          reverseOverlapDistanceMeters: 0,
          reverseOverlapRatio: 0,
          waypointSpurDetected: false,
          affectedWaypointIndex: null,
          waypointAssociationStatus: "UNAVAILABLE",
          routeShapeAnalysisStatus: "TRUSTED_BASELINE",
        } as const;
        const googleRouteShapes = googleDirections.map((directions, index) =>
          index === 0
            ? trustedBaselineShape
            : safeEvaluateRouteCoherence(directions.encodedPolyline),
        );
        const generatedCandidateOutcomes: Array<{
          candidateId: string;
          explorationStage: number | null;
          source: "fastest" | "google" | "scenik";
          intendedAddedMinutes: number | null;
          constructionTargetMinutes: number | null;
          refinementParentCandidateId: string | null;
          refinementUpperCandidateId: string | null;
          refinementAttemptNumber: number | null;
          refinementStrategy:
            | import("./route-duration-refinement").DurationRefinementStrategy
            | null;
          refinementBracketLowerMinutes: number | null;
          refinementBracketUpperMinutes: number | null;
          durationSeconds: number | null;
          addedMinutes: number | null;
          allowanceUtilisation: number | null;
          durationTargetClassification:
            | "SEVERE_UNDERSHOOT"
            | "MODERATE_UNDERSHOOT"
            | "TARGET_BAND"
            | "OVER_BUDGET"
            | null;
          estimatedDetourMeters: number | null;
          waypointCount: number;
          requiredStopOrderPreserved: boolean;
          duplicate: boolean | null;
          outcome:
            | "ELIGIBLE"
            | "OVER_TIME_BUDGET"
            | "DUPLICATE_ROUTE"
            | "INCOHERENT_ROUTE"
            | "ROUTE_REQUEST_FAILED";
          routeShapeEligible: boolean | null;
          routeShapeRejectionReason: string | null;
          reverseOverlapDistanceMeters: number | null;
          reverseOverlapRatio: number | null;
          waypointSpurDetected: boolean | null;
          affectedWaypointIndex: number | null;
          waypointAssociationStatus: string | null;
          routeShapeAnalysisStatus: string | null;
        }> = googleDirections.map((directions, index, all) => {
          const duplicate = all
            .slice(0, index)
            .some((prior) => routesAreNearIdentical(prior, directions));
          const withinBudget = directions.durationSeconds <= diagnosticDurationCeiling;
          const routeShape = googleRouteShapes[index];
          return {
            candidateId: `${index === 0 ? "baseline" : "google-alternative"}-${index}`,
            explorationStage: null,
            source: index === 0 ? "fastest" : "google",
            intendedAddedMinutes: null,
            constructionTargetMinutes: null,
            refinementParentCandidateId: null,
            refinementUpperCandidateId: null,
            refinementAttemptNumber: null,
            refinementStrategy: null,
            refinementBracketLowerMinutes: null,
            refinementBracketUpperMinutes: null,
            durationSeconds: directions.durationSeconds,
            addedMinutes:
              Math.round(
                (Math.max(0, directions.durationSeconds - baseline.durationSeconds) / 60) * 10,
              ) / 10,
            allowanceUtilisation: candidateBudgetUtilisation(
              baseline.durationSeconds,
              directions.durationSeconds,
              data.extra_minutes,
            ),
            durationTargetClassification: null,
            estimatedDetourMeters: null,
            waypointCount: 0,
            requiredStopOrderPreserved: true,
            duplicate,
            outcome: !withinBudget
              ? "OVER_TIME_BUDGET"
              : duplicate
                ? "DUPLICATE_ROUTE"
                : !routeShape.routeShapeEligible
                  ? "INCOHERENT_ROUTE"
                  : "ELIGIBLE",
            routeShapeEligible: routeShape.routeShapeEligible,
            routeShapeRejectionReason: routeShape.routeShapeRejectionReason,
            reverseOverlapDistanceMeters: routeShape.reverseOverlapDistanceMeters,
            reverseOverlapRatio: routeShape.reverseOverlapRatio,
            waypointSpurDetected: routeShape.waypointSpurDetected,
            affectedWaypointIndex: routeShape.affectedWaypointIndex,
            waypointAssociationStatus: routeShape.waypointAssociationStatus,
            routeShapeAnalysisStatus: routeShape.routeShapeAnalysisStatus,
          };
        });
        const distinctGoogleDirections = googleDirections.filter(
          (directions, index, all) =>
            !all.slice(0, index).some((prior) => routesAreNearIdentical(prior, directions)),
        );
        const rawCandidates: Array<{
          candidateId: string;
          explorationStage: number | null;
          directions: typeof baseline;
          source: "fastest" | "google" | "scenik";
          selectedWaypointReason: string | null;
          intendedAddedMinutes: number | null;
          constructionTargetMinutes: number | null;
          durationTargetClassification:
            | "SEVERE_UNDERSHOOT"
            | "MODERATE_UNDERSHOOT"
            | "TARGET_BAND"
            | "OVER_BUDGET"
            | null;
          scenicWaypoints: Array<{
            id: string;
            lat: number;
            lng: number;
            reason: string;
            insertionIndex: number;
            estimatedDetourMeters: number;
            primaryType: string;
            types: string[];
            displayName?: string;
            alternativeDisplayName?: string;
            categoryName?: string;
            rating?: number;
            userRatingCount?: number;
            photoUrl?: string;
          }>;
          routeShapeEligible: boolean;
          requestedRole?: import("./corridor-exploration").PositiveAllowanceAttemptRole | null;
          effectiveConstruction?:
            | import("./route-duration-refinement").EffectiveConstructionMetadata
            | null;
        }> = distinctGoogleDirections.map((directions, index) => {
          const googleIndex = googleDirections.indexOf(directions);
          return {
            candidateId: `${googleIndex === 0 ? "baseline" : "google-alternative"}-${googleIndex}`,
            explorationStage: null,
            directions,
            source: index === 0 ? "fastest" : "google",
            selectedWaypointReason: null,
            intendedAddedMinutes: null,
            constructionTargetMinutes: null,
            durationTargetClassification: null,
            scenicWaypoints: [],
            routeShapeEligible: googleRouteShapes[googleIndex]?.routeShapeEligible ?? false,
          };
        });
        let nextCandidateOrdinal = googleDirections.length;

        let scenikCandidateAdded = false;
        let scenicCandidateCount = 0;
        let evidencePlaces: Array<{
          id: string;
          lat: number;
          lng: number;
          primaryType: string;
          types: string[];
          displayName?: string;
          alternativeDisplayName?: string;
          categoryName?: string;
          rating?: number;
          userRatingCount?: number;
          photoUrl?: string;
        }> = [];
        if (generationPath === "zero-allowance-personalised") {
          try {
            const { corridorSampleCount, routeCorridorSamples, selectedPlaceTypes } =
              await import("./scenic-waypoint");
            const moods = moodIn
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean);
            const themes = themeIn
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean);
            const candidateCentres = routeCorridorSamples(
              routeInput.origin,
              routeInput.destination,
              baseline.steps,
              corridorSampleCount(baseline.distanceMeters),
            );
            const evidence = await collectZeroAllowanceJourneyEvidence({
              preferences: normalizedPreferences,
              candidateCentres,
              radiusMeters: 1_000,
              search: (center) =>
                searchNearbyScenicPlaces({
                  center,
                  radiusMeters: 1_000,
                  includedTypes: selectedPlaceTypes(moods, themes),
                }),
              evidenceCap: 70,
            });
            placesCallCount += evidence.callCount;
            evidencePlaces = evidence.places;
          } catch {
            rejectionReasons.add("ZERO_ALLOWANCE_EVIDENCE_UNAVAILABLE");
          }
        }
        if (generationPath === "scenic-exploration") {
          try {
            const {
              candidateFitsTimeBudget,
              corridorSampleCount,
              routeCorridorSamples,
              selectedPlaceTypes,
            } = await import("./scenic-waypoint");
            const {
              adaptiveDurationTargetMinutes,
              budgetUtilisation,
              classifyDurationTargetResult,
              corridorWaypointsWithRequiredStops,
              createOrdinaryPlanningCounter,
              createPositiveAllowanceProductionCoordinator,
              effectivePlanningOutcome,
              explorationShouldStop,
              explorationStages,
              isTargetBudgetCandidate,
              deterministicallyRankCorridorEvidence,
            } = await import("./corridor-exploration");
            const {
              MAX_SCENIC_ROUTE_ATTEMPTS,
              MAX_DERIVED_WAYPOINT_DISPLACEMENT_FROM_SOURCE_METERS,
              createRequestLocalPlanFamily,
              effectiveConstructionMetadata,
              evaluateRefinedProviderCandidate,
              orchestrateDurationRefinement,
              recordRefinedProviderCandidate,
              scoreAndSelectRouteCandidateCollection,
            } = await import("./route-duration-refinement");
            const { runSequentialLongAttempts } = await import("./route-generation-diagnostics");
            const { safeAssociateEvidenceWithRoute } = await import("./route-evidence-association");
            const { scoreScenicRoute: scoreExploredRoute } = await import("./scenic-score");
            const { upgradeOverrunToleranceSeconds } = await import("./route-upgrade");
            const moods = moodIn
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean);
            const themes = themeIn
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean);
            const includedTypes = selectedPlaceTypes(moods, themes);
            if (includedTypes.length > 0) {
              const productionCoordinator = createPositiveAllowanceProductionCoordinator({
                candidates: rawCandidates,
                onPlacesRequested: (count) => {
                  placesCallCount += count;
                },
                onRouteRequested: () => {
                  scenicRouteRequestsAttempted += 1;
                  routesCallCount += 1;
                },
              });
              const budgetSeconds = data.extra_minutes * 60;
              const averageMetersPerSecond = baseline.distanceMeters / baseline.durationSeconds;
              const requiredCoordinates = routeInput.waypoints.map(({ lat, lng }) => ({
                lat,
                lng,
              }));
              const anchors = [routeInput.origin, ...requiredCoordinates, routeInput.destination];
              const uniquePlaces = new Map<string, (typeof evidencePlaces)[number]>();
              const requestLocalEvidenceIds = new Map<string, string>();
              const requestLocalEvidenceId = (placeId: string) => {
                const existing = requestLocalEvidenceIds.get(placeId);
                if (existing) return existing;
                const created = `evidence-${requestLocalEvidenceIds.size + 1}`;
                requestLocalEvidenceIds.set(placeId, created);
                return created;
              };
              const attemptedSignatures = new Set<string>();
              const attemptedKinds = new Set<import("./corridor-exploration").ScenicCorridorKind>();
              const constructionObservations: Array<{
                plan: import("./corridor-exploration").ScenicCorridorPlan;
                family: import("./route-duration-refinement").RequestLocalPlanFamily | null;
                observation: import("./route-duration-refinement").DurationConstructionObservation;
              }> = [];
              const constructionFamilies = new Map<
                string,
                import("./route-duration-refinement").RequestLocalPlanFamily
              >();
              const evidenceByTarget = new Map<number, (typeof evidencePlaces)[number][]>();
              const stages = explorationStages(data.extra_minutes);
              const ordinaryPlanningCounter = createOrdinaryPlanningCounter(
                stages.reduce((total, stage) => total + stage.targetExtraMinutes.length, 0),
              );
              ordinaryPlanningSummary = ordinaryPlanningCounter.snapshot();
              const recordOrdinaryPlanningOutcome = (
                outcome: import("./corridor-exploration").OrdinaryPlanningOutcome,
                targetMinutes: number,
                attemptId: string,
              ) => {
                ordinaryPlanningCounter.record(outcome);
                processedOrdinaryAttempts.push({ attemptId, targetMinutes });
                ordinaryPlanningSummary = ordinaryPlanningCounter.snapshot();
              };
              let bestExploredScore = 0;
              const exploredCandidateQuality: Array<{ score: number; utilisation: number }> = [];
              for (const [stageIndex, stage] of stages.entries()) {
                const baselineSamples = routeCorridorSamples(
                  routeInput.origin,
                  routeInput.destination,
                  baseline.steps,
                  Math.min(corridorSampleCount(baseline.distanceMeters), stage.sampleCap),
                );
                const preparedStage = productionCoordinator.prepareStage({
                  samples: baselineSamples,
                  baselineDistanceMeters: baseline.distanceMeters,
                  baselineDurationSeconds: baseline.durationSeconds,
                  targetExtraMinutes: stage.targetExtraMinutes,
                  attemptRoles: stage.attemptRoles,
                });
                const collidedTargets = stage.targetExtraMinutes.filter(
                  (target) => !preparedStage.targets.includes(target),
                );
                collidedTargets.forEach((target, collisionIndex) =>
                  recordOrdinaryPlanningOutcome(
                    "EFFECTIVE_COLLISION",
                    target,
                    `stage-${stageIndex}-collision-${collisionIndex}`,
                  ),
                );
                const stageTargets = preparedStage.targets;
                if (stageTargets.length === 0) continue;
                const durationAwareSamples = preparedStage.samples;
                const samples = durationAwareSamples.length
                  ? durationAwareSamples.map((sample) => sample.center)
                  : baselineSamples;
                corridorSamplesUsed += samples.length;
                const placeResults = await productionCoordinator.collectPlaces(samples, (center) =>
                  searchNearbyScenicPlaces({
                    center,
                    radiusMeters: stage.radiusMeters,
                    includedTypes,
                  }),
                );
                const returnedPlaces = placeResults.flatMap((result) =>
                  result.status === "fulfilled" ? result.value : [],
                );
                placeResults.forEach((result, index) => {
                  if (result.status !== "fulfilled") return;
                  const target = durationAwareSamples[index]?.targetExtraMinutes;
                  if (target == null) return;
                  evidenceByTarget.set(
                    target,
                    deterministicallyRankCorridorEvidence(
                      [...(evidenceByTarget.get(target) ?? []), ...result.value],
                      new Set(includedTypes),
                      stage.attemptRoles.find((role) => role.targetExtraMinutes === target)
                        ?.evidencePreference,
                    ).slice(0, 70),
                  );
                });
                placesRequestsSucceeded += placeResults.filter(
                  (result) => result.status === "fulfilled",
                ).length;
                placesRequestsFailed += placeResults.filter(
                  (result) => result.status === "rejected",
                ).length;
                evidenceRecordsReturned += returnedPlaces.length;
                const rankedPlaces = deterministicallyRankCorridorEvidence(
                  [...uniquePlaces.values(), ...returnedPlaces],
                  new Set(includedTypes),
                );
                uniquePlaces.clear();
                for (const place of rankedPlaces) {
                  if (uniquePlaces.has(place.id) || uniquePlaces.size >= stage.cumulativePlaceCap)
                    continue;
                  uniquePlaces.set(place.id, place);
                  requestLocalEvidenceId(place.id);
                }
                evidencePlaces = [...uniquePlaces.values()];
                evidenceSetSizes.add(evidencePlaces.length);
                deduplicatedPlaceCount = evidencePlaces.length;
                const stageBaselineAssociation = safeAssociateEvidenceWithRoute({
                  encodedPolyline: baseline.encodedPolyline,
                  places: evidencePlaces,
                  proximityMeters: 750,
                });
                const stageBaselineScore = scoreExploredRoute({
                  start,
                  end,
                  mood: moodIn,
                  theme: themeIn,
                  extraMinutes: data.extra_minutes,
                  stopCount: waypoints.length,
                  directions: baseline,
                  evidence: stageBaselineAssociation.evidence,
                  fastestDurationSeconds: baseline.durationSeconds,
                }).total;
                bestExploredScore = Math.max(bestExploredScore, stageBaselineScore);
                exploredCandidateQuality.push({ score: stageBaselineScore, utilisation: 0 });
                const remainingRouteCalls = Math.max(
                  0,
                  Math.min(
                    stageTargets.length,
                    stage.cumulativeRouteCap - scenicRouteRequestsAttempted,
                  ),
                );
                const planningAnchors =
                  stageTargets.length > 0 && requiredCoordinates.length === 0
                    ? [routeInput.origin, ...baselineSamples, routeInput.destination]
                    : anchors;
                const updatePlanningDiagnostics = (planning: {
                  considered: number;
                  rejectedDuplicate: number;
                  rejectedBacktracking: number;
                  rejectedEffectiveCollision: number;
                }) => {
                  waypointPlansConsidered = Math.max(waypointPlansConsidered, planning.considered);
                  waypointPlansRejectedDuplicate = Math.max(
                    waypointPlansRejectedDuplicate,
                    planning.rejectedDuplicate,
                  );
                  waypointPlansRejectedBacktracking = Math.max(
                    waypointPlansRejectedBacktracking,
                    planning.rejectedBacktracking,
                  );
                };
                const requestCandidate = (
                  plan: import("./corridor-exploration").ScenicCorridorPlan,
                  lineageSource: "scenic-stage" | "long-target" | "duration-refinement",
                  existingFamily?: import("./route-duration-refinement").RequestLocalPlanFamily,
                ) => {
                  const candidateId = `${lineageSource}-${nextCandidateOrdinal++}`;
                  const family = existingFamily
                    ? {
                        ...existingFamily,
                        currentDisplacementMeters: plan.estimatedDetourMeters,
                      }
                    : createRequestLocalPlanFamily({
                        familyId: `family-${nextCandidateOrdinal}`,
                        origin: routeInput.origin,
                        destination: routeInput.destination,
                        requiredStops: requiredCoordinates,
                        anchors: planningAnchors,
                        sourceWaypointIds: plan.waypoints.map((waypoint) =>
                          requestLocalEvidenceId(waypoint.id),
                        ),
                        plan,
                      });
                  attemptedSignatures.add(plan.signature);
                  attemptedKinds.add(plan.kind);
                  const requestWaypoints = corridorWaypointsWithRequiredStops(
                    requiredCoordinates,
                    planningAnchors,
                    plan,
                  );
                  return {
                    candidateId,
                    family,
                    expectedAnchors: [
                      routeInput.origin,
                      ...requestWaypoints,
                      routeInput.destination,
                    ],
                    request: productionCoordinator.requestRoute(() =>
                      computeDirections({
                        origin: routeInput.origin,
                        destination: routeInput.destination,
                        waypoints: requestWaypoints,
                        alternatives: false,
                      }),
                    ),
                  };
                };
                const recordCandidateResult = (
                  corridorPlan: import("./corridor-exploration").ScenicCorridorPlan,
                  result: PromiseSettledResult<typeof baseline>,
                  intendedAddedMinutes: number | null,
                  constructionTargetMinutes: number | null,
                  candidateId: string,
                  refinement?: {
                    parentCandidateId: string;
                    upperCandidateId: string | null;
                    attemptNumber: number;
                    strategy: import("./route-duration-refinement").DurationRefinementStrategy;
                    bracketLowerMinutes: number;
                    bracketUpperMinutes: number | null;
                  },
                  existingRefinedRecording?: ReturnType<typeof recordRefinedProviderCandidate>,
                  expectedAnchors: import("./scenic-waypoint").LatLng[] = [
                    routeInput.origin,
                    ...corridorWaypointsWithRequiredStops(
                      requiredCoordinates,
                      planningAnchors,
                      corridorPlan,
                    ),
                    routeInput.destination,
                  ],
                  requestedRole:
                    | import("./corridor-exploration").PositiveAllowanceAttemptRole
                    | null = null,
                ): number | null => {
                  scenicRouteRequestsCompleted += 1;
                  if (result.status === "rejected") {
                    generatedCandidateOutcomes.push({
                      candidateId,
                      explorationStage: stageIndex,
                      source: "scenik",
                      intendedAddedMinutes,
                      constructionTargetMinutes,
                      refinementParentCandidateId: refinement?.parentCandidateId ?? null,
                      refinementUpperCandidateId: refinement?.upperCandidateId ?? null,
                      refinementAttemptNumber: refinement?.attemptNumber ?? null,
                      refinementStrategy: refinement?.strategy ?? null,
                      refinementBracketLowerMinutes: refinement?.bracketLowerMinutes ?? null,
                      refinementBracketUpperMinutes: refinement?.bracketUpperMinutes ?? null,
                      durationSeconds: null,
                      addedMinutes: null,
                      allowanceUtilisation: null,
                      durationTargetClassification: null,
                      estimatedDetourMeters: corridorPlan.estimatedDetourMeters,
                      waypointCount: corridorPlan.waypoints.length,
                      requiredStopOrderPreserved: true,
                      duplicate: null,
                      outcome: "ROUTE_REQUEST_FAILED",
                      routeShapeEligible: null,
                      routeShapeRejectionReason: null,
                      reverseOverlapDistanceMeters: null,
                      reverseOverlapRatio: null,
                      waypointSpurDetected: null,
                      affectedWaypointIndex: null,
                      waypointAssociationStatus: null,
                      routeShapeAnalysisStatus: null,
                    });
                    stableErrorCode = "SCENIK_CANDIDATE_UNAVAILABLE_FALLBACK";
                    rejectionReasons.add("ROUTE_REQUEST_FAILED");
                    return null;
                  }
                  scenicRoutesReturned += 1;
                  const scenikDirections = result.value;
                  const actualAddedSeconds = Math.max(
                    0,
                    scenikDirections.durationSeconds - baseline.durationSeconds,
                  );
                  const actualAddedMinutes = Math.round((actualAddedSeconds / 60) * 10) / 10;
                  const refinedEvaluation = refinement
                    ? evaluateRefinedProviderCandidate({
                        baseline,
                        directions: scenikDirections,
                        priorDirections: rawCandidates.map((candidate) => candidate.directions),
                        shapingPlan: corridorPlan,
                        evidencePlaces,
                        start,
                        end,
                        mood: moodIn,
                        theme: themeIn,
                        requestedExtraMinutes: data.extra_minutes,
                        requiredStopCount: waypoints.length,
                        expectedAnchors,
                      })
                    : null;
                  const withinBudget =
                    refinedEvaluation?.withinBudget ??
                    candidateFitsTimeBudget(
                      baseline.durationSeconds,
                      scenikDirections.durationSeconds,
                      data.extra_minutes,
                    );
                  const withinUpgradeWindow =
                    !withinBudget &&
                    scenikDirections.durationSeconds <=
                      baseline.durationSeconds +
                        budgetSeconds +
                        upgradeOverrunToleranceSeconds(data.extra_minutes);
                  const meaningfullyDifferent =
                    refinedEvaluation?.meaningfullyDifferent ??
                    rawCandidates.every((candidate) =>
                      routesAreMeaningfullyDifferent(candidate.directions, scenikDirections),
                    );
                  const routeShape =
                    refinedEvaluation?.routeShape ??
                    safeEvaluateRouteCoherenceWithAnchors(
                      scenikDirections.encodedPolyline,
                      corridorPlan.waypoints,
                      expectedAnchors,
                    );
                  const durationTargetClassification =
                    intendedAddedMinutes == null
                      ? null
                      : classifyDurationTargetResult(
                          intendedAddedMinutes,
                          actualAddedMinutes,
                          data.extra_minutes,
                        );
                  const candidateFamily = constructionFamilies.get(candidateId) ?? null;
                  const effectiveConstruction = effectiveConstructionMetadata(
                    corridorPlan,
                    planningAnchors,
                  );
                  const refinedRecording =
                    existingRefinedRecording ??
                    (refinement && candidateFamily
                      ? recordRefinedProviderCandidate({
                          candidates: rawCandidates,
                          candidateId,
                          parentCandidateId: refinement.parentCandidateId,
                          familyId: candidateFamily.familyId,
                          attemptNumber: refinement.attemptNumber,
                          explorationStage: stageIndex,
                          directions: scenikDirections,
                          shapingPlan: corridorPlan,
                          evidencePlaces,
                          start,
                          end,
                          mood: moodIn,
                          theme: themeIn,
                          requestedExtraMinutes: data.extra_minutes,
                          requiredStopCount: waypoints.length,
                          expectedAnchors,
                          constructionAnchors: candidateFamily.anchors,
                          intendedAddedMinutes: intendedAddedMinutes ?? 0,
                          constructionTargetMinutes: constructionTargetMinutes ?? 0,
                        })
                      : null);
                  const constructionObservation =
                    refinedRecording?.observation ??
                    ({
                      candidateId,
                      relatedPlanKey: candidateFamily?.familyId ?? `unrelated-${candidateId}`,
                      actualAddedSeconds,
                      constructionValue:
                        candidateFamily?.currentDisplacementMeters ??
                        corridorPlan.estimatedDetourMeters,
                      withinBudget,
                      routeShapeEligible: routeShape.routeShapeEligible,
                      duplicate: !meaningfullyDifferent,
                      qualityEligible: false,
                      calibrationSafe:
                        Number.isFinite(actualAddedSeconds) &&
                        actualAddedSeconds > 0 &&
                        routeShape.routeShapeEligible &&
                        meaningfullyDifferent &&
                        candidateFamily != null,
                      intendedTargetSeconds:
                        intendedAddedMinutes == null ? null : intendedAddedMinutes * 60,
                      constructionTargetSeconds:
                        constructionTargetMinutes == null ? null : constructionTargetMinutes * 60,
                      adaptiveTargetSeconds:
                        intendedAddedMinutes != null &&
                        constructionTargetMinutes != null &&
                        constructionTargetMinutes !== intendedAddedMinutes
                          ? constructionTargetMinutes * 60
                          : null,
                      requestedRole,
                      effectiveConstruction,
                      effectiveWaypointCount: corridorPlan.waypoints.length,
                    } satisfies import("./route-duration-refinement").DurationConstructionObservation);
                  constructionObservations.push({
                    plan: corridorPlan,
                    family: candidateFamily,
                    observation: constructionObservation,
                  });
                  constructionMetadataByCandidateId.set(candidateId, constructionObservation);
                  generatedCandidateOutcomes.push({
                    candidateId,
                    explorationStage: stageIndex,
                    source: "scenik",
                    intendedAddedMinutes,
                    constructionTargetMinutes,
                    refinementParentCandidateId: refinement?.parentCandidateId ?? null,
                    refinementUpperCandidateId: refinement?.upperCandidateId ?? null,
                    refinementAttemptNumber: refinement?.attemptNumber ?? null,
                    refinementStrategy: refinement?.strategy ?? null,
                    refinementBracketLowerMinutes: refinement?.bracketLowerMinutes ?? null,
                    refinementBracketUpperMinutes: refinement?.bracketUpperMinutes ?? null,
                    durationSeconds: scenikDirections.durationSeconds,
                    addedMinutes: actualAddedMinutes,
                    allowanceUtilisation: candidateBudgetUtilisation(
                      baseline.durationSeconds,
                      scenikDirections.durationSeconds,
                      data.extra_minutes,
                    ),
                    durationTargetClassification:
                      refinedRecording?.durationTargetClassification ??
                      durationTargetClassification,
                    estimatedDetourMeters: corridorPlan.estimatedDetourMeters,
                    waypointCount: corridorPlan.waypoints.length,
                    requiredStopOrderPreserved: true,
                    duplicate: !meaningfullyDifferent,
                    outcome: !withinBudget
                      ? "OVER_TIME_BUDGET"
                      : !meaningfullyDifferent
                        ? "DUPLICATE_ROUTE"
                        : !routeShape.routeShapeEligible
                          ? "INCOHERENT_ROUTE"
                          : "ELIGIBLE",
                    routeShapeEligible: routeShape.routeShapeEligible,
                    routeShapeRejectionReason: routeShape.routeShapeRejectionReason,
                    reverseOverlapDistanceMeters: routeShape.reverseOverlapDistanceMeters,
                    reverseOverlapRatio: routeShape.reverseOverlapRatio,
                    waypointSpurDetected: routeShape.waypointSpurDetected,
                    affectedWaypointIndex: routeShape.affectedWaypointIndex,
                    waypointAssociationStatus: routeShape.waypointAssociationStatus,
                    routeShapeAnalysisStatus: routeShape.routeShapeAnalysisStatus,
                  });
                  if (!withinBudget) {
                    scenicRoutesRejectedOverBudget += 1;
                    rejectionReasons.add("OVER_TIME_BUDGET");
                  } else if (!meaningfullyDifferent) {
                    rejectionReasons.add("DUPLICATE_ROUTE");
                  } else if (!routeShape.routeShapeEligible) {
                    rejectionReasons.add("INCOHERENT_ROUTE");
                  }
                  if (
                    (withinBudget || withinUpgradeWindow) &&
                    meaningfullyDifferent &&
                    routeShape.routeShapeEligible
                  ) {
                    if (refinement && candidateFamily) {
                      // The shared recorder already inserted or rejected this candidate.
                    } else if (!refinement) {
                      productionCoordinator.recordCandidate({
                        candidateId,
                        explorationStage: stageIndex,
                        directions: scenikDirections,
                        source: "scenik",
                        selectedWaypointReason: verifiedJourneyHighlights(corridorPlan.waypoints),
                        intendedAddedMinutes,
                        constructionTargetMinutes,
                        durationTargetClassification,
                        scenicWaypoints: corridorPlan.waypoints.map((waypoint) => ({
                          ...waypoint,
                        })),
                        routeShapeEligible: true,
                        requestedRole,
                        effectiveConstruction,
                      });
                    }
                    scenikCandidateAdded = true;
                    scenicCandidateCount += 1;
                    if (withinBudget) scenicRoutesAccepted += 1;
                    const candidateAssociation =
                      refinedEvaluation?.evidenceAssociation ??
                      safeAssociateEvidenceWithRoute({
                        encodedPolyline: scenikDirections.encodedPolyline,
                        places: evidencePlaces,
                        waypoints: corridorPlan.waypoints,
                        proximityMeters: 750,
                      });
                    const candidateScore =
                      refinedEvaluation?.scoreResult.total ??
                      scoreExploredRoute({
                        start,
                        end,
                        mood: moodIn,
                        theme: themeIn,
                        extraMinutes: data.extra_minutes,
                        stopCount: waypoints.length + corridorPlan.waypoints.length,
                        directions: scenikDirections,
                        evidence: candidateAssociation.evidence,
                        fastestDurationSeconds: baseline.durationSeconds,
                      }).total;
                    if (!refinedRecording) {
                      constructionObservation.qualityEligible =
                        candidateScore >= 60 &&
                        Object.values(candidateAssociation.evidence).some((count) => count > 0);
                    }
                    bestExploredScore = Math.max(bestExploredScore, candidateScore);
                    if (withinBudget)
                      exploredCandidateQuality.push({
                        score: candidateScore,
                        utilisation: budgetUtilisation(
                          baseline.durationSeconds,
                          scenikDirections.durationSeconds,
                          data.extra_minutes,
                        ),
                      });
                  }
                  return actualAddedMinutes;
                };

                if (stageTargets.length > 1) {
                  longAttemptExecutions = await runSequentialLongAttempts({
                    intendedTargets: stageTargets.slice(0, remainingRouteCalls),
                    maximumExtraMinutes: data.extra_minutes,
                    adaptiveTarget: adaptiveDurationTargetMinutes,
                    execute: async ({ intendedTargetMinutes, adaptiveTargetMinutes }) => {
                      const attemptRole = stage.attemptRoles.find(
                        (role) => role.targetExtraMinutes === intendedTargetMinutes,
                      );
                      if (!attemptRole) {
                        recordOrdinaryPlanningOutcome(
                          "NO_PLAN",
                          intendedTargetMinutes,
                          `stage-${stageIndex}-target-${intendedTargetMinutes}`,
                        );
                        return { status: "NO_PLAN", actualAddedMinutes: null };
                      }
                      const planning = productionCoordinator.prepareRoutePlan({
                        places: evidenceByTarget.get(intendedTargetMinutes) ?? evidencePlaces,
                        preferredTypes: new Set(includedTypes),
                        anchors: planningAnchors,
                        maximumEstimatedDetourMeters:
                          averageMetersPerSecond * stage.planningBudgetMinutes * 60 * 0.95,
                        attemptedSignatures,
                        attemptedKinds,
                        targetDetourMeters: [averageMetersPerSecond * adaptiveTargetMinutes * 60],
                        attemptRole,
                      });
                      updatePlanningDiagnostics(planning);
                      const planningOutcome = effectivePlanningOutcome(planning);
                      recordOrdinaryPlanningOutcome(
                        planningOutcome.outcome,
                        intendedTargetMinutes,
                        `stage-${stageIndex}-target-${intendedTargetMinutes}`,
                      );
                      const plan = planningOutcome.plan;
                      if (!plan) {
                        return {
                          status:
                            planningOutcome.outcome === "EFFECTIVE_COLLISION"
                              ? "EFFECTIVE_COLLISION"
                              : "NO_PLAN",
                          actualAddedMinutes: null,
                        };
                      }
                      const requested = requestCandidate(plan, "long-target");
                      if (requested.family)
                        constructionFamilies.set(requested.candidateId, requested.family);
                      const [result] = await Promise.allSettled([requested.request]);
                      const actualAddedMinutes = recordCandidateResult(
                        plan,
                        result,
                        intendedTargetMinutes,
                        adaptiveTargetMinutes,
                        requested.candidateId,
                        undefined,
                        undefined,
                        requested.expectedAnchors,
                        attemptRole,
                      );
                      return {
                        status: result.status === "fulfilled" ? "COMPLETED" : "FAILED",
                        actualAddedMinutes,
                      };
                    },
                  });
                } else {
                  const attemptRole = stage.attemptRoles.find(
                    (role) => role.targetExtraMinutes === stageTargets[0],
                  );
                  const planning = attemptRole
                    ? productionCoordinator.prepareRoutePlan({
                        places: evidenceByTarget.get(stageTargets[0]) ?? evidencePlaces,
                        preferredTypes: new Set(includedTypes),
                        anchors: planningAnchors,
                        maximumEstimatedDetourMeters:
                          averageMetersPerSecond * stage.planningBudgetMinutes * 60 * 0.95,
                        attemptedSignatures,
                        attemptedKinds,
                        targetDetourMeters: stageTargets.map(
                          (target) => averageMetersPerSecond * target * 60,
                        ),
                        attemptRole,
                      })
                    : {
                        plans: [],
                        considered: 0,
                        rejectedDuplicate: 0,
                        rejectedBacktracking: 0,
                        rejectedEffectiveCollision: 0,
                      };
                  updatePlanningDiagnostics(planning);
                  const planningOutcome = effectivePlanningOutcome(planning);
                  recordOrdinaryPlanningOutcome(
                    planningOutcome.outcome,
                    stageTargets[0],
                    `stage-${stageIndex}-target-${stageTargets[0]}`,
                  );
                  const candidateRequests = planningOutcome.plan
                    ? [planningOutcome.plan].map((plan) => {
                        const requested = requestCandidate(plan, "scenic-stage");
                        if (requested.family)
                          constructionFamilies.set(requested.candidateId, requested.family);
                        return { plan, ...requested };
                      })
                    : [];
                  const candidateResults = await Promise.allSettled(
                    candidateRequests.map(({ request }) => request),
                  );
                  candidateResults.forEach((result, index) =>
                    recordCandidateResult(
                      candidateRequests[index].plan,
                      result,
                      stageTargets[0],
                      stageTargets[0],
                      candidateRequests[index].candidateId,
                      undefined,
                      undefined,
                      candidateRequests[index].expectedAnchors,
                      attemptRole ?? null,
                    ),
                  );
                }
                if (stageIndex === stages.length - 1) {
                  const maximumConstructionValue = Math.min(
                    averageMetersPerSecond * stage.planningBudgetMinutes * 60 * 0.95,
                    Math.max(
                      0,
                      ...constructionObservations.map(
                        ({ observation }) => observation.constructionValue,
                      ),
                    ) + MAX_DERIVED_WAYPOINT_DISPLACEMENT_FROM_SOURCE_METERS,
                  );
                  const orchestration = await orchestrateDurationRefinement({
                    candidates: rawCandidates,
                    relatedCandidates: constructionObservations.flatMap(
                      ({ observation, family }) =>
                        family ? [{ candidateId: observation.candidateId, family }] : [],
                    ),
                    existingObservations: constructionObservations.map(
                      ({ observation }) => observation,
                    ),
                    evidencePlaces,
                    start,
                    end,
                    mood: moodIn,
                    theme: themeIn,
                    requestedExtraMinutes: data.extra_minutes,
                    requiredStopCount: waypoints.length,
                    attemptsAlreadyUsed: scenicRouteRequestsAttempted,
                    maximumConstructionValue,
                    explorationStage: stageIndex,
                    isEffectiveCollision: (plan) => attemptedSignatures.has(plan.signature),
                    request: (plan, family) => {
                      if (scenicRouteRequestsAttempted >= MAX_SCENIC_ROUTE_ATTEMPTS)
                        return {
                          candidateId: "duration-refinement-capacity-exhausted",
                          response: Promise.reject(new Error("ATTEMPT_CAPACITY_EXHAUSTED")),
                        };
                      const requested = requestCandidate(plan, "duration-refinement", family);
                      if (requested.family)
                        constructionFamilies.set(requested.candidateId, requested.family);
                      return {
                        candidateId: requested.candidateId,
                        response: requested.request,
                        expectedAnchors: requested.expectedAnchors,
                      };
                    },
                    onProviderRejected: ({ plan, candidateId, refinement }) => {
                      recordCandidateResult(
                        plan,
                        { status: "rejected", reason: null },
                        refinement.intendedTargetMinutes,
                        refinement.adaptiveTargetMinutes,
                        candidateId,
                        refinement,
                        undefined,
                        [
                          routeInput.origin,
                          ...corridorWaypointsWithRequiredStops(
                            requiredCoordinates,
                            planningAnchors,
                            plan,
                          ),
                          routeInput.destination,
                        ],
                      );
                    },
                    onRecorded: ({ plan, result, candidateId, refinement, recording }) => {
                      recordCandidateResult(
                        plan,
                        result,
                        refinement.intendedTargetMinutes,
                        refinement.adaptiveTargetMinutes,
                        candidateId,
                        refinement,
                        recording ?? undefined,
                        [
                          routeInput.origin,
                          ...corridorWaypointsWithRequiredStops(
                            requiredCoordinates,
                            planningAnchors,
                            plan,
                          ),
                          routeInput.destination,
                        ],
                      );
                    },
                  });
                  durationRefinementResult = orchestration.controller;
                }
                const qualityEquivalent = exploredCandidateQuality.filter(
                  (candidate) => bestExploredScore - candidate.score <= 3,
                );
                const bestQualityEquivalentUtilisation = Math.max(
                  0,
                  ...qualityEquivalent.map((candidate) => candidate.utilisation),
                );
                const bestHighUtilisationScore = Math.max(
                  -1,
                  ...exploredCandidateQuality
                    .filter((candidate) => isTargetBudgetCandidate(candidate.utilisation))
                    .map((candidate) => candidate.score),
                );
                const stagesRemaining = stages.length - stageIndex - 1;
                if (stagesRemaining === 0) explorationExhausted = true;
                if (
                  explorationShouldStop({
                    bestScore: bestExploredScore,
                    bestHighUtilisationScore,
                    bestQualityEquivalentUtilisation,
                    requestedExtraMinutes: data.extra_minutes,
                    stagesExplored: stageIndex + 1,
                    stagesRemaining,
                  })
                )
                  break;
              }
              if (evidencePlaces.length === 0) rejectionReasons.add("NO_PLACES_FOUND");
              else if (scenicRouteRequestsAttempted === 0)
                rejectionReasons.add(
                  waypointPlansRejectedBacktracking > 0
                    ? "EXCESSIVE_BACKTRACKING"
                    : "NO_VALID_WAYPOINTS",
                );
            }
          } catch {
            stableErrorCode = "SCENIK_CANDIDATE_UNAVAILABLE_FALLBACK";
          }
        }

        const { haversineDistanceMeters } = await import("./scenic-waypoint");
        const { evidenceSupportCounts } = await import("./scenic-score");
        const { scoreAndSelectRouteCandidateCollection } =
          await import("./route-duration-refinement");
        const finalCandidatePass = scoreAndSelectRouteCandidateCollection({
          candidates: rawCandidates,
          evidencePlaces,
          start,
          end,
          mood: moodIn,
          theme: themeIn,
          requestedExtraMinutes: data.extra_minutes,
          requiredStopCount: waypoints.length,
        });
        const { scoredCandidates, selection } = finalCandidatePass;
        if (finalCandidatePass.failedCandidateIds.length > 0)
          stableErrorCode = "ALTERNATIVE_SCORING_FAILED_FALLBACK";
        const candidateDiagnostics = candidateSelectionDiagnostics(
          scoredCandidates,
          selection,
          data.extra_minutes,
        ).map((candidate) => {
          const generation = rawCandidates[candidate.originalIndex];
          const scored = scoredCandidates.find(
            (scoredCandidate) => scoredCandidate.candidateId === candidate.candidateId,
          );
          return {
            ...candidate,
            candidateId: generation?.candidateId ?? candidate.candidateId,
            explorationStage: generation?.explorationStage ?? null,
            intendedAddedMinutes: generation?.intendedAddedMinutes ?? null,
            constructionTargetMinutes: generation?.constructionTargetMinutes ?? null,
            durationTargetClassification: generation?.durationTargetClassification ?? null,
            requiredStopOrderPreserved: true,
            scoreResult: scored?.scoreResult,
            evidenceAssociation: scored?.evidenceAssociation,
          };
        });
        const directions = selection.selected.directions;
        const score = selection.selected.scoreResult;
        if (!alternativesUnavailableReason && selection.candidates.length <= 1) {
          alternativesUnavailableReason = "NO_DISTINCT_ALTERNATIVES_RETURNED";
        }
        const timeBudgetApplied = selection.candidates.length > 1;
        const selectedRawCandidate = rawCandidates[selection.selected.originalIndex];
        const selectedScoredCandidate = scoredCandidates.find(
          (candidate) => candidate.candidateId === selection.selected.candidateId,
        );
        const selectedWaypointReason = selection.selected.selectedWaypointReason ?? null;
        const selectedWinner = selection.selected.source ?? "fastest";
        const { routeIdentityFingerprint } = await import("./route-presentation");
        const selectedRouteIdentityFingerprint = routeIdentityFingerprint(
          directions,
          directions.durationSeconds,
        );
        if (scenicRoutesAccepted > 0 && selectedWinner !== "scenik") {
          rejectionReasons.add("SCORE_NOT_BETTER");
        }
        const waypointsForCandidate = (candidate: (typeof rawCandidates)[number] | undefined) => {
          const candidateWaypoints = [...waypoints];
          if (!candidate?.scenicWaypoints.length) return candidateWaypoints;
          const anchors = [routeInput.origin, ...routeInput.waypoints, routeInput.destination];
          [...candidate.scenicWaypoints]
            .sort(
              (a, b) =>
                a.insertionIndex - b.insertionIndex ||
                haversineDistanceMeters(anchors[a.insertionIndex], a) -
                  haversineDistanceMeters(anchors[b.insertionIndex], b),
            )
            .flatMap((waypoint) => {
              const name = verifiedMeaningfulPlaceName(waypoint);
              return name ? [{ waypoint, name }] : [];
            })
            .forEach(({ waypoint, name }, offset) => {
              candidateWaypoints.splice(waypoint.insertionIndex + offset, 0, {
                name,
                lat: waypoint.lat,
                lng: waypoint.lng,
                description: verifiedDiscoveryDescription(waypoint.categoryName ?? waypoint.reason),
              });
            });
          return candidateWaypoints;
        };
        const selectedWaypoints = waypointsForCandidate(selectedRawCandidate);
        const { buildDiscoveryNarration, buildJourneyTimeline, selectJourneyDiscoveries } =
          await import("./journey-timeline");
        const { safeAssociateEvidenceWithRoute } = await import("./route-evidence-association");
        const selectedAssociation =
          selectedScoredCandidate?.evidenceAssociation ??
          safeAssociateEvidenceWithRoute({
            encodedPolyline: directions.encodedPolyline,
            places: evidencePlaces,
            proximityMeters: 750,
          });
        const journeyTimeline = selectJourneyDiscoveries(
          buildJourneyTimeline(selectedAssociation.matchedGeometryPlaces, directions.steps, {
            moods: moodIn,
            themes: themeIn,
          }),
          directions.durationSeconds,
          directions.distanceMeters,
          { moods: moodIn, themes: themeIn },
        );
        const { journeyTitle } = await import("./journey-naming");
        const selectedJourneyTitle = journeyTitle({
          evidence: selection.selected.evidence,
          themes: themeIn,
          discoveries: journeyTimeline,
        });
        const narrationEvents = buildDiscoveryNarration(
          journeyTimeline,
          directions.durationSeconds,
        );
        const { selectRouteUpgradeCandidate } = await import("./route-upgrade");
        const upgradeSelection = selectRouteUpgradeCandidate({
          selected: selection.selected,
          candidates: selection.candidates,
          fastestDurationSeconds: selection.fastestDurationSeconds,
          requestedExtraMinutes: data.extra_minutes,
        });
        const upgradeRawCandidate = upgradeSelection
          ? rawCandidates[upgradeSelection.candidate.originalIndex]
          : undefined;
        const upgradeScoredCandidate = upgradeSelection
          ? scoredCandidates.find(
              (candidate) => candidate.originalIndex === upgradeSelection.candidate.originalIndex,
            )
          : undefined;
        const upgradeJourneyTimeline = upgradeSelection
          ? selectJourneyDiscoveries(
              buildJourneyTimeline(
                upgradeScoredCandidate?.evidenceAssociation.matchedGeometryPlaces ?? [],
                upgradeSelection.candidate.directions.steps,
                { moods: moodIn, themes: themeIn },
              ),
              upgradeSelection.candidate.directions.durationSeconds,
              upgradeSelection.candidate.directions.distanceMeters,
              { moods: moodIn, themes: themeIn },
            )
          : [];
        const upgradeJourneyTitle = upgradeSelection
          ? journeyTitle({
              evidence: upgradeSelection.candidate.evidence,
              themes: themeIn,
              discoveries: upgradeJourneyTimeline,
            })
          : undefined;
        const scores = selection.candidates.map((candidate) => candidate.score);
        const fastestScore = scoredCandidates.find(
          (candidate) => candidate.originalIndex === 0,
        )?.score;
        const maximumAllowedDurationSeconds = durationCeiling(
          selection.fastestDurationSeconds,
          data.extra_minutes,
        );
        const mainRejectionReason = rejectionReasons.values().next().value ?? null;
        const { didCompleteFullAllowanceSearch, explorationStages: diagnosticExplorationStages } =
          await import("./corridor-exploration");
        const explorationTargets = diagnosticExplorationStages(data.extra_minutes);
        const finalSelectionReason =
          candidateDiagnostics.find((candidate) => candidate.selected)?.selectionReason ?? null;
        const intendedScenicRouteRequests = explorationTargets.at(-1)?.cumulativeRouteCap ?? 0;
        const longerEligibleCandidateEvaluated = candidateDiagnostics.some(
          (candidate) =>
            candidate.eligible &&
            !candidate.duplicate &&
            candidate.durationSeconds > selection.selected.directions.durationSeconds,
        );
        const fullAllowanceSearchCompleted = didCompleteFullAllowanceSearch({
          explorationExhausted,
          candidateRequestFailed: rejectionReasons.has("ROUTE_REQUEST_FAILED"),
          scenicRouteRequestsAttempted,
          intendedScenicRouteRequests,
          longerEligibleCandidateEvaluated,
        });
        try {
          const {
            buildRouteGenerationDiagnostic,
            candidateByRequestLocalId,
            internalRouteDiagnosticResponse,
            serializeRouteGenerationDiagnostic,
          } = await import("./route-generation-diagnostics");
          const candidateEligibility: Parameters<
            typeof buildRouteGenerationDiagnostic
          >[0]["candidateEligibility"] = generatedCandidateOutcomes.map((outcome) => {
            const diagnostic = candidateByRequestLocalId(candidateDiagnostics, outcome.candidateId);
            const construction = constructionMetadataByCandidateId.get(outcome.candidateId);
            const breakdown = diagnostic?.scoreResult?.breakdown;
            const evidenceSupport = diagnostic?.evidence
              ? evidenceSupportCounts({
                  evidence: diagnostic.evidence,
                  moods: moodIn
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                  themes: themeIn
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              : null;
            return {
              candidateId: outcome.candidateId,
              candidateSource: outcome.source,
              explorationStage: outcome.explorationStage,
              intendedTargetMinutes: outcome.intendedAddedMinutes,
              adaptiveTargetMinutes:
                outcome.refinementAttemptNumber != null ||
                (outcome.intendedAddedMinutes != null &&
                  outcome.constructionTargetMinutes !== outcome.intendedAddedMinutes)
                  ? outcome.constructionTargetMinutes
                  : null,
              actualAddedMinutes: outcome.addedMinutes,
              outcomeClassification: outcome.durationTargetClassification ?? outcome.outcome,
              duplicateEligible: outcome.duplicate == null ? null : !outcome.duplicate,
              budgetEligible:
                outcome.outcome === "ROUTE_REQUEST_FAILED"
                  ? null
                  : outcome.outcome !== "OVER_TIME_BUDGET",
              qualityEligible:
                diagnostic == null
                  ? null
                  : diagnostic.score >= 60 &&
                    diagnostic.rejectionReason !== "EVIDENCE_FREE_ROUTE" &&
                    diagnostic.rejectionReason !== "BELOW_ABSOLUTE_QUALITY_FLOOR" &&
                    diagnostic.rejectionReason !== "BELOW_WEAK_QUALITY_GUARDRAIL",
              scenicScore: diagnostic?.score ?? null,
              scoreBreakdown: breakdown
                ? {
                    naturalBeauty: breakdown.natural_beauty,
                    pointsOfInterest: breakdown.points_of_interest,
                    moodMatch: breakdown.mood_match,
                    roadCharacter: breakdown.road_character,
                    themeMatch: breakdown.theme_match,
                    diversity: breakdown.diversity,
                  }
                : null,
              allowanceUtilisation: outcome.allowanceUtilisation,
              evidenceEligible: diagnostic?.evidenceAssociation?.status === "ANALYSED",
              targetBandEligible:
                diagnostic != null &&
                diagnostic.eligible &&
                diagnostic.score >= 60 &&
                diagnostic.allowanceUtilisation >= 0.75,
              selected: diagnostic?.selected ?? false,
              rejectionReason: diagnostic?.rejectionReason ?? outcome.outcome,
              finalSelectionReason: diagnostic?.selected ? finalSelectionReason : null,
              geometryDistanceMeters:
                diagnostic?.evidenceAssociation?.geometryDistanceMeters ?? null,
              evidenceSampleCount: diagnostic?.evidenceAssociation?.sampleCount ?? null,
              evidenceConsidered: diagnostic?.evidenceAssociation?.evidenceConsidered ?? null,
              evidenceMatchedToGeometry:
                diagnostic?.evidenceAssociation?.evidenceMatchedToGeometry ?? null,
              evidenceMatchedThroughWaypoints:
                diagnostic?.evidenceAssociation?.evidenceMatchedThroughWaypoints ?? null,
              naturalEvidenceCount: evidenceSupport?.natural ?? null,
              themeEvidenceCount: evidenceSupport?.theme ?? null,
              moodEvidenceCount: evidenceSupport?.mood ?? null,
              evidenceAssociationStatus: diagnostic?.evidenceAssociation?.status ?? null,
              routeShapeEligible: outcome.routeShapeEligible,
              routeShapeRejectionReason: outcome.routeShapeRejectionReason,
              reverseOverlapDistanceMeters: outcome.reverseOverlapDistanceMeters,
              reverseOverlapRatio: outcome.reverseOverlapRatio,
              waypointSpurDetected: outcome.waypointSpurDetected,
              affectedWaypointIndex: outcome.affectedWaypointIndex,
              waypointAssociationStatus: outcome.waypointAssociationStatus,
              routeShapeAnalysisStatus: outcome.routeShapeAnalysisStatus,
              requestedWaypointForm: construction?.requestedRole?.waypointForm ?? null,
              effectiveWaypointForm: construction?.effectiveConstruction?.waypointForm ?? null,
              effectiveProgress: construction?.effectiveConstruction?.progress ?? null,
              effectiveOrientation: construction?.effectiveConstruction?.orientation ?? null,
              effectiveWaypointCount: construction?.effectiveWaypointCount ?? null,
              refinementParentCandidateId: outcome.refinementParentCandidateId,
              refinementUpperCandidateId: outcome.refinementUpperCandidateId,
              refinementAttemptNumber: outcome.refinementAttemptNumber,
              refinementStrategy: outcome.refinementStrategy,
              refinementBracketLowerMinutes: outcome.refinementBracketLowerMinutes,
              refinementBracketUpperMinutes: outcome.refinementBracketUpperMinutes,
              refinementTargetBandReached:
                outcome.refinementAttemptNumber != null &&
                outcome.durationTargetClassification === "TARGET_BAND" &&
                outcome.outcome === "ELIGIBLE",
              refinementStopReason:
                outcome.candidateId ===
                durationRefinementResult?.executions.at(-1)?.observation?.candidateId
                  ? durationRefinementResult.stopReason
                  : null,
            };
          });
          for (const attempt of longAttemptExecutions) {
            const represented = candidateEligibility.some(
              (candidate) =>
                candidate.intendedTargetMinutes === attempt.intendedTargetMinutes &&
                (candidate.adaptiveTargetMinutes ?? candidate.intendedTargetMinutes) ===
                  attempt.adaptiveTargetMinutes,
            );
            if (!represented) {
              candidateEligibility.push({
                candidateId: `long-target-${nextCandidateOrdinal++}`,
                candidateSource: "scenik",
                explorationStage: explorationTargets.length - 1,
                intendedTargetMinutes: attempt.intendedTargetMinutes,
                adaptiveTargetMinutes: attempt.adaptiveTargetMinutes,
                actualAddedMinutes: attempt.actualAddedMinutes,
                outcomeClassification: attempt.status,
                duplicateEligible: null,
                budgetEligible: null,
                qualityEligible: null,
                scenicScore: null,
                scoreBreakdown: null,
                allowanceUtilisation: null,
                evidenceEligible: null,
                targetBandEligible: null,
                selected: false,
                rejectionReason: attempt.status,
                finalSelectionReason: null,
                geometryDistanceMeters: null,
                evidenceSampleCount: null,
                evidenceConsidered: null,
                evidenceMatchedToGeometry: null,
                evidenceMatchedThroughWaypoints: null,
                naturalEvidenceCount: null,
                themeEvidenceCount: null,
                moodEvidenceCount: null,
                evidenceAssociationStatus: null,
                routeShapeEligible: null,
                routeShapeRejectionReason: null,
                reverseOverlapDistanceMeters: null,
                reverseOverlapRatio: null,
                waypointSpurDetected: null,
                affectedWaypointIndex: null,
                waypointAssociationStatus: null,
                routeShapeAnalysisStatus: null,
              });
            }
          }
          const diagnosticInput = {
            correlationId: requestCorrelationId,
            requestedExtraMinutes: data.extra_minutes,
            baselineDurationSeconds: selection.fastestDurationSeconds,
            plannedExplorationStages: explorationTargets,
            attemptsPlanned: Math.max(intendedScenicRouteRequests, scenicRouteRequestsAttempted),
            attemptsCompleted: scenicRouteRequestsCompleted,
            processedTargetMinutes: processedOrdinaryAttempts.map(
              (attempt) => attempt.targetMinutes,
            ),
            intendedTargetMinutes: processedOrdinaryAttempts.map(
              (attempt) => attempt.targetMinutes,
            ),
            adaptiveTargetMinutes: generatedCandidateOutcomes
              .filter(
                (outcome) =>
                  outcome.source === "scenik" &&
                  outcome.constructionTargetMinutes != null &&
                  (outcome.refinementAttemptNumber != null ||
                    outcome.constructionTargetMinutes !== outcome.intendedAddedMinutes),
              )
              .map((outcome) => outcome.constructionTargetMinutes as number),
            actualAddedMinutesReturned:
              Math.round((selection.measuredExtraTimeSeconds / 60) * 10) / 10,
            outcomeClassification: selection.timeTargetOutcome,
            candidateEligibility,
            candidateScenicScores: candidateDiagnostics.map((candidate) => candidate.score),
            finalSelectionReason,
            totalServerProcessingDurationMs: Date.now() - requestStartedAt,
            durationRefinement: durationRefinementResult
              ? {
                  attempted: durationRefinementResult.attempted,
                  reachedTargetBand: durationRefinementResult.reachedTargetBand,
                  attemptsUsed: durationRefinementResult.executions.length,
                  safeConstructionsProduced:
                    durationRefinementResult.stateCounts.safeConstructionsProduced,
                  providerRequestsStarted:
                    durationRefinementResult.stateCounts.providerRequestsStarted,
                  providerResponsesReturned:
                    durationRefinementResult.stateCounts.providerResponsesReturned,
                  providerRequestsFailed:
                    durationRefinementResult.stateCounts.providerRequestsFailed,
                  providerResponsesEvaluated:
                    durationRefinementResult.stateCounts.providerResponsesEvaluated,
                  stopReason: durationRefinementResult.stopReason,
                }
              : null,
            preferencePresence: { mood: moodIn.length > 0, theme: themeIn.length > 0 },
            attemptRoles: explorationTargets.flatMap((stage) =>
              stage.attemptRoles.map((role) => ({
                target: role.targetExtraMinutes,
                side: role.side,
                progress: role.progress,
                waypointForm: role.waypointForm,
                evidencePreference: role.evidencePreference,
              })),
            ),
            attemptsStarted: scenicRouteRequestsAttempted,
            placesSummary: {
              succeeded: placesRequestsSucceeded,
              failed: placesRequestsFailed,
              returned: evidenceRecordsReturned,
              accepted: deduplicatedPlaceCount,
            },
            evidenceSummary: {
              accepted: deduplicatedPlaceCount,
              distinctSets: evidenceSetSizes.size,
            },
            constructionSummary: {
              ...ordinaryPlanningSummary,
            },
            providerRouteSummary: {
              succeeded: scenicRoutesReturned,
              failed: rejectionReasons.has("ROUTE_REQUEST_FAILED")
                ? Math.max(0, scenicRouteRequestsCompleted - scenicRoutesReturned)
                : 0,
            },
            candidateSummary: {
              returned: scenicRoutesReturned,
              recorded: rawCandidates.filter((candidate) => candidate.source === "scenik").length,
              refined:
                durationRefinementResult?.executions.filter(
                  (execution) => execution.observation != null,
                ).length ?? 0,
            },
          };
          const safeDiagnostic = buildRouteGenerationDiagnostic(diagnosticInput);
          internalRouteDiagnosticFields = internalRouteDiagnosticResponse(
            exposeInternalDiagnostics,
            safeDiagnostic,
          );
          console.info(serializeRouteGenerationDiagnostic(diagnosticInput));
        } catch {
          // Diagnostics must never affect route generation.
        }

        const routeUpgradeCandidate = upgradeSelection
          ? {
              available: true as const,
              additionalMinutesBeyondSelectedRoute: Math.max(
                1,
                Math.ceil(
                  (upgradeSelection.candidate.directions.durationSeconds -
                    directions.durationSeconds) /
                    60,
                ),
              ),
              additionalMinutesBeyondUserAllowance: Math.max(
                1,
                Math.ceil(
                  (upgradeSelection.candidate.directions.durationSeconds -
                    (selection.fastestDurationSeconds + data.extra_minutes * 60)) /
                    60,
                ),
              ),
              currentScenicScore: score.total,
              upgradeScenicScore: upgradeSelection.candidate.score,
              scenicScoreImprovement: upgradeSelection.candidate.score - score.total,
              verifiedReasons: upgradeSelection.reasons,
              payload: {
                title: upgradeJourneyTitle ?? "The Scenic Journey",
                narrative: `This retained route scores ${upgradeSelection.candidate.score - score.total} points higher using verified evidence and measured route characteristics.`,
                scenic_score: upgradeSelection.candidate.score,
                score_breakdown: upgradeSelection.candidate.scoreResult.breakdown,
                evidenceSummary: {
                  counts: upgradeSelection.candidate.evidence,
                  explanations: upgradeSelection.candidate.scoreResult.breakdown.explanations,
                },
                badges: upgradeSelection.candidate.scoreResult.badges,
                worth_extra_time: upgradeSelection.candidate.scoreResult.worthExtraTime,
                waypoints: waypointsForCandidate(upgradeRawCandidate),
                selectedRouteDurationSeconds: upgradeSelection.candidate.directions.durationSeconds,
                measuredExtraTimeSeconds: Math.max(
                  0,
                  upgradeSelection.candidate.directions.durationSeconds -
                    selection.fastestDurationSeconds,
                ),
                selectedCandidateIndex: upgradeSelection.candidate.originalIndex,
                selectedWinner: upgradeRawCandidate?.source ?? "scenik",
                selectedWaypointReason: upgradeRawCandidate?.selectedWaypointReason ?? null,
                highlights: upgradeJourneyTimeline.map(
                  (highlight) => `${highlight.name} · ${highlight.category}`,
                ),
                journeyTimeline: upgradeJourneyTimeline,
                narrationEvents: buildDiscoveryNarration(
                  upgradeJourneyTimeline,
                  upgradeSelection.candidate.directions.durationSeconds,
                ),
                directions: upgradeSelection.candidate.directions,
              },
            }
          : undefined;

        const completedRoute = {
          title: selectedJourneyTitle,
          narrative: routeResultNarrative({
            selectedWinner,
            selectedWaypointReason,
            requestedExtraMinutes: data.extra_minutes,
            measuredExtraTimeSeconds: selection.measuredExtraTimeSeconds,
          }),
          scenic_score: score.total,
          score_breakdown: score.breakdown,
          evidenceSummary: {
            counts: selection.selected.evidence,
            explanations: score.breakdown.explanations,
          },
          badges: score.badges,
          worth_extra_time: score.worthExtraTime,
          scoring_version: "v3-category-10" as const,
          scoringDiagnostics: exposeInternalDiagnostics
            ? {
                scoringVersion: "v3-category-10" as const,
                requestedExtraTimeMinutes: data.extra_minutes,
                fastestDurationSeconds: selection.fastestDurationSeconds,
                fastestDurationMinutes: Math.round(selection.fastestDurationSeconds / 60),
                selectedDurationMinutes: Math.round(directions.durationSeconds / 60),
                mapDisplayedDurationMinutes: Math.round(directions.durationSeconds / 60),
                routeIdentityFingerprint: selectedRouteIdentityFingerprint,
                maximumAllowedDurationSeconds,
                corridorSampleCount: corridorSamplesUsed,
                placesSearchCount: placesCallCount,
                deduplicatedPlaceCount,
                waypointPlansConsidered,
                waypointPlansRejectedDuplicate,
                waypointPlansRejectedBacktracking,
                scenicRouteRequestsAttempted,
                scenicRoutesReturned,
                scenicRoutesRejectedOverBudget,
                scenicRoutesAccepted,
                googleAlternativeCount: Math.max(0, distinctGoogleDirections.length - 1),
                candidateCount: selection.candidates.length,
                eligibleCandidateCount: selection.eligible.length,
                fastestScore,
                candidateScoreMin: scores.length ? Math.min(...scores) : null,
                candidateScoreMax: scores.length ? Math.max(...scores) : null,
                selectedWinnerType: selectedWinner,
                selectedScore: selection.selected.score,
                selectedMeasuredExtraMinutes: Math.round(selection.measuredExtraTimeSeconds / 60),
                mainRejectionReason,
                rejectionReasons: [...rejectionReasons],
                explorationTargets,
                generatedCandidateOutcomes,
                candidateDiagnostics,
                finalSelectionReason,
                timeTargetOutcome: selection.timeTargetOutcome,
                fullAllowanceSearchCompleted,
                geocodingCallCount,
                routesCallCount,
                placesCallCount,
              }
            : undefined,
          highlights: journeyTimeline.map(
            (highlight) => `${highlight.name} · ${highlight.category}`,
          ),
          journeyTimeline,
          narrationEvents,
          waypoints: selectedWaypoints,
          start: { address: start.formatted, lat: start.lat, lng: start.lng },
          end: { address: end.formatted, lat: end.lat, lng: end.lng },
          mood: moodIn || "Open",
          theme: themeIn || (requestJourneyMode === "fastest" ? "Direct route" : "Open"),
          extra_minutes: data.extra_minutes,
          fastestRouteDurationSeconds: selection.fastestDurationSeconds,
          selectedRouteDurationSeconds: directions.durationSeconds,
          measuredExtraTimeSeconds: selection.measuredExtraTimeSeconds,
          requestedExtraTimeBudgetSeconds: selection.requestedExtraTimeBudgetSeconds,
          candidateCount: selection.candidates.length,
          eligibleCandidateCount: selection.eligible.length,
          selectedCandidateIndex: selection.selected.originalIndex,
          selectedWinner,
          selectedWaypointReason,
          scenikCandidateAdded,
          scenicCandidateCount,
          googleCandidateCount: distinctGoogleDirections.length,
          timeBudgetApplied,
          explorationExhausted,
          fullAllowanceSearchCompleted,
          timeTargetOutcome: selection.timeTargetOutcome,
          ...internalRouteDiagnosticFields,
          alternativesUnavailableReason,
          routeUpgradeCandidate,
          directions,
        };
        return completedRoute;
      },
    });
  });

const SaveInput = z.object({
  title: z.string(),
  mood: z.string(),
  theme: z.string(),
  extra_minutes: z.number().int(),
  start_address: z.string(),
  end_address: z.string(),
  start_lat: z.number(),
  start_lng: z.number(),
  end_lat: z.number(),
  end_lng: z.number(),
  waypoints: z.array(
    z.object({
      name: z.string(),
      lat: z.number(),
      lng: z.number(),
      description: z.string(),
    }),
  ),
  scenic_score: z.number().int(),
  narrative: z.string(),
  highlights: z.array(z.string()),
});

export const saveRoute = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SaveInput.parse(input))
  .handler(async ({ data, context }) => {
    const { error, data: row } = await context.supabase
      .from("routes")
      .insert({ ...data, user_id: context.userId })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const listMyRoutes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("routes")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const deleteRoute = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error: fetchErr } = await context.supabase
      .from("routes")
      .select("is_public")
      .eq("id", data.id)
      .maybeSingle();
    if (fetchErr) throw new Error(fetchErr.message);
    if (row?.is_public) {
      throw new Error("This route is shared publicly. Make it private before deleting.");
    }
    const { error } = await context.supabase.from("routes").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const RecomputeInput = z.object({
  origin: z.object({ lat: z.number(), lng: z.number() }),
  destination: z.object({ lat: z.number(), lng: z.number() }),
  waypoints: z.array(z.object({ lat: z.number(), lng: z.number() })).default([]),
  alternatives: z.boolean().optional(),
});

export const recomputeDirections = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => RecomputeInput.parse(input))
  .handler(async ({ data }) => {
    const { computeDirections } = await import("./google-maps.server");
    return await computeDirections({
      origin: data.origin,
      destination: data.destination,
      waypoints: data.waypoints,
      alternatives: data.alternatives,
    });
  });

export const fetchSpeedLimit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ lat: z.number(), lng: z.number() }).parse(input))
  .handler(async ({ data }) => {
    const { getSpeedLimitKmh } = await import("./ai-gateway.server");
    return { kmh: await getSpeedLimitKmh(data) };
  });

export const reverseGeocode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ lat: z.number(), lng: z.number() }).parse(input))
  .handler(async ({ data }) => {
    const { reverseGeocodeLatLng } = await import("./google-maps.server");
    const r = await reverseGeocodeLatLng(data.lat, data.lng);
    return { address: r.formatted, lat: r.lat, lng: r.lng };
  });

export const waypointFacts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        name: z.string().min(1),
        lat: z.number(),
        lng: z.number(),
        theme: z.string().optional(),
        language: z.string().optional(),
      })
      .parse(input),
  )
  .handler(async () => {
    return { facts: "Scenic commentary is unavailable during the Phase A migration." };
  });

export const recommendThemesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        start: z.string().min(2),
        end: z.string().min(2),
        available: z.array(z.string()).min(1),
      })
      .parse(input),
  )
  .handler(async () => {
    return { themes: [] as string[] };
  });
