import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

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
    const { geocodeAddress, computeDirections, searchNearbyScenicPlaces } =
      await import("./google-maps.server");
    const { isInternalTestUser } = await import("./internal-testers.server");
    const internalTester = isInternalTestUser(context.userId);
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
    let scenicRoutesReturned = 0;
    let scenicRoutesRejectedOverBudget = 0;
    let scenicRoutesAccepted = 0;
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
      routesAreNearIdentical,
      routesAreMeaningfullyDifferent,
      selectRouteCandidate,
    } = await import("./route-selection");
    const distinctGoogleDirections = googleDirections.filter(
      (directions, index, all) =>
        !all.slice(0, index).some((prior) => routesAreNearIdentical(prior, directions)),
    );
    const rawCandidates: Array<{
      directions: typeof baseline;
      source: "fastest" | "google" | "scenik";
      selectedWaypointReason: string | null;
      scenicWaypoints: Array<{
        lat: number;
        lng: number;
        reason: string;
        insertionIndex: number;
      }>;
    }> = distinctGoogleDirections.map((directions, index) => ({
      directions,
      source: index === 0 ? "fastest" : "google",
      selectedWaypointReason: null,
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
          budgetUtilisation,
          buildCorridorPlans,
          corridorWaypointsWithRequiredStops,
          explorationStages,
          isTargetBudgetCandidate,
        } = await import("./corridor-exploration");
        const { scoreScenicRoute: scoreExploredRoute } = await import("./scenic-score");
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
          for (const stage of explorationStages(data.extra_minutes)) {
            const samples = routeCorridorSamples(
              routeInput.origin,
              routeInput.destination,
              baseline.steps,
              Math.min(corridorSampleCount(baseline.distanceMeters), stage.sampleCap),
            );
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
            const remainingRouteCalls = Math.max(
              0,
              stage.cumulativeRouteCap - scenicRouteRequestsAttempted,
            );
            const planning = buildCorridorPlans({
              places: evidencePlaces,
              anchors,
              maximumEstimatedDetourMeters: averageMetersPerSecond * budgetSeconds * 0.95,
              maximumPlans: remainingRouteCalls,
              attemptedSignatures,
            });
            waypointPlansConsidered = Math.max(waypointPlansConsidered, planning.considered);
            waypointPlansRejectedDuplicate = Math.max(
              waypointPlansRejectedDuplicate,
              planning.rejectedDuplicate,
            );
            waypointPlansRejectedBacktracking = Math.max(
              waypointPlansRejectedBacktracking,
              planning.rejectedBacktracking,
            );
            const candidateRequests = planning.plans.map((plan) => {
              attemptedSignatures.add(plan.signature);
              return {
                plan,
                request: computeDirections({
                  origin: routeInput.origin,
                  destination: routeInput.destination,
                  waypoints: corridorWaypointsWithRequiredStops(requiredCoordinates, anchors, plan),
                  alternatives: false,
                }),
              };
            });
            scenicRouteRequestsAttempted += candidateRequests.length;
            routesCallCount += candidateRequests.length;
            const candidateResults = await Promise.allSettled(
              candidateRequests.map(({ request }) => request),
            );
            let targetCandidateFound = false;
            for (const [index, result] of candidateResults.entries()) {
              if (result.status === "rejected") {
                stableErrorCode = "SCENIK_CANDIDATE_UNAVAILABLE_FALLBACK";
                rejectionReasons.add("ROUTE_REQUEST_FAILED");
                continue;
              }
              scenicRoutesReturned += 1;
              const corridorPlan = candidateRequests[index].plan;
              const scenikDirections = result.value;
              const withinBudget = candidateFitsTimeBudget(
                baseline.durationSeconds,
                scenikDirections.durationSeconds,
                data.extra_minutes,
              );
              const meaningfullyDifferent = rawCandidates.every((candidate) =>
                routesAreMeaningfullyDifferent(candidate.directions, scenikDirections),
              );
              if (!withinBudget) {
                scenicRoutesRejectedOverBudget += 1;
                rejectionReasons.add("OVER_TIME_BUDGET");
              } else if (!meaningfullyDifferent) {
                rejectionReasons.add("DUPLICATE_ROUTE");
              }
              if (withinBudget && meaningfullyDifferent) {
                rawCandidates.push({
                  directions: scenikDirections,
                  source: "scenik",
                  selectedWaypointReason: corridorPlan.reason,
                  scenicWaypoints: corridorPlan.waypoints.map((waypoint) => ({
                    lat: waypoint.lat,
                    lng: waypoint.lng,
                    reason: waypoint.reason,
                    insertionIndex: waypoint.insertionIndex,
                  })),
                });
                scenikCandidateAdded = true;
                scenicCandidateCount += 1;
                scenicRoutesAccepted += 1;
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
                const baselineScore = scoreExploredRoute({
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
                targetCandidateFound ||=
                  candidateScore > baselineScore &&
                  isTargetBudgetCandidate(
                    budgetUtilisation(
                      baseline.durationSeconds,
                      scenikDirections.durationSeconds,
                      data.extra_minutes,
                    ),
                  );
              }
            }
            if (targetCandidateFound) break;
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
    const directions = selection.selected.directions;
    const score = selection.selected.scoreResult;
    if (!alternativesUnavailableReason && selection.candidates.length <= 1) {
      alternativesUnavailableReason = "NO_DISTINCT_ALTERNATIVES_RETURNED";
    }
    const timeBudgetApplied = selection.candidates.length > 1;
    const selectedRawCandidate = rawCandidates[selection.selected.originalIndex];
    const selectedWaypointReason = selection.selected.selectedWaypointReason ?? null;
    const selectedWinner = selection.selected.source ?? "fastest";
    if (scenicRoutesAccepted > 0 && selectedWinner !== "scenik") {
      rejectionReasons.add("SCORE_NOT_BETTER");
    }
    const selectedWaypoints = [...waypoints];
    if (selectedWinner === "scenik" && selectedRawCandidate?.scenicWaypoints.length) {
      const anchors = [routeInput.origin, ...routeInput.waypoints, routeInput.destination];
      [...selectedRawCandidate.scenicWaypoints]
        .sort(
          (a, b) =>
            a.insertionIndex - b.insertionIndex ||
            haversineDistanceMeters(anchors[a.insertionIndex], a) -
              haversineDistanceMeters(anchors[b.insertionIndex], b),
        )
        .forEach((waypoint, offset) => {
          selectedWaypoints.splice(waypoint.insertionIndex + offset, 0, {
            name: waypoint.reason,
            lat: waypoint.lat,
            lng: waypoint.lng,
            description: selectedWaypointReason ?? waypoint.reason,
          });
        });
    }
    const scores = selection.candidates.map((candidate) => candidate.score);
    const fastestScore = scoredCandidates.find((candidate) => candidate.originalIndex === 0)?.score;
    const maximumAllowedDurationSeconds = durationCeiling(
      selection.fastestDurationSeconds,
      data.extra_minutes,
    );
    const mainRejectionReason = rejectionReasons.values().next().value ?? null;
    console.info("[scenik-route-engine-v2]", {
      requestedExtraTimeMinutes: data.extra_minutes,
      fastestDurationSeconds: selection.fastestDurationSeconds,
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
      fastestScore,
      candidateScoreMin: scores.length ? Math.min(...scores) : null,
      candidateScoreMax: scores.length ? Math.max(...scores) : null,
      candidateCount: selection.candidates.length,
      eligibleCandidateCount: selection.eligible.length,
      selectedWinnerType: selectedWinner,
      selectedScore: selection.selected.score,
      selectedMeasuredExtraMinutes: Math.round(selection.measuredExtraTimeSeconds / 60),
      mainRejectionReason,
      geocodingCallCount,
      routesCallCount,
      placesCallCount,
    });

    // Log generation for free-tier metering — surface failures so the cap is enforced
    const { error: genErr } = await context.supabase
      .from("route_generations")
      .insert({ user_id: context.userId });
    if (genErr) {
      console.error("[route_generations] insert failed", genErr);
      throw new Error("Failed to record route generation. Please try again.");
    }

    return {
      title: score.title,
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
      scoring_version: "v2-evidence-corridor" as const,
      scoringDiagnostics: internalTester
        ? {
            scoringVersion: "v2-evidence-corridor" as const,
            requestedExtraTimeMinutes: data.extra_minutes,
            fastestDurationSeconds: selection.fastestDurationSeconds,
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
            geocodingCallCount,
            routesCallCount,
            placesCallCount,
          }
        : undefined,
      highlights: [
        "Traffic-aware route",
        ...(waypoints.length
          ? [`Includes ${waypoints.length} required stop${waypoints.length === 1 ? "" : "s"}`]
          : []),
      ],
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
      alternativesUnavailableReason,
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
