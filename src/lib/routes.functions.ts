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
        const alternativeResponse = await computeDirections({ ...routeInput, alternatives: true });
        googleDirections = [baseline, ...(alternativeResponse.candidates ?? [alternativeResponse])];
      } catch {
        alternativesUnavailableReason = "ALTERNATIVE_REQUEST_FAILED";
        stableErrorCode = "ALTERNATIVE_REQUEST_FAILED_FALLBACK";
      }
    }

    const { routesAreNearIdentical, selectRouteCandidate } = await import("./route-selection");
    const distinctGoogleDirections = googleDirections.filter(
      (directions, index, all) =>
        !all.slice(0, index).some((prior) => routesAreNearIdentical(prior, directions)),
    );
    const rawCandidates: Array<{
      directions: typeof baseline;
      source: "fastest" | "google" | "scenik";
      selectedWaypointReason: string | null;
      scenicWaypoint: { lat: number; lng: number; reason: string; insertionIndex: number } | null;
    }> = distinctGoogleDirections.map((directions, index) => ({
      directions,
      source: index === 0 ? "fastest" : "google",
      selectedWaypointReason: null,
      scenicWaypoint: null,
    }));

    let scenikCandidateAdded = false;
    if (distinctGoogleDirections.length === 1 && data.extra_minutes > 0) {
      try {
        const { candidateFitsTimeBudget, planScenicWaypoint, routeMidpoint, selectedPlaceTypes } =
          await import("./scenic-waypoint");
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
          const midpoint = routeMidpoint(routeInput.origin, routeInput.destination, baseline.steps);
          const budgetSeconds = data.extra_minutes * 60;
          const averageMetersPerSecond = baseline.distanceMeters / baseline.durationSeconds;
          const places = await searchNearbyScenicPlaces({
            center: midpoint,
            radiusMeters: Math.min(
              8_000,
              Math.max(1_000, averageMetersPerSecond * budgetSeconds * 0.5),
            ),
            includedTypes,
          });
          const requiredCoordinates = routeInput.waypoints.map(({ lat, lng }) => ({ lat, lng }));
          const scenicPlan = planScenicWaypoint(
            places,
            [routeInput.origin, ...requiredCoordinates, routeInput.destination],
            averageMetersPerSecond * budgetSeconds * 0.75,
          );
          if (scenicPlan) {
            const candidateWaypoints = [...requiredCoordinates];
            candidateWaypoints.splice(scenicPlan.insertionIndex, 0, {
              lat: scenicPlan.lat,
              lng: scenicPlan.lng,
            });
            const scenikDirections = await computeDirections({
              origin: routeInput.origin,
              destination: routeInput.destination,
              waypoints: candidateWaypoints,
              alternatives: false,
            });
            const withinBudget = candidateFitsTimeBudget(
              baseline.durationSeconds,
              scenikDirections.durationSeconds,
              data.extra_minutes,
            );
            const distinct = distinctGoogleDirections.every(
              (candidate) => !routesAreNearIdentical(candidate, scenikDirections),
            );
            if (withinBudget && distinct) {
              rawCandidates.push({
                directions: scenikDirections,
                source: "scenik",
                selectedWaypointReason: scenicPlan.reason,
                scenicWaypoint: {
                  lat: scenicPlan.lat,
                  lng: scenicPlan.lng,
                  reason: scenicPlan.reason,
                  insertionIndex: scenicPlan.insertionIndex,
                },
              });
              scenikCandidateAdded = true;
            }
          }
        }
      } catch {
        stableErrorCode = "SCENIK_CANDIDATE_UNAVAILABLE_FALLBACK";
      }
    }

    const { scoreScenicRoute } = await import("./scenic-score");
    const scoredCandidates = rawCandidates.flatMap((candidate, originalIndex) => {
      const { directions } = candidate;
      try {
        const scoreResult = scoreScenicRoute({
          start,
          end,
          mood: moodIn,
          theme: themeIn,
          extraMinutes: data.extra_minutes,
          stopCount: waypoints.length + (candidate.source === "scenik" ? 1 : 0),
          directions,
        });
        return [
          {
            directions,
            score: scoreResult.total,
            scoreResult,
            originalIndex,
            source: candidate.source,
            selectedWaypointReason: candidate.selectedWaypointReason,
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
    const selectedWaypoints = [...waypoints];
    if (selectedWinner === "scenik" && selectedRawCandidate?.scenicWaypoint) {
      selectedWaypoints.splice(selectedRawCandidate.scenicWaypoint.insertionIndex, 0, {
        name: selectedRawCandidate.scenicWaypoint.reason,
        lat: selectedRawCandidate.scenicWaypoint.lat,
        lng: selectedRawCandidate.scenicWaypoint.lng,
        description: selectedRawCandidate.scenicWaypoint.reason,
      });
    }
    console.info("[scenik-route-engine]", {
      candidateCount: selection.candidates.length,
      googleCandidateCount: distinctGoogleDirections.length,
      scenikCandidateAdded,
      selectedWinner,
      selectedWaypointReason,
      budgetMinutes: Math.round(selection.requestedExtraTimeBudgetSeconds / 60),
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
          ? `This route adds ${Math.round(selection.measuredExtraTimeSeconds / 60)} minutes and includes a verified ${selectedWaypointReason.toLowerCase()}, while improving its measurable route score.`
          : selection.measuredExtraTimeSeconds > 0
            ? `This route remains within ${Math.round(selection.measuredExtraTimeSeconds / 60)} minutes of the fastest journey and scored higher on measurable route variety.`
            : "This was the highest-scoring route within your allowance without adding journey time.",
      scenic_score: score.total,
      score_breakdown: score.breakdown,
      badges: score.badges,
      worth_extra_time: score.worthExtraTime,
      scoring_version: "v1.2-input-sensitive" as const,
      scoringDiagnostics: internalTester
        ? { scoringVersion: "v1.2-input-sensitive" as const }
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
