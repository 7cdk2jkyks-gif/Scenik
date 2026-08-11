import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { verifiedDiscoveryDescription } from "./journey-timeline";

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
    let explorationExhausted = false;
    let longAttemptExecutions: import("./route-generation-diagnostics").LongAttemptExecution[] = [];
    const rejectionReasons = new Set<string>();

    // Enforce free-tier cap (3 generations per calendar month)
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [{ count: usedThisMonth }, { data: subRows }] = await Promise.all([
      context.supabase
        .from("route_generations")
        .select("*", { count: "exact", head: true })
        .eq("user_id", context.userId)
        .gte("created_at", monthStart.toISOString()),
      context.supabase
        .from("subscriptions")
        .select("status,current_period_end,environment")
        .eq("user_id", context.userId)
        .order("created_at", { ascending: false })
        .limit(1),
    ]);
    const sub = subRows?.[0];
    const nowMs = Date.now();
    const subEndMs = sub?.current_period_end ? new Date(sub.current_period_end).getTime() : null;
    const isPremium =
      !!sub &&
      ((["active", "trialing", "past_due"].includes(sub.status) &&
        (!subEndMs || subEndMs > nowMs)) ||
        (sub.status === "canceled" && !!subEndMs && subEndMs > nowMs));
    const FREE_LIMIT = 3;
    if (!internalTester && !isPremium && (usedThisMonth ?? 0) >= FREE_LIMIT) {
      throw new Error(`FREE_LIMIT_REACHED:${FREE_LIMIT}`);
    }
    if (!isPremium && data.stops.length > 0) {
      throw new Error("PREMIUM_REQUIRED:multi_stop");
    }

    const [start, end, ...stops] = await Promise.all([
      geocodeAddress(data.start_address),
      geocodeAddress(data.end_address),
      ...data.stops.map((s) => geocodeAddress(s)),
    ]);

    const moodIn = data.mood.trim();
    const themeIn = data.theme.trim();
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
        const alternativeResponse = await computeDirections({ ...routeInput, alternatives: true });
        googleDirections = [baseline, ...(alternativeResponse.candidates ?? [alternativeResponse])];
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
    const diagnosticDurationCeiling = durationCeiling(baseline.durationSeconds, data.extra_minutes);
    const generatedCandidateOutcomes: Array<{
      source: "fastest" | "google" | "scenik";
      intendedAddedMinutes: number | null;
      constructionTargetMinutes: number | null;
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
      outcome: "ELIGIBLE" | "OVER_TIME_BUDGET" | "DUPLICATE_ROUTE" | "ROUTE_REQUEST_FAILED";
    }> = googleDirections.map((directions, index, all) => {
      const duplicate = all
        .slice(0, index)
        .some((prior) => routesAreNearIdentical(prior, directions));
      const withinBudget = directions.durationSeconds <= diagnosticDurationCeiling;
      return {
        source: index === 0 ? "fastest" : "google",
        intendedAddedMinutes: null,
        constructionTargetMinutes: null,
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
        outcome: duplicate ? "DUPLICATE_ROUTE" : withinBudget ? "ELIGIBLE" : "OVER_TIME_BUDGET",
      };
    });
    const distinctGoogleDirections = googleDirections.filter(
      (directions, index, all) =>
        !all.slice(0, index).some((prior) => routesAreNearIdentical(prior, directions)),
    );
    const rawCandidates: Array<{
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
        categoryName?: string;
        rating?: number;
        userRatingCount?: number;
        photoUrl?: string;
      }>;
    }> = distinctGoogleDirections.map((directions, index) => ({
      directions,
      source: index === 0 ? "fastest" : "google",
      selectedWaypointReason: null,
      intendedAddedMinutes: null,
      constructionTargetMinutes: null,
      durationTargetClassification: null,
      scenicWaypoints: [],
    }));

    let scenikCandidateAdded = false;
    let scenicCandidateCount = 0;
    let evidencePlaces: Array<{
      id: string;
      lat: number;
      lng: number;
      primaryType: string;
      types: string[];
      displayName?: string;
      categoryName?: string;
      rating?: number;
      userRatingCount?: number;
      photoUrl?: string;
    }> = [];
    if (data.extra_minutes > 0) {
      try {
        const {
          candidateFitsTimeBudget,
          corridorSampleCount,
          evidenceForRoute: evidenceForExploration,
          routeCorridorSamples,
          selectedPlaceTypes,
        } = await import("./scenic-waypoint");
        const {
          adaptiveDurationTargetMinutes,
          budgetUtilisation,
          buildCorridorPlans,
          classifyDurationTargetResult,
          corridorWaypointsWithRequiredStops,
          durationAwareCorridorSamples,
          explorationShouldStop,
          explorationStages,
          isTargetBudgetCandidate,
        } = await import("./corridor-exploration");
        const { runSequentialLongAttempts } = await import("./route-generation-diagnostics");
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
          const budgetSeconds = data.extra_minutes * 60;
          const averageMetersPerSecond = baseline.distanceMeters / baseline.durationSeconds;
          const requiredCoordinates = routeInput.waypoints.map(({ lat, lng }) => ({ lat, lng }));
          const anchors = [routeInput.origin, ...requiredCoordinates, routeInput.destination];
          const uniquePlaces = new Map<string, (typeof evidencePlaces)[number]>();
          const attemptedSignatures = new Set<string>();
          const attemptedKinds = new Set<import("./corridor-exploration").ScenicCorridorKind>();
          const stages = explorationStages(data.extra_minutes);
          let bestExploredScore = 0;
          const exploredCandidateQuality: Array<{ score: number; utilisation: number }> = [];
          for (const [stageIndex, stage] of stages.entries()) {
            const baselineSamples = routeCorridorSamples(
              routeInput.origin,
              routeInput.destination,
              baseline.steps,
              Math.min(corridorSampleCount(baseline.distanceMeters), stage.sampleCap),
            );
            const durationAwareSamples =
              stage.targetExtraMinutes.length > 1
                ? durationAwareCorridorSamples({
                    samples: baselineSamples,
                    baselineDistanceMeters: baseline.distanceMeters,
                    baselineDurationSeconds: baseline.durationSeconds,
                    targetExtraMinutes: stage.targetExtraMinutes,
                  })
                : [];
            const samples = durationAwareSamples.length
              ? durationAwareSamples.map((sample) => sample.center)
              : baselineSamples;
            corridorSamplesUsed += samples.length;
            placesCallCount += samples.length;
            const placeResults = await Promise.allSettled(
              samples.map((center) =>
                searchNearbyScenicPlaces({
                  center,
                  radiusMeters: stage.radiusMeters,
                  includedTypes,
                }),
              ),
            );
            for (const result of placeResults) {
              if (result.status !== "fulfilled") continue;
              for (const place of result.value) {
                if (!uniquePlaces.has(place.id) && uniquePlaces.size < stage.cumulativePlaceCap)
                  uniquePlaces.set(place.id, place);
              }
            }
            evidencePlaces = [...uniquePlaces.values()];
            deduplicatedPlaceCount = evidencePlaces.length;
            const stageBaselineScore = scoreExploredRoute({
              start,
              end,
              mood: moodIn,
              theme: themeIn,
              extraMinutes: data.extra_minutes,
              stopCount: waypoints.length,
              directions: baseline,
              evidence: evidenceForExploration(
                evidencePlaces,
                routeCorridorSamples(start, end, baseline.steps, 7),
                750,
              ),
              fastestDurationSeconds: baseline.durationSeconds,
            }).total;
            bestExploredScore = Math.max(bestExploredScore, stageBaselineScore);
            exploredCandidateQuality.push({ score: stageBaselineScore, utilisation: 0 });
            const remainingRouteCalls = Math.max(
              0,
              stage.cumulativeRouteCap - scenicRouteRequestsAttempted,
            );
            const planningAnchors =
              stage.targetExtraMinutes.length > 1 && requiredCoordinates.length === 0
                ? [routeInput.origin, ...baselineSamples, routeInput.destination]
                : anchors;
            const updatePlanningDiagnostics = (planning: {
              considered: number;
              rejectedDuplicate: number;
              rejectedBacktracking: number;
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
            ) => {
              attemptedSignatures.add(plan.signature);
              attemptedKinds.add(plan.kind);
              scenicRouteRequestsAttempted += 1;
              routesCallCount += 1;
              return computeDirections({
                origin: routeInput.origin,
                destination: routeInput.destination,
                waypoints: corridorWaypointsWithRequiredStops(
                  requiredCoordinates,
                  planningAnchors,
                  plan,
                ),
                alternatives: false,
              });
            };
            const recordCandidateResult = (
              corridorPlan: import("./corridor-exploration").ScenicCorridorPlan,
              result: PromiseSettledResult<typeof baseline>,
              intendedAddedMinutes: number | null,
              constructionTargetMinutes: number | null,
            ): number | null => {
              scenicRouteRequestsCompleted += 1;
              if (result.status === "rejected") {
                generatedCandidateOutcomes.push({
                  source: "scenik",
                  intendedAddedMinutes,
                  constructionTargetMinutes,
                  durationSeconds: null,
                  addedMinutes: null,
                  allowanceUtilisation: null,
                  durationTargetClassification: null,
                  estimatedDetourMeters: corridorPlan.estimatedDetourMeters,
                  waypointCount: corridorPlan.waypoints.length,
                  requiredStopOrderPreserved: true,
                  duplicate: null,
                  outcome: "ROUTE_REQUEST_FAILED",
                });
                stableErrorCode = "SCENIK_CANDIDATE_UNAVAILABLE_FALLBACK";
                rejectionReasons.add("ROUTE_REQUEST_FAILED");
                return null;
              }
              scenicRoutesReturned += 1;
              const scenikDirections = result.value;
              const actualAddedMinutes =
                Math.round(
                  (Math.max(0, scenikDirections.durationSeconds - baseline.durationSeconds) / 60) *
                    10,
                ) / 10;
              const withinBudget = candidateFitsTimeBudget(
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
              const meaningfullyDifferent = rawCandidates.every((candidate) =>
                routesAreMeaningfullyDifferent(candidate.directions, scenikDirections),
              );
              const durationTargetClassification =
                intendedAddedMinutes == null
                  ? null
                  : classifyDurationTargetResult(
                      intendedAddedMinutes,
                      actualAddedMinutes,
                      data.extra_minutes,
                    );
              generatedCandidateOutcomes.push({
                source: "scenik",
                intendedAddedMinutes,
                constructionTargetMinutes,
                durationSeconds: scenikDirections.durationSeconds,
                addedMinutes: actualAddedMinutes,
                allowanceUtilisation: candidateBudgetUtilisation(
                  baseline.durationSeconds,
                  scenikDirections.durationSeconds,
                  data.extra_minutes,
                ),
                durationTargetClassification,
                estimatedDetourMeters: corridorPlan.estimatedDetourMeters,
                waypointCount: corridorPlan.waypoints.length,
                requiredStopOrderPreserved: true,
                duplicate: !meaningfullyDifferent,
                outcome: !meaningfullyDifferent
                  ? "DUPLICATE_ROUTE"
                  : withinBudget
                    ? "ELIGIBLE"
                    : "OVER_TIME_BUDGET",
              });
              if (!withinBudget) {
                scenicRoutesRejectedOverBudget += 1;
                rejectionReasons.add("OVER_TIME_BUDGET");
              } else if (!meaningfullyDifferent) {
                rejectionReasons.add("DUPLICATE_ROUTE");
              }
              if ((withinBudget || withinUpgradeWindow) && meaningfullyDifferent) {
                rawCandidates.push({
                  directions: scenikDirections,
                  source: "scenik",
                  selectedWaypointReason: corridorPlan.waypoints
                    .map(
                      (waypoint) =>
                        waypoint.displayName ?? waypoint.categoryName ?? waypoint.reason,
                    )
                    .join(" and "),
                  intendedAddedMinutes,
                  constructionTargetMinutes,
                  durationTargetClassification,
                  scenicWaypoints: corridorPlan.waypoints.map((waypoint) => ({ ...waypoint })),
                });
                scenikCandidateAdded = true;
                scenicCandidateCount += 1;
                if (withinBudget) scenicRoutesAccepted += 1;
                const candidateSamples = routeCorridorSamples(
                  start,
                  end,
                  scenikDirections.steps,
                  7,
                );
                candidateSamples.push(
                  ...corridorPlan.waypoints.map(({ lat, lng }) => ({ lat, lng })),
                );
                const candidateScore = scoreExploredRoute({
                  start,
                  end,
                  mood: moodIn,
                  theme: themeIn,
                  extraMinutes: data.extra_minutes,
                  stopCount: waypoints.length + corridorPlan.waypoints.length,
                  directions: scenikDirections,
                  evidence: evidenceForExploration(evidencePlaces, candidateSamples, 750),
                  fastestDurationSeconds: baseline.durationSeconds,
                }).total;
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

            if (stage.targetExtraMinutes.length > 1) {
              longAttemptExecutions = await runSequentialLongAttempts({
                intendedTargets: stage.targetExtraMinutes.slice(0, remainingRouteCalls),
                maximumExtraMinutes: data.extra_minutes,
                adaptiveTarget: adaptiveDurationTargetMinutes,
                execute: async ({ intendedTargetMinutes, adaptiveTargetMinutes }) => {
                  const planning = buildCorridorPlans({
                    places: evidencePlaces,
                    anchors: planningAnchors,
                    maximumEstimatedDetourMeters:
                      averageMetersPerSecond * stage.planningBudgetMinutes * 60 * 0.95,
                    maximumPlans: 1,
                    attemptedSignatures,
                    attemptedKinds,
                    targetDetourMeters: [averageMetersPerSecond * adaptiveTargetMinutes * 60],
                  });
                  updatePlanningDiagnostics(planning);
                  const plan = planning.plans[0];
                  if (!plan) return { status: "NO_PLAN", actualAddedMinutes: null };
                  const [result] = await Promise.allSettled([requestCandidate(plan)]);
                  const actualAddedMinutes = recordCandidateResult(
                    plan,
                    result,
                    intendedTargetMinutes,
                    adaptiveTargetMinutes,
                  );
                  return {
                    status: result.status === "fulfilled" ? "COMPLETED" : "FAILED",
                    actualAddedMinutes,
                  };
                },
              });
            } else {
              const planning = buildCorridorPlans({
                places: evidencePlaces,
                anchors: planningAnchors,
                maximumEstimatedDetourMeters:
                  averageMetersPerSecond * stage.planningBudgetMinutes * 60 * 0.95,
                maximumPlans: remainingRouteCalls,
                attemptedSignatures,
                attemptedKinds,
              });
              updatePlanningDiagnostics(planning);
              const candidateRequests = planning.plans.map((plan) => ({
                plan,
                request: requestCandidate(plan),
              }));
              const candidateResults = await Promise.allSettled(
                candidateRequests.map(({ request }) => request),
              );
              candidateResults.forEach((result, index) =>
                recordCandidateResult(candidateRequests[index].plan, result, null, null),
              );
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

    const { evidenceForRoute, haversineDistanceMeters, routeCorridorSamples } =
      await import("./scenic-waypoint");
    const { scoreScenicRoute } = await import("./scenic-score");
    const scoredCandidates = rawCandidates.flatMap((candidate, originalIndex) => {
      const { directions } = candidate;
      try {
        const candidateSamples = routeCorridorSamples(start, end, directions.steps, 7);
        for (const waypoint of candidate.scenicWaypoints) {
          candidateSamples.push({
            lat: waypoint.lat,
            lng: waypoint.lng,
          });
        }
        const evidence = evidenceForRoute(evidencePlaces, candidateSamples, 750);
        const scoreResult = scoreScenicRoute({
          start,
          end,
          mood: moodIn,
          theme: themeIn,
          extraMinutes: data.extra_minutes,
          stopCount: waypoints.length + candidate.scenicWaypoints.length,
          directions,
          evidence,
          fastestDurationSeconds: baseline.durationSeconds,
        });
        return [
          {
            directions,
            score: scoreResult.total,
            scoreResult,
            originalIndex,
            source: candidate.source,
            selectedWaypointReason: candidate.selectedWaypointReason,
            evidence,
          },
        ];
      } catch {
        if (originalIndex === 0) {
          console.info("[route-selection]", {
            requestCorrelationId,
            baselineRequestSuccess,
            candidateCount: rawCandidates.length,
            eligibleCount: 0,
            requestedBudgetMinutes: data.extra_minutes,
            selectedExtraTimeMinutes: 0,
            errorCode: "SCORING_FAILED",
          });
          throw new Error("SCORING_FAILED");
        }
        stableErrorCode = "ALTERNATIVE_SCORING_FAILED_FALLBACK";
        return [];
      }
    });
    const selection = selectRouteCandidate(scoredCandidates, data.extra_minutes);
    const candidateDiagnostics = candidateSelectionDiagnostics(
      scoredCandidates,
      selection,
      data.extra_minutes,
    ).map((candidate) => {
      const generation = rawCandidates[candidate.originalIndex];
      return {
        ...candidate,
        intendedAddedMinutes: generation?.intendedAddedMinutes ?? null,
        constructionTargetMinutes: generation?.constructionTargetMinutes ?? null,
        durationTargetClassification: generation?.durationTargetClassification ?? null,
        requiredStopOrderPreserved: true,
      };
    });
    const directions = selection.selected.directions;
    const score = selection.selected.scoreResult;
    if (!alternativesUnavailableReason && selection.candidates.length <= 1) {
      alternativesUnavailableReason = "NO_DISTINCT_ALTERNATIVES_RETURNED";
    }
    const timeBudgetApplied = selection.candidates.length > 1;
    const selectedRawCandidate = rawCandidates[selection.selected.originalIndex];
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
        .forEach((waypoint, offset) => {
          candidateWaypoints.splice(waypoint.insertionIndex + offset, 0, {
            name: waypoint.displayName ?? waypoint.reason,
            lat: waypoint.lat,
            lng: waypoint.lng,
            description: verifiedDiscoveryDescription(waypoint.categoryName ?? waypoint.reason),
          });
        });
      return candidateWaypoints;
    };
    const selectedWaypoints = waypointsForCandidate(selectedRawCandidate);
    const { buildDiscoveryNarration, buildJourneyTimeline } = await import("./journey-timeline");
    const journeyTimeline = buildJourneyTimeline(
      selectedRawCandidate?.scenicWaypoints ?? [],
      directions.steps,
      { moods: moodIn, themes: themeIn },
    );
    const { journeyTitle } = await import("./journey-naming");
    const selectedJourneyTitle = journeyTitle({
      evidence: selection.selected.evidence,
      themes: themeIn,
      discoveries: journeyTimeline,
    });
    const narrationEvents = buildDiscoveryNarration(journeyTimeline);
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
    const upgradeJourneyTimeline = upgradeSelection
      ? buildJourneyTimeline(
          upgradeRawCandidate?.scenicWaypoints ?? [],
          upgradeSelection.candidate.directions.steps,
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
    const fastestScore = scoredCandidates.find((candidate) => candidate.originalIndex === 0)?.score;
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
      const candidateEligibility = generatedCandidateOutcomes.map((outcome) => {
        const diagnostic = candidateDiagnostics.find(
          (candidate) =>
            candidate.intendedAddedMinutes === outcome.intendedAddedMinutes &&
            candidate.constructionTargetMinutes === outcome.constructionTargetMinutes,
        );
        return {
          intendedTargetMinutes: outcome.intendedAddedMinutes,
          adaptiveTargetMinutes: outcome.constructionTargetMinutes,
          actualAddedMinutes: outcome.addedMinutes,
          outcomeClassification: outcome.durationTargetClassification ?? outcome.outcome,
          duplicateEligible: outcome.duplicate == null ? null : !outcome.duplicate,
          budgetEligible:
            outcome.outcome === "ROUTE_REQUEST_FAILED"
              ? null
              : outcome.outcome !== "OVER_TIME_BUDGET",
          qualityEligible:
            diagnostic == null ? null : diagnostic.rejectionReason !== "BELOW_QUALITY_GUARDRAIL",
          scenicScore: diagnostic?.score ?? null,
        };
      });
      for (const attempt of longAttemptExecutions) {
        const represented = candidateEligibility.some(
          (candidate) =>
            candidate.intendedTargetMinutes === attempt.intendedTargetMinutes &&
            candidate.adaptiveTargetMinutes === attempt.adaptiveTargetMinutes,
        );
        if (!represented) {
          candidateEligibility.push({
            intendedTargetMinutes: attempt.intendedTargetMinutes,
            adaptiveTargetMinutes: attempt.adaptiveTargetMinutes,
            actualAddedMinutes: attempt.actualAddedMinutes,
            outcomeClassification: attempt.status,
            duplicateEligible: null,
            budgetEligible: null,
            qualityEligible: null,
            scenicScore: null,
          });
        }
      }
      const { serializeRouteGenerationDiagnostic } = await import("./route-generation-diagnostics");
      console.info(
        serializeRouteGenerationDiagnostic({
          correlationId: requestCorrelationId,
          requestedExtraMinutes: data.extra_minutes,
          baselineDurationSeconds: selection.fastestDurationSeconds,
          plannedExplorationStages: explorationTargets,
          attemptsPlanned: intendedScenicRouteRequests,
          attemptsCompleted: scenicRouteRequestsCompleted,
          intendedTargetMinutes: longAttemptExecutions.map(
            (attempt) => attempt.intendedTargetMinutes,
          ),
          adaptiveTargetMinutes: longAttemptExecutions.map(
            (attempt) => attempt.adaptiveTargetMinutes,
          ),
          actualAddedMinutesReturned:
            Math.round((selection.measuredExtraTimeSeconds / 60) * 10) / 10,
          outcomeClassification: selection.timeTargetOutcome,
          candidateEligibility,
          candidateScenicScores: candidateDiagnostics.map((candidate) => candidate.score),
          finalSelectionReason,
          totalServerProcessingDurationMs: Date.now() - requestStartedAt,
        }),
      );
    } catch {
      // Diagnostics must never affect route generation.
    }

    // Log generation for free-tier metering — surface failures so the cap is enforced
    const { error: genErr } = await context.supabase
      .from("route_generations")
      .insert({ user_id: context.userId });
    if (genErr) {
      console.error("[route_generations] insert failed", genErr);
      throw new Error("Failed to record route generation. Please try again.");
    }

    const routeUpgradeCandidate = upgradeSelection
      ? {
          available: true as const,
          additionalMinutesBeyondSelectedRoute: Math.max(
            1,
            Math.ceil(
              (upgradeSelection.candidate.directions.durationSeconds - directions.durationSeconds) /
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
            narrationEvents: buildDiscoveryNarration(upgradeJourneyTimeline),
            directions: upgradeSelection.candidate.directions,
          },
        }
      : undefined;

    return {
      title: selectedJourneyTitle,
      narrative:
        selectedWinner === "scenik" && selectedWaypointReason
          ? `${data.extra_minutes > 10 ? "Your larger time allowance unlocked this route. " : ""}It adds ${Math.round(selection.measuredExtraTimeSeconds / 60)} minutes and includes a verified ${selectedWaypointReason.toLowerCase()}.`
          : selection.measuredExtraTimeSeconds > 0
            ? `This route remains within ${Math.round(selection.measuredExtraTimeSeconds / 60)} minutes of the fastest journey and scored higher on measurable route variety.`
            : data.extra_minutes > 10
              ? `Scenik searched further within your ${data.extra_minutes}-minute allowance, but no better route scored higher.`
              : "This was the highest-scoring route within your allowance without adding journey time.",
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
      highlights: journeyTimeline.map((highlight) => `${highlight.name} · ${highlight.category}`),
      journeyTimeline,
      narrationEvents,
      waypoints: selectedWaypoints,
      start: { address: start.formatted, lat: start.lat, lng: start.lng },
      end: { address: end.formatted, lat: end.lat, lng: end.lng },
      mood: moodIn || "Open",
      theme: themeIn || "Direct route",
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
      alternativesUnavailableReason,
      routeUpgradeCandidate,
      directions,
    };
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
