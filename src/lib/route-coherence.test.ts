import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CORRIDOR_RETURN_TOLERANCE_METERS,
  evaluateRouteCoherence,
  MATERIAL_AGGREGATE_RETRACE_METERS,
  MATERIAL_WAYPOINT_SPUR_METERS,
  MAX_ALLOWED_REVERSE_OVERLAP_RATIO,
  MIN_RETRACE_PROGRESS_SEPARATION_METERS,
  MIN_REVERSE_OVERLAP_DISTANCE_METERS,
  MIN_ANALYSABLE_ROUTE_POINTS,
  MIN_WAYPOINT_LOOP_DISTANCE_METERS,
  MIN_WAYPOINT_OFFSET_FROM_JUNCTION_METERS,
  OPPOSING_BEARING_DEGREES,
  PARALLEL_TRACE_MAX_SEPARATION_METERS,
  PARALLEL_TRACE_MAX_VARIATION_METERS,
  PARALLEL_TRACE_MIN_LENGTH_METERS,
  PARALLEL_TRACE_MIN_SEPARATION_METERS,
  REVERSE_OVERLAP_TOLERANCE_METERS,
  ROUTE_COHERENCE_MAX_SAMPLES,
  ROUTE_COHERENCE_MAX_COMPARISONS,
  ROUTE_COHERENCE_MAX_DECODED_POINTS,
  ROUTE_COHERENCE_MAX_ENCODED_CHARACTERS,
  ROUTE_COHERENCE_SAMPLE_METERS,
  safeEvaluateRouteCoherence,
  SHORT_ACCESS_ROAD_EXEMPTION_METERS,
  SPATIAL_BUCKET_SIZE_METERS,
  WAYPOINT_RETRACE_WINDOW_METERS,
} from "./route-coherence";
import type { LatLng } from "./scenic-waypoint";

function encode(points: LatLng[]): string {
  let priorLat = 0;
  let priorLng = 0;
  const value = (delta: number) => {
    let encoded = "";
    let shifted = delta < 0 ? ~(delta << 1) : delta << 1;
    while (shifted >= 0x20) {
      encoded += String.fromCharCode((0x20 | (shifted & 0x1f)) + 63);
      shifted >>= 5;
    }
    return encoded + String.fromCharCode(shifted + 63);
  };
  return points
    .map((point) => {
      const lat = Math.round(point.lat * 1e5);
      const lng = Math.round(point.lng * 1e5);
      const result = value(lat - priorLat) + value(lng - priorLng);
      priorLat = lat;
      priorLng = lng;
      return result;
    })
    .join("");
}

const result = (points: LatLng[], waypoints: LatLng[] = []) =>
  evaluateRouteCoherence(encode(points), waypoints);

describe("route coherence", () => {
  it("locks the reviewed route-coherence thresholds", () => {
    assert.deepEqual(
      {
        sampleMeters: ROUTE_COHERENCE_SAMPLE_METERS,
        maxSamples: ROUTE_COHERENCE_MAX_SAMPLES,
        bucketMeters: SPATIAL_BUCKET_SIZE_METERS,
        proximityMeters: REVERSE_OVERLAP_TOLERANCE_METERS,
        opposingDegrees: OPPOSING_BEARING_DEGREES,
        parallelMinSeparationMeters: PARALLEL_TRACE_MIN_SEPARATION_METERS,
        parallelMaxSeparationMeters: PARALLEL_TRACE_MAX_SEPARATION_METERS,
        parallelMinLengthMeters: PARALLEL_TRACE_MIN_LENGTH_METERS,
        parallelMaxVariationMeters: PARALLEL_TRACE_MAX_VARIATION_METERS,
        minimumReverseMeters: MIN_REVERSE_OVERLAP_DISTANCE_METERS,
        maximumReverseRatio: MAX_ALLOWED_REVERSE_OVERLAP_RATIO,
        waypointSpurMeters: MATERIAL_WAYPOINT_SPUR_METERS,
        aggregateMeters: MATERIAL_AGGREGATE_RETRACE_METERS,
        progressionSeparationMeters: MIN_RETRACE_PROGRESS_SEPARATION_METERS,
        shortAccessExemptionMeters: SHORT_ACCESS_ROAD_EXEMPTION_METERS,
        maximumComparisons: ROUTE_COHERENCE_MAX_COMPARISONS,
        maximumEncodedCharacters: ROUTE_COHERENCE_MAX_ENCODED_CHARACTERS,
        maximumDecodedPoints: ROUTE_COHERENCE_MAX_DECODED_POINTS,
        waypointWindowMeters: WAYPOINT_RETRACE_WINDOW_METERS,
        corridorReturnMeters: CORRIDOR_RETURN_TOLERANCE_METERS,
        minimumLoopMeters: MIN_WAYPOINT_LOOP_DISTANCE_METERS,
        minimumWaypointOffsetMeters: MIN_WAYPOINT_OFFSET_FROM_JUNCTION_METERS,
        minimumAnalysablePoints: MIN_ANALYSABLE_ROUTE_POINTS,
      },
      {
        sampleMeters: 100,
        maxSamples: 4_000,
        bucketMeters: 30,
        proximityMeters: 15,
        opposingDegrees: 150,
        parallelMinSeparationMeters: 4,
        parallelMaxSeparationMeters: 15,
        parallelMinLengthMeters: 800,
        parallelMaxVariationMeters: 3,
        minimumReverseMeters: 1_200,
        maximumReverseRatio: 0.18,
        waypointSpurMeters: 1_800,
        aggregateMeters: 2_500,
        progressionSeparationMeters: 800,
        shortAccessExemptionMeters: 800,
        maximumComparisons: 250_000,
        maximumEncodedCharacters: 1_000_000,
        maximumDecodedPoints: 100_000,
        waypointWindowMeters: 12_000,
        corridorReturnMeters: 250,
        minimumLoopMeters: 2_500,
        minimumWaypointOffsetMeters: 600,
        minimumAnalysablePoints: 3,
      },
    );
  });
  it("rejects Ashby-style local loops and Blackburn-style partial-return spurs", () => {
    for (const branchLatitude of [0.02, 0.035]) {
      const waypoint = { lat: branchLatitude, lng: 0.02 };
      const shape = result(
        [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 0.02 },
          { lat: branchLatitude * 0.5, lng: 0.02 },
          waypoint,
          { lat: branchLatitude * 0.75, lng: 0.0208 },
          { lat: branchLatitude * 0.25, lng: 0.0212 },
          { lat: 0.0008, lng: 0.0205 },
          { lat: 0, lng: 0.05 },
        ],
        [waypoint],
      );
      assert.equal(shape.routeShapeEligible, false);
      assert.equal(shape.waypointSpurDetected, true);
      assert.equal(shape.affectedWaypointIndex, 0);
      assert.equal(shape.reverseOverlapDistanceMeters < 1_800, true);
    }
  });

  it("rejects multiple sub-threshold spurs when aggregate retrace is material", () => {
    const first = { lat: 0.016, lng: 0.015 };
    const second = { lat: -0.016, lng: 0.035 };
    const shape = result(
      [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.015 },
        first,
        { lat: 0, lng: 0.015 },
        { lat: 0, lng: 0.035 },
        second,
        { lat: 0, lng: 0.035 },
        { lat: 0, lng: 0.05 },
      ],
      [first, second],
    );
    assert.equal(shape.routeShapeEligible, false);
    assert.ok(shape.reverseOverlapDistanceMeters >= 2_500);
    const firstOnly = result([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.015 },
      first,
      { lat: 0, lng: 0.015 },
      { lat: 0, lng: 0.05 },
    ]);
    const secondOnly = result([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.035 },
      second,
      { lat: 0, lng: 0.035 },
      { lat: 0, lng: 0.05 },
    ]);
    assert.ok(
      Math.abs(
        shape.reverseOverlapDistanceMeters -
          (firstOnly.reverseOverlapDistanceMeters + secondOnly.reverseOverlapDistanceMeters),
      ) <= ROUTE_COHERENCE_SAMPLE_METERS,
    );
  });

  it("allows a short access road", () => {
    const waypoint = { lat: 0.004, lng: 0.02 };
    assert.equal(
      result(
        [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 0.02 },
          waypoint,
          { lat: 0, lng: 0.02 },
          { lat: 0, lng: 0.04 },
        ],
        [waypoint],
      ).routeShapeEligible,
      true,
    );
  });

  it("allows waypoint-bearing forward loops and difficult but coherent road shapes", () => {
    const validRoutes: Array<{ points: LatLng[]; waypoint: LatLng }> = [
      {
        // A scenic loop returns near its departure but turns smoothly and then continues forward.
        points: [
          { lat: 51, lng: 0 },
          { lat: 51, lng: 0.02 },
          { lat: 51.02, lng: 0.02 },
          { lat: 51.02, lng: 0.04 },
          { lat: 51.0005, lng: 0.0205 },
          { lat: 51, lng: 0.06 },
        ],
        waypoint: { lat: 51.02, lng: 0.03 },
      },
      {
        // Rejoins the same forward corridor materially farther ahead.
        points: [
          { lat: 51, lng: 0 },
          { lat: 51, lng: 0.01 },
          { lat: 51.015, lng: 0.025 },
          { lat: 51.01, lng: 0.04 },
          { lat: 51, lng: 0.055 },
          { lat: 51, lng: 0.08 },
        ],
        waypoint: { lat: 51.015, lng: 0.025 },
      },
      {
        // Figure-eight crossing without reversing at the waypoint.
        points: [
          { lat: 51, lng: 0 },
          { lat: 51.01, lng: 0.01 },
          { lat: 51, lng: 0.02 },
          { lat: 50.99, lng: 0.01 },
          { lat: 51, lng: 0 },
          { lat: 51.01, lng: -0.01 },
          { lat: 51, lng: -0.02 },
        ],
        waypoint: { lat: 51, lng: 0.02 },
      },
      {
        // Motorway-adjacent parallel road remains forward-moving.
        points: [
          { lat: 51, lng: 0 },
          { lat: 51, lng: 0.03 },
          { lat: 51.0003, lng: 0.03 },
          { lat: 51.0003, lng: 0.06 },
          { lat: 51, lng: 0.08 },
        ],
        waypoint: { lat: 51.0003, lng: 0.045 },
      },
      {
        // Dense urban grid loop progresses forward rather than turning at the waypoint.
        points: [
          { lat: 51, lng: 0 },
          { lat: 51, lng: 0.01 },
          { lat: 51.005, lng: 0.01 },
          { lat: 51.005, lng: 0.02 },
          { lat: 51, lng: 0.02 },
          { lat: 51, lng: 0.04 },
        ],
        waypoint: { lat: 51.005, lng: 0.015 },
      },
      {
        // Coastal road bends back near itself without retracing.
        points: [
          { lat: 51, lng: 0 },
          { lat: 51.01, lng: 0.01 },
          { lat: 51.015, lng: 0.025 },
          { lat: 51.008, lng: 0.04 },
          { lat: 51.012, lng: 0.055 },
        ],
        waypoint: { lat: 51.015, lng: 0.025 },
      },
      {
        // Mountain switchbacks alternate direction while continuing uphill.
        points: [
          { lat: 51, lng: 0 },
          { lat: 51.005, lng: 0.01 },
          { lat: 51.01, lng: 0 },
          { lat: 51.015, lng: 0.01 },
          { lat: 51.02, lng: 0 },
        ],
        waypoint: { lat: 51.01, lng: 0 },
      },
    ];
    for (const { points, waypoint } of validRoutes)
      assert.equal(result(points, [waypoint]).routeShapeEligible, true);

    const simpleValidRoutes: LatLng[][] = [
      [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.01 },
        { lat: 0.001, lng: 0.011 },
        { lat: 0, lng: 0.012 },
        { lat: 0, lng: 0.02 },
      ],
      [
        { lat: 0, lng: 0 },
        { lat: 0.01, lng: 0.01 },
        { lat: 0, lng: 0.02 },
        { lat: -0.01, lng: 0.01 },
      ],
      [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.03 },
        { lat: 0.0003, lng: 0.03 },
        { lat: 0.0003, lng: 0 },
      ],
      [
        { lat: 0, lng: 0 },
        { lat: 0.005, lng: 0.01 },
        { lat: 0.01, lng: 0 },
        { lat: 0.015, lng: 0.01 },
        { lat: 0.02, lng: 0 },
      ],
      [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.02 },
        { lat: 0.02, lng: 0.02 },
        { lat: 0.02, lng: 0.04 },
        { lat: 0, lng: 0.04 },
      ],
    ];
    for (const points of simpleValidRoutes) assert.equal(result(points).routeShapeEligible, true);
  });

  it("deduplicates the same retrace across overlapping waypoint windows", () => {
    const first = { lat: 0.016, lng: 0.015 };
    const second = { lat: -0.016, lng: 0.035 };
    const points = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.015 },
      first,
      { lat: 0, lng: 0.015 },
      { lat: 0, lng: 0.035 },
      second,
      { lat: 0, lng: 0.035 },
      { lat: 0, lng: 0.05 },
    ];
    const one = result(points, [first]);
    const two = result(points, [first, second]);
    const overlapping = result(points, [first, first, second, second]);
    assert.equal(two.reverseOverlapDistanceMeters, one.reverseOverlapDistanceMeters);
    assert.equal(overlapping.reverseOverlapDistanceMeters, one.reverseOverlapDistanceMeters);
  });

  it("counts a physical retraced corridor once across two or three traversals", () => {
    const start = { lat: 51, lng: 0 };
    const end = { lat: 51, lng: 0.04 };
    const onward = { lat: 51.02, lng: 0 };
    const twoPass = result([start, end, start, onward]);
    const threePass = result([start, end, start, end, onward]);
    assert.equal(twoPass.reverseOverlapDistanceMeters, threePass.reverseOverlapDistanceMeters);
    assert.ok(twoPass.reverseOverlapDistanceMeters >= 2_500);
  });

  it("conservatively separates sustained parallel carriageways from centreline retraces", () => {
    const parallelRoute = (separationMeters: number) => {
      const latitudeOffset = separationMeters / 111_320;
      return result([
        { lat: 51, lng: 0 },
        { lat: 51, lng: 0.05 },
        { lat: 51 + latitudeOffset, lng: 0.05 },
        { lat: 51 + latitudeOffset, lng: 0 },
        { lat: 51 + latitudeOffset, lng: -0.01 },
      ]);
    };
    for (const separation of [5, 8, 10, 15]) {
      const shape = parallelRoute(separation);
      assert.equal(shape.routeShapeEligible, true, `${separation} m separate carriageways`);
    }
    assert.equal(parallelRoute(16).routeShapeEligible, true);
    assert.equal(parallelRoute(0).routeShapeEligible, false, "exact centreline retrace");
    assert.equal(parallelRoute(2).routeShapeEligible, false, "minor provider jitter");

    const turnaround = { lat: 51, lng: 0.05 };
    const converging = result(
      [
        { lat: 51, lng: 0 },
        turnaround,
        { lat: 51.00009, lng: 0.04 },
        { lat: 51.00005, lng: 0.02 },
        { lat: 51, lng: 0 },
      ],
      [turnaround],
    );
    assert.equal(converging.routeShapeEligible, false, "traces converge across a real turnaround");
  });

  it("does not combine fragmented or noisy offsets into a sustained ambiguity run", () => {
    const offset = (meters: number) => 51 + meters / 111_320;
    const alternating = result([
      { lat: 51, lng: 0 },
      { lat: 51, lng: 0.06 },
      { lat: offset(5), lng: 0.05 },
      { lat: offset(20), lng: 0.04 },
      { lat: offset(5), lng: 0.03 },
      { lat: offset(20), lng: 0.02 },
      { lat: offset(5), lng: 0.01 },
      { lat: 51, lng: 0 },
    ]);
    assert.equal(alternating.routeShapeEligible, false, "alternating 5 m/20 m retrace");
    assert.equal(alternating.routeShapeRejectionReason, "MATERIAL_REVERSE_RETRACE");

    const disconnected = result([
      { lat: 51, lng: 0 },
      { lat: 51, lng: 0.06 },
      { lat: offset(8), lng: 0.05 },
      { lat: 51, lng: 0.04 },
      { lat: offset(8), lng: 0.03 },
      { lat: 51, lng: 0.02 },
      { lat: offset(8), lng: 0.01 },
      { lat: 51, lng: 0 },
    ]);
    assert.equal(disconnected.routeShapeEligible, false, "disconnected in-band fragments");

    const noisy = result([
      { lat: 51, lng: 0 },
      { lat: 51, lng: 0.06 },
      { lat: offset(5), lng: 0.05 },
      { lat: offset(10), lng: 0.04 },
      { lat: offset(5), lng: 0.03 },
      { lat: offset(10), lng: 0.02 },
      { lat: offset(5), lng: 0.01 },
      { lat: 51, lng: 0 },
    ]);
    assert.equal(noisy.routeShapeEligible, false, "separation variation above 3 m");
  });

  it("handles short and repeated dateline crossings on the wrapped longitude path", () => {
    const coherent = result([
      { lat: 0, lng: 179.98 },
      { lat: 0, lng: -179.99 },
      { lat: 0.02, lng: -179.97 },
    ]);
    assert.equal(coherent.routeShapeEligible, true);
    assert.ok(coherent.sampledPointCount < 100);

    const retracePoints = [
      { lat: 0, lng: 179.98 },
      { lat: 0, lng: 179.99 },
      { lat: 0, lng: -179.99 },
      { lat: 0, lng: -179.98 },
      { lat: 0, lng: -179.99 },
      { lat: 0, lng: 179.99 },
      { lat: 0, lng: 179.98 },
    ];
    const eastWest = result(retracePoints);
    const westEast = result(retracePoints.map((point) => ({ ...point, lng: -point.lng })));
    assert.equal(eastWest.routeShapeRejectionReason, "MATERIAL_REVERSE_RETRACE");
    assert.equal(westEast.routeShapeRejectionReason, "MATERIAL_REVERSE_RETRACE");
    assert.equal(eastWest.reverseOverlapDistanceMeters, westEast.reverseOverlapDistanceMeters);
    assert.ok(eastWest.reverseOverlapDistanceMeters < 5_000);

    const midpointBucketRetrace = result([
      { lat: 0.01, lng: 179.97 },
      { lat: 0.01, lng: -179.97 },
      { lat: 0.01, lng: 179.97 },
      { lat: 0.02, lng: 179.96 },
    ]);
    assert.equal(midpointBucketRetrace.routeShapeRejectionReason, "MATERIAL_REVERSE_RETRACE");
    assert.ok(midpointBucketRetrace.reverseOverlapDistanceMeters < 10_000);
  });

  it("is invariant to overlapping waypoint match-discovery order", () => {
    const first = { lat: 0.016, lng: 0.015 };
    const second = { lat: -0.016, lng: 0.035 };
    const points = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.015 },
      first,
      { lat: 0, lng: 0.015 },
      { lat: 0, lng: 0.035 },
      second,
      { lat: 0, lng: 0.035 },
      { lat: 0, lng: 0.05 },
    ];
    const forward = result(points, [first, second]);
    const reverse = result(points, [second, first]);
    assert.deepEqual(
      {
        eligible: forward.routeShapeEligible,
        reason: forward.routeShapeRejectionReason,
        distance: forward.reverseOverlapDistanceMeters,
        ratio: forward.reverseOverlapRatio,
        spur: forward.waypointSpurDetected,
      },
      {
        eligible: reverse.routeShapeEligible,
        reason: reverse.routeShapeRejectionReason,
        distance: reverse.reverseOverlapDistanceMeters,
        ratio: reverse.reverseOverlapRatio,
        spur: reverse.waypointSpurDetected,
      },
    );
  });

  it("reports the least-certain association across all evaluated waypoints", () => {
    const points = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.02 },
      { lat: 0, lng: 0.04 },
      { lat: 0, lng: 0.06 },
    ];
    assert.equal(
      result(points, [points[1], { lat: 0.01, lng: 0.03 }]).waypointAssociationStatus,
      "APPROXIMATE",
    );
    assert.equal(
      result(
        [{ lat: 0, lng: 0 }, points[1], points[2], points[1], points[3]],
        [points[0], points[1]],
      ).waypointAssociationStatus,
      "AMBIGUOUS",
    );
    assert.equal(
      result(points, [points[1], { lat: Number.NaN, lng: 0 }]).waypointAssociationStatus,
      "UNAVAILABLE",
    );
    assert.equal(result(points, [points[0], points[3]]).waypointAssociationStatus, "EXACT");
    assert.equal(result(points).waypointAssociationStatus, "UNAVAILABLE");
  });

  it("counts association checks in the shared request-wide work budget", () => {
    const points = Array.from({ length: 6_000 }, (_, index) => ({
      lat: 45 + index * 0.001,
      lng: -1 + Math.sin(index / 50) * 0.0002,
    }));
    const withoutWaypoint = result(points);
    const withWaypoint = result(points, [{ lat: 40, lng: 5 }]);
    assert.ok(
      withWaypoint.spatialBucketComparisons >= withoutWaypoint.spatialBucketComparisons + 4_000,
    );

    const exhausted = result(
      points,
      Array.from({ length: 63 }, (_, index) => ({ lat: 40 + index * 0.01, lng: 5 })),
    );
    assert.equal(exhausted.routeShapeAnalysisStatus, "WORK_LIMIT_EXCEEDED");
    assert.equal(exhausted.routeShapeRejectionReason, "ANALYSIS_WORK_LIMIT");
    assert.equal(exhausted.spatialBucketComparisons, ROUTE_COHERENCE_MAX_COMPARISONS);

    const instrumentation = { spatialBucketBuilds: 0, wholeRouteIndexBuilds: 0 };
    const instrumented = evaluateRouteCoherence(
      encode(points),
      Array.from({ length: 63 }, (_, index) => ({ lat: 40 + index * 0.01, lng: 5 })),
      { instrumentation } as never,
    );
    assert.equal(instrumented.routeShapeAnalysisStatus, "WORK_LIMIT_EXCEEDED");
    assert.deepEqual(instrumentation, { spatialBucketBuilds: 0, wholeRouteIndexBuilds: 0 });
  });

  it("fails oversized encoded and decoded geometry with a distinct safe classification", () => {
    const atCharacterLimit = evaluateRouteCoherence(
      "~".repeat(ROUTE_COHERENCE_MAX_ENCODED_CHARACTERS),
    );
    assert.equal(atCharacterLimit.routeShapeAnalysisStatus, "MALFORMED_GEOMETRY");
    const aboveCharacterLimit = evaluateRouteCoherence(
      "~".repeat(ROUTE_COHERENCE_MAX_ENCODED_CHARACTERS + 1),
    );
    assert.equal(aboveCharacterLimit.routeShapeAnalysisStatus, "GEOMETRY_LIMIT_EXCEEDED");
    assert.equal(aboveCharacterLimit.routeShapeRejectionReason, "GEOMETRY_LIMIT_EXCEEDED");

    const repeatedPoint = { lat: 51, lng: -1 };
    const atPointLimit = evaluateRouteCoherence(
      encode(Array.from({ length: ROUTE_COHERENCE_MAX_DECODED_POINTS }, () => repeatedPoint)),
    );
    assert.notEqual(atPointLimit.routeShapeAnalysisStatus, "GEOMETRY_LIMIT_EXCEEDED");
    const abovePointLimit = evaluateRouteCoherence(
      encode(Array.from({ length: ROUTE_COHERENCE_MAX_DECODED_POINTS + 1 }, () => repeatedPoint)),
    );
    assert.equal(abovePointLimit.routeShapeAnalysisStatus, "GEOMETRY_LIMIT_EXCEEDED");
    assert.equal(abovePointLimit.routeShapeEligible, false);
  });

  it("does not claim an affected waypoint when association is ambiguous", () => {
    const waypoint = { lat: 0.01, lng: 0.02 };
    const shape = result(
      [{ lat: 0, lng: 0 }, waypoint, { lat: 0.02, lng: 0.04 }, waypoint, { lat: 0, lng: 0.06 }],
      [waypoint],
    );
    assert.equal(shape.waypointAssociationStatus, "AMBIGUOUS");
    assert.equal(shape.affectedWaypointIndex, null);
  });

  it("fails closed for missing, malformed, too-short and invalid new geometry", () => {
    for (const encoded of [
      undefined,
      "?",
      encode([
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.01 },
      ]),
      encode([
        { lat: 91, lng: 0 },
        { lat: 91, lng: 0.01 },
        { lat: 91, lng: 0.02 },
      ]),
    ]) {
      const shape = evaluateRouteCoherence(encoded);
      assert.equal(shape.routeShapeEligible, false);
      assert.ok(
        ["MISSING_GEOMETRY", "MALFORMED_GEOMETRY"].includes(shape.routeShapeAnalysisStatus),
      );
    }
    assert.equal(evaluateRouteCoherence("~~~~~~").routeShapeAnalysisStatus, "MALFORMED_GEOMETRY");
  });

  it("preserves legacy display compatibility when analysis is unavailable", () => {
    const shape = evaluateRouteCoherence(undefined, [], { legacy: true });
    assert.equal(shape.routeShapeEligible, true);
    assert.equal(shape.routeShapeAnalysisStatus, "LEGACY_UNAVAILABLE");
    assert.equal(shape.routeShapeRejectionReason, null);
  });

  it("contains unexpected diagnostic failures without throwing", () => {
    const shape = safeEvaluateRouteCoherence("valid", [], {}, () => {
      throw new Error("unexpected analysis failure");
    });
    assert.equal(shape.routeShapeEligible, false);
    assert.equal(shape.routeShapeAnalysisStatus, "MALFORMED_GEOMETRY");
  });

  it("enforces the 4,000-sample ceiling", () => {
    const points = Array.from({ length: 5_500 }, (_, index) => ({
      lat: 51 + index * 0.00001,
      lng: -1 + Math.sin(index / 20) * 0.0001,
    }));
    const shape = evaluateRouteCoherence(encode(points));
    assert.equal(shape.routeShapeAnalysisStatus, "ANALYSED");
    assert.ok(shape.sampledPointCount <= ROUTE_COHERENCE_MAX_SAMPLES);
  });

  it("detects a detailed long retrace after distance-uniform reduction", () => {
    const outbound = Array.from({ length: 3_000 }, (_, index) => ({
      lat: 51,
      lng: index * 0.001,
    }));
    const shape = result([...outbound, ...outbound.slice(0, -1).reverse()]);
    assert.equal(shape.sampledPointCount, ROUTE_COHERENCE_MAX_SAMPLES);
    assert.equal(shape.routeShapeEligible, false);
    assert.equal(shape.routeShapeRejectionReason, "MATERIAL_REVERSE_RETRACE");
  });

  it("keeps a detailed long coherent route eligible after reduction", () => {
    const points = Array.from({ length: 6_000 }, (_, index) => ({
      lat: 45 + index * 0.001,
      lng: -1 + Math.sin(index / 50) * 0.0002,
    }));
    const shape = result(points);
    assert.equal(shape.sampledPointCount, ROUTE_COHERENCE_MAX_SAMPLES);
    assert.equal(shape.routeShapeEligible, true);
  });

  it("fails closed with an explicit status at the comparison work limit", () => {
    const points = Array.from({ length: 60_000 }, (_, index) => ({
      lat: 51 + Math.sin(index * 0.17) * 0.00008,
      lng: Math.cos(index * 0.17) * 0.00008,
    }));
    const shape = result(points);
    assert.equal(shape.routeShapeEligible, false);
    assert.equal(shape.routeShapeAnalysisStatus, "WORK_LIMIT_EXCEEDED");
    assert.equal(shape.routeShapeRejectionReason, "ANALYSIS_WORK_LIMIT");
    assert.equal(shape.spatialBucketComparisons, ROUTE_COHERENCE_MAX_COMPARISONS);
  });
});
