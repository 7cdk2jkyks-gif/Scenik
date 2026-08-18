import { haversineDistanceMeters, type LatLng } from "./scenic-waypoint";

/** Same-road tolerance; deliberately below typical separation between parallel carriageways. */
export const REVERSE_OVERLAP_TOLERANCE_METERS = 15;
/** Preferred geometry resolution before the long-route sample ceiling is applied. */
export const ROUTE_COHERENCE_SAMPLE_METERS = 100;
/** Hard memory ceiling for unusually detailed or very long polylines. */
export const ROUTE_COHERENCE_MAX_SAMPLES = 4_000;
/** Twice the same-road tolerance so neighbouring buckets contain every possible match. */
export const SPATIAL_BUCKET_SIZE_METERS = 30;
/** Deterministic ceiling for proximity comparisons, including dense or malformed geometry. */
export const ROUTE_COHERENCE_MAX_COMPARISONS = 250_000;
/** Generous pre-decode ceiling protecting CPU from unexpected multi-megabyte payloads. */
export const ROUTE_COHERENCE_MAX_ENCODED_CHARACTERS = 1_000_000;
/** Generous during-decode point ceiling protecting memory before route resampling. */
export const ROUTE_COHERENCE_MAX_DECODED_POINTS = 100_000;
/** Offsets below this are treated as centreline/provider jitter rather than separate traces. */
export const PARALLEL_TRACE_MIN_SEPARATION_METERS = 4;
/** Geometry-only ambiguity band; road identity cannot be proven without topology. */
export const PARALLEL_TRACE_MAX_SEPARATION_METERS = 15;
/** Requires a sustained offset before suppressing aggregate reverse-distance evidence. */
export const PARALLEL_TRACE_MIN_LENGTH_METERS = 800;
/** Consistent separation distinguishes a parallel trace from ordinary local geometry noise. */
export const PARALLEL_TRACE_MAX_VARIATION_METERS = 3;
/** Limits waypoint analysis to the local 12 km before and after each inserted stop. */
export const WAYPOINT_RETRACE_WINDOW_METERS = 12_000;
/** A repeated waypoint access leg of 1.8 km is a material user-visible spur. */
export const MATERIAL_WAYPOINT_SPUR_METERS = 1_800;
/** Several smaller reversals become material once their unique combined length reaches 2.5 km. */
export const MATERIAL_AGGREGATE_RETRACE_METERS = 2_500;
/** Absolute floor before the proportional aggregate-retrace rule may reject a route. */
export const MIN_REVERSE_OVERLAP_DISTANCE_METERS = 1_200;
/** Reject repeated travel above 18% once the absolute floor is also reached. */
export const MAX_ALLOWED_REVERSE_OVERLAP_RATIO = 0.18;
/** Prevent nearby manoeuvres from matching themselves as later reverse travel. */
export const MIN_RETRACE_PROGRESS_SEPARATION_METERS = 800;
/** Access roads at or below 800 m remain acceptable even when travelled both ways. */
export const SHORT_ACCESS_ROAD_EXEMPTION_METERS = 800;
/** Bearings separated by at least 150 degrees are travelling in opposing directions. */
export const OPPOSING_BEARING_DEGREES = 150;
/** Different local streets may still return to the same main corridor within 250 m. */
export const CORRIDOR_RETURN_TOLERANCE_METERS = 250;
/** Corridor returns must contain at least 2.5 km of route to exclude local manoeuvres. */
export const MIN_WAYPOINT_LOOP_DISTANCE_METERS = 2_500;
/** Also defines the approach/departure window used to prove a reversal at the waypoint. */
export const MIN_WAYPOINT_OFFSET_FROM_JUNCTION_METERS = 600;
/** Fewer than three points cannot describe a route shape with an intermediate turn. */
export const MIN_ANALYSABLE_ROUTE_POINTS = 3;

export type RouteShapeAnalysisStatus =
  | "ANALYSED"
  | "MISSING_GEOMETRY"
  | "MALFORMED_GEOMETRY"
  | "GEOMETRY_LIMIT_EXCEEDED"
  | "WORK_LIMIT_EXCEEDED"
  | "LEGACY_UNAVAILABLE"
  | "TRUSTED_BASELINE";

export type RouteShapeRejectionReason =
  | "WAYPOINT_SPUR"
  | "MATERIAL_REVERSE_RETRACE"
  | "MISSING_GEOMETRY"
  | "MALFORMED_GEOMETRY"
  | "GEOMETRY_LIMIT_EXCEEDED"
  | "ANALYSIS_WORK_LIMIT"
  | "ANCHOR_ORDER_INVALID"
  | "DESTINATION_TERMINATION_INVALID"
  | null;

export type WaypointAssociationStatus =
  | "EXACT"
  | "UNAMBIGUOUS"
  | "APPROXIMATE"
  | "AMBIGUOUS"
  | "UNAVAILABLE";

export type RouteCoherenceResult = {
  routeShapeEligible: boolean;
  routeShapeRejectionReason: RouteShapeRejectionReason;
  reverseOverlapDistanceMeters: number;
  reverseOverlapRatio: number;
  waypointSpurDetected: boolean;
  affectedWaypointIndex: number | null;
  waypointAssociationStatus: WaypointAssociationStatus;
  routeShapeAnalysisStatus: RouteShapeAnalysisStatus;
  sampledPointCount: number;
  spatialBucketComparisons: number;
};

export type RouteAnchorValidationResult = {
  eligible: boolean;
  rejectionReason: "ANCHOR_ORDER_INVALID" | "DESTINATION_TERMINATION_INVALID" | null;
  matchedAnchorCount: number;
};

type Segment = { from: LatLng; to: LatLng; length: number; bearing: number; progress: number };
type Match = { firstIndex: number; secondIndex: number; distance: number };
type WorkBudget = { comparisons: number; exceeded: boolean };
type RouteCoherenceInstrumentation = {
  spatialBucketBuilds: number;
  wholeRouteIndexBuilds: number;
};

class GeometryLimitError extends Error {}

export function shortestLongitudeDelta(from: number, to: number): number {
  return ((((to - from + 540) % 360) + 360) % 360) - 180;
}

export function normaliseLongitude(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

function decodeBoundedPolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const coordinate = () => {
    let byte: number;
    let shift = 0;
    let result = 0;
    do {
      if (index >= encoded.length || shift > 30) throw new Error("MALFORMED_POLYLINE");
      byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) throw new Error("MALFORMED_POLYLINE");
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += coordinate();
    lng += coordinate();
    if (points.length >= ROUTE_COHERENCE_MAX_DECODED_POINTS) throw new GeometryLimitError();
    points.push({ lat: lat * 1e-5, lng: lng * 1e-5 });
  }
  return points;
}

function bearingDegrees(from: LatLng, to: LatLng): number {
  const radians = (value: number) => (value * Math.PI) / 180;
  const degrees = (value: number) => (value * 180) / Math.PI;
  const dLng = radians(shortestLongitudeDelta(from.lng, to.lng));
  const lat1 = radians(from.lat);
  const lat2 = radians(to.lat);
  return (
    (degrees(
      Math.atan2(
        Math.sin(dLng) * Math.cos(lat2),
        Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng),
      ),
    ) +
      360) %
    360
  );
}

function opposing(first: number, second: number): boolean {
  const difference = Math.abs(first - second);
  return Math.min(difference, 360 - difference) >= OPPOSING_BEARING_DEGREES;
}

function resample(points: LatLng[]): { points: LatLng[]; intervalMeters: number } {
  const lengths = points
    .slice(1)
    .map((point, index) => haversineDistanceMeters(points[index], point));
  const totalDistance = lengths.reduce((sum, length) => sum + length, 0);
  const intervalMeters = Math.max(
    ROUTE_COHERENCE_SAMPLE_METERS,
    totalDistance / (ROUTE_COHERENCE_MAX_SAMPLES - 1),
  );
  if (totalDistance <= 0) return { points: [points[0]], intervalMeters };

  const sampled = [points[0]];
  let nextProgress = intervalMeters;
  let progress = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    const from = points[index];
    const to = points[index + 1];
    while (length > 0 && nextProgress < progress + length && sampled.length < 3_999) {
      const fraction = (nextProgress - progress) / length;
      sampled.push({
        lat: from.lat + (to.lat - from.lat) * fraction,
        lng: normaliseLongitude(from.lng + shortestLongitudeDelta(from.lng, to.lng) * fraction),
      });
      nextProgress += intervalMeters;
    }
    progress += length;
  }
  const last = points.at(-1)!;
  if (haversineDistanceMeters(sampled.at(-1)!, last) > 0.01) sampled.push(last);
  return { points: sampled.slice(0, ROUTE_COHERENCE_MAX_SAMPLES), intervalMeters };
}

function segments(points: LatLng[]): Segment[] {
  let progress = 0;
  return points.slice(1).flatMap((to, index) => {
    const from = points[index];
    const length = haversineDistanceMeters(from, to);
    const segment = { from, to, length, bearing: bearingDegrees(from, to), progress };
    progress += length;
    return length > 0 ? [segment] : [];
  });
}

function projectedPoint(point: LatLng, referenceLatitude: number, referenceLongitude = 0) {
  const latitudeMeters = 111_320;
  const longitudeMeters = Math.max(
    1,
    latitudeMeters * Math.cos((referenceLatitude * Math.PI) / 180),
  );
  return {
    x: shortestLongitudeDelta(referenceLongitude, point.lng) * longitudeMeters,
    y: point.lat * latitudeMeters,
  };
}

function pointToSegmentDistanceMeters(point: LatLng, segment: Segment): number {
  const referenceLatitude = (point.lat + segment.from.lat + segment.to.lat) / 3;
  const referenceLongitude = point.lng;
  const p = projectedPoint(point, referenceLatitude, referenceLongitude);
  const from = projectedPoint(segment.from, referenceLatitude, referenceLongitude);
  const to = projectedPoint(segment.to, referenceLatitude, referenceLongitude);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const denominator = dx * dx + dy * dy;
  const fraction =
    denominator === 0
      ? 0
      : Math.max(0, Math.min(1, ((p.x - from.x) * dx + (p.y - from.y) * dy) / denominator));
  return Math.hypot(p.x - (from.x + fraction * dx), p.y - (from.y + fraction * dy));
}

function segmentDistanceMeters(first: Segment, second: Segment): number {
  return Math.min(
    pointToSegmentDistanceMeters(first.from, second),
    pointToSegmentDistanceMeters(first.to, second),
    pointToSegmentDistanceMeters(second.from, first),
    pointToSegmentDistanceMeters(second.to, first),
  );
}

function lateralSeparationMeters(first: Segment, second: Segment): number {
  const point = midpoint(first);
  const referenceLatitude = point.lat;
  const referenceLongitude = point.lng;
  const projected = projectedPoint(point, referenceLatitude, referenceLongitude);
  const from = projectedPoint(second.from, referenceLatitude, referenceLongitude);
  const to = projectedPoint(second.to, referenceLatitude, referenceLongitude);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const denominator = Math.hypot(dx, dy);
  return denominator === 0
    ? Math.hypot(projected.x - from.x, projected.y - from.y)
    : Math.abs(dy * projected.x - dx * projected.y + to.x * from.y - to.y * from.x) / denominator;
}

function consumeComparison(work: WorkBudget): boolean {
  if (work.comparisons >= ROUTE_COHERENCE_MAX_COMPARISONS) {
    work.exceeded = true;
    return false;
  }
  work.comparisons += 1;
  return true;
}

function matchedSegments(
  routeSegments: Segment[],
  before: number[],
  after: number[],
  work: WorkBudget,
  instrumentation?: RouteCoherenceInstrumentation,
): Match[] {
  if (work.exceeded) return [];
  if (instrumentation) instrumentation.spatialBucketBuilds += 1;
  const referenceLatitude = routeSegments[0]?.from.lat ?? 0;
  const referenceLongitude = routeSegments[0]?.from.lng ?? 0;
  const effectiveBucketMeters = Math.max(
    SPATIAL_BUCKET_SIZE_METERS,
    ...routeSegments.map((segment) => segment.length),
  );
  const cell = (point: LatLng) => {
    const projected = projectedPoint(point, referenceLatitude, referenceLongitude);
    return {
      x: Math.floor(projected.x / effectiveBucketMeters),
      y: Math.floor(projected.y / effectiveBucketMeters),
    };
  };
  const buckets = new Map<string, number[]>();
  for (const index of after) {
    const segment = routeSegments[index];
    const from = cell(segment.from);
    const to = cell(segment.to);
    const minX = Math.min(from.x, to.x) - 1;
    const maxX = Math.max(from.x, to.x) + 1;
    const minY = Math.min(from.y, to.y) - 1;
    const maxY = Math.max(from.y, to.y) + 1;
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        const key = `${x}:${y}`;
        const values = buckets.get(key);
        if (values) values.push(index);
        else buckets.set(key, [index]);
      }
    }
  }

  const usedAfter = new Set<number>();
  const matches: Match[] = [];
  for (const firstIndex of before) {
    const first = routeSegments[firstIndex];
    const segmentMidpoint = midpoint(first);
    const endpoints = [cell(first.from), cell(segmentMidpoint), cell(first.to)];
    const candidates = new Set<number>();
    for (const endpoint of endpoints) {
      for (let x = endpoint.x - 1; x <= endpoint.x + 1; x += 1) {
        for (let y = endpoint.y - 1; y <= endpoint.y + 1; y += 1) {
          for (const candidate of buckets.get(`${x}:${y}`) ?? []) candidates.add(candidate);
        }
      }
    }
    for (const secondIndex of candidates) {
      if (!consumeComparison(work)) return matches;
      const second = routeSegments[secondIndex];
      if (
        usedAfter.has(secondIndex) ||
        second.progress <= first.progress ||
        !opposing(first.bearing, second.bearing) ||
        segmentDistanceMeters(first, second) > REVERSE_OVERLAP_TOLERANCE_METERS
      )
        continue;
      usedAfter.add(secondIndex);
      matches.push({
        firstIndex,
        secondIndex,
        distance: Math.min(first.length, second.length),
      });
      break;
    }
  }
  return matches;
}

function unavailableResult(
  status: Exclude<RouteShapeAnalysisStatus, "ANALYSED" | "TRUSTED_BASELINE">,
  legacy: boolean,
  sampledPointCount = 0,
  comparisons = 0,
): RouteCoherenceResult {
  return {
    routeShapeEligible: legacy,
    routeShapeRejectionReason:
      status === "MISSING_GEOMETRY"
        ? "MISSING_GEOMETRY"
        : status === "WORK_LIMIT_EXCEEDED"
          ? "ANALYSIS_WORK_LIMIT"
          : status === "GEOMETRY_LIMIT_EXCEEDED"
            ? "GEOMETRY_LIMIT_EXCEEDED"
            : status === "MALFORMED_GEOMETRY"
              ? "MALFORMED_GEOMETRY"
              : null,
    reverseOverlapDistanceMeters: 0,
    reverseOverlapRatio: 0,
    waypointSpurDetected: false,
    affectedWaypointIndex: null,
    waypointAssociationStatus: "UNAVAILABLE",
    routeShapeAnalysisStatus: status,
    sampledPointCount,
    spatialBucketComparisons: comparisons,
  };
}

function associationForWaypoint(
  waypoint: LatLng,
  sampled: LatLng[],
  pointProgress: number[],
  intervalMeters: number,
  work: WorkBudget,
): { status: WaypointAssociationStatus; pointIndex: number | null } {
  const distances: number[] = [];
  for (const point of sampled) {
    if (!consumeComparison(work)) return { status: "UNAVAILABLE", pointIndex: null };
    distances.push(haversineDistanceMeters(point, waypoint));
  }
  const minimum = Math.min(...distances);
  if (!Number.isFinite(minimum)) return { status: "UNAVAILABLE", pointIndex: null };
  const pointIndex = distances.indexOf(minimum);
  const nearIndexes = distances.flatMap((distance, index) =>
    distance <= minimum + intervalMeters ? [index] : [],
  );
  const ambiguous = nearIndexes.some(
    (index) =>
      Math.abs(pointProgress[index] - pointProgress[pointIndex]) >=
      MIN_RETRACE_PROGRESS_SEPARATION_METERS,
  );
  if (ambiguous) return { status: "AMBIGUOUS", pointIndex: null };
  if (minimum <= REVERSE_OVERLAP_TOLERANCE_METERS) return { status: "EXACT", pointIndex };
  if (minimum <= intervalMeters) return { status: "UNAMBIGUOUS", pointIndex };
  return { status: "APPROXIMATE", pointIndex: null };
}

const ASSOCIATION_CERTAINTY: Record<WaypointAssociationStatus, number> = {
  EXACT: 0,
  UNAMBIGUOUS: 1,
  APPROXIMATE: 2,
  AMBIGUOUS: 3,
  UNAVAILABLE: 4,
};

function leastCertainAssociation(
  current: WaypointAssociationStatus | null,
  next: WaypointAssociationStatus,
): WaypointAssociationStatus {
  return current == null || ASSOCIATION_CERTAINTY[next] > ASSOCIATION_CERTAINTY[current]
    ? next
    : current;
}

/**
 * Unique retraced road distance. Each spatially equivalent segment group is represented by its
 * earliest travelled progress interval; overlapping/adjacent representatives are then unioned.
 */
function uniqueRetracedRoadDistance(routeSegments: Segment[], matches: Match[]): number {
  const parent = new Map<number, number>();
  const find = (value: number): number => {
    const existing = parent.get(value) ?? value;
    if (existing === value) return value;
    const root = find(existing);
    parent.set(value, root);
    return root;
  };
  for (const match of matches) {
    parent.set(match.firstIndex, parent.get(match.firstIndex) ?? match.firstIndex);
    parent.set(match.secondIndex, parent.get(match.secondIndex) ?? match.secondIndex);
    const firstRoot = find(match.firstIndex);
    const secondRoot = find(match.secondIndex);
    if (firstRoot !== secondRoot)
      parent.set(Math.max(firstRoot, secondRoot), Math.min(firstRoot, secondRoot));
  }
  const groups = new Map<number, number[]>();
  for (const index of parent.keys()) {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), index]);
  }
  const intervals = [...groups.values()]
    .flatMap((indexes) => {
      const sorted = [...indexes].sort((first, second) => first - second);
      const runs: number[][] = [];
      for (const index of sorted) {
        const run = runs.at(-1);
        if (run && index <= run.at(-1)! + 1) run.push(index);
        else runs.push([index]);
      }
      const representativeRun = runs[0];
      if (!representativeRun) return [];
      const first = representativeRun[0];
      const last = representativeRun.at(-1)!;
      return [
        {
          start: routeSegments[first].progress,
          end: routeSegments[last].progress + routeSegments[last].length,
        },
      ];
    })
    .sort((first, second) => first.start - second.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const prior = merged.at(-1);
    if (prior && interval.start <= prior.end + 0.01) prior.end = Math.max(prior.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged.reduce((sum, interval) => sum + interval.end - interval.start, 0);
}

function midpoint(segment: Segment): LatLng {
  return {
    lat: (segment.from.lat + segment.to.lat) / 2,
    lng: normaliseLongitude(
      segment.from.lng + shortestLongitudeDelta(segment.from.lng, segment.to.lng) / 2,
    ),
  };
}

/**
 * Geometry cannot prove road identity. Sustained, consistently offset opposing traces in the
 * carriageway ambiguity band therefore do not contribute to aggregate reverse-distance rejection.
 */
function unambiguousRetraceMatches(routeSegments: Segment[], matches: Match[]): Match[] {
  const sorted = [...matches].sort(
    (first, second) =>
      first.firstIndex - second.firstIndex || first.secondIndex - second.secondIndex,
  );
  const suppressed = new Set<Match>();
  let run: Match[] = [];
  let minimumSeparation = Number.POSITIVE_INFINITY;
  let maximumSeparation = Number.NEGATIVE_INFINITY;
  const finishRun = () => {
    const length = run.reduce((sum, match) => sum + match.distance, 0);
    if (length >= PARALLEL_TRACE_MIN_LENGTH_METERS) for (const match of run) suppressed.add(match);
    run = [];
    minimumSeparation = Number.POSITIVE_INFINITY;
    maximumSeparation = Number.NEGATIVE_INFINITY;
  };
  for (const match of sorted) {
    const separation = lateralSeparationMeters(
      routeSegments[match.firstIndex],
      routeSegments[match.secondIndex],
    );
    const prior = run.at(-1);
    const inBand =
      separation >= PARALLEL_TRACE_MIN_SEPARATION_METERS &&
      separation <= PARALLEL_TRACE_MAX_SEPARATION_METERS;
    const continuous =
      !prior ||
      routeSegments[match.firstIndex].progress - routeSegments[prior.firstIndex].progress <=
        Math.max(routeSegments[match.firstIndex].length, routeSegments[prior.firstIndex].length) *
          4.1;
    const nextMinimum = Math.min(minimumSeparation, separation);
    const nextMaximum = Math.max(maximumSeparation, separation);
    if (!inBand || !continuous || nextMaximum - nextMinimum > PARALLEL_TRACE_MAX_VARIATION_METERS)
      finishRun();
    if (inBand) {
      run.push(match);
      minimumSeparation = Math.min(minimumSeparation, separation);
      maximumSeparation = Math.max(maximumSeparation, separation);
    }
  }
  finishRun();
  return matches.filter((match) => !suppressed.has(match));
}

function pointIndexAtProgress(pointProgress: number[], target: number): number {
  return pointProgress.reduce(
    (best, progress, index) =>
      Math.abs(progress - target) < Math.abs(pointProgress[best] - target) ? index : best,
    0,
  );
}

function hasDirectionalCorridorReturn(input: {
  sampled: LatLng[];
  pointProgress: number[];
  waypoint: LatLng;
  waypointPointIndex: number;
  work: WorkBudget;
  instrumentation?: RouteCoherenceInstrumentation;
}): boolean {
  const { sampled, pointProgress, waypoint, waypointPointIndex, work, instrumentation } = input;
  if (work.exceeded) return false;
  const waypointProgress = pointProgress[waypointPointIndex];
  const approachIndex = pointIndexAtProgress(
    pointProgress,
    Math.max(0, waypointProgress - MIN_WAYPOINT_OFFSET_FROM_JUNCTION_METERS),
  );
  const departureIndex = pointIndexAtProgress(
    pointProgress,
    waypointProgress + MIN_WAYPOINT_OFFSET_FROM_JUNCTION_METERS,
  );
  if (
    approachIndex === waypointPointIndex ||
    departureIndex === waypointPointIndex ||
    !opposing(
      bearingDegrees(sampled[approachIndex], sampled[waypointPointIndex]),
      bearingDegrees(sampled[waypointPointIndex], sampled[departureIndex]),
    )
  )
    return false;

  const before = sampled.flatMap((_, index) =>
    pointProgress[index] < waypointProgress &&
    waypointProgress - pointProgress[index] <= WAYPOINT_RETRACE_WINDOW_METERS
      ? [index]
      : [],
  );
  const after = sampled.flatMap((_, index) =>
    pointProgress[index] > waypointProgress &&
    pointProgress[index] - waypointProgress <= WAYPOINT_RETRACE_WINDOW_METERS
      ? [index]
      : [],
  );
  const afterBuckets = new Map<string, number[]>();
  if (instrumentation) instrumentation.spatialBucketBuilds += 1;
  const bucket = (point: LatLng) => {
    const projected = projectedPoint(point, waypoint.lat, waypoint.lng);
    return {
      x: Math.floor(projected.x / CORRIDOR_RETURN_TOLERANCE_METERS),
      y: Math.floor(projected.y / CORRIDOR_RETURN_TOLERANCE_METERS),
    };
  };
  for (const index of after) {
    const key = bucket(sampled[index]);
    const bucketKey = `${key.x}:${key.y}`;
    const values = afterBuckets.get(bucketKey);
    if (values) values.push(index);
    else afterBuckets.set(bucketKey, [index]);
  }
  for (const beforeIndex of before) {
    const key = bucket(sampled[beforeIndex]);
    for (let x = key.x - 1; x <= key.x + 1; x += 1) {
      for (let y = key.y - 1; y <= key.y + 1; y += 1) {
        for (const afterIndex of afterBuckets.get(`${x}:${y}`) ?? []) {
          if (!consumeComparison(work)) return false;
          if (
            pointProgress[afterIndex] - pointProgress[beforeIndex] >=
              MIN_WAYPOINT_LOOP_DISTANCE_METERS &&
            haversineDistanceMeters(sampled[beforeIndex], sampled[afterIndex]) <=
              CORRIDOR_RETURN_TOLERANCE_METERS &&
            haversineDistanceMeters(sampled[beforeIndex], waypoint) >=
              MIN_WAYPOINT_OFFSET_FROM_JUNCTION_METERS
          )
            return true;
        }
      }
    }
  }
  return false;
}

export function evaluateRouteCoherence(
  encodedPolyline: string | null | undefined,
  waypoints: LatLng[] = [],
  options: { legacy?: boolean } = {},
): RouteCoherenceResult {
  // Tests may attach this private structural hook through an explicit cast; production callers
  // cannot see or supply it through the public options type.
  const instrumentation = (options as { instrumentation?: RouteCoherenceInstrumentation })
    .instrumentation;
  const legacy = options.legacy === true;
  if (!encodedPolyline)
    return unavailableResult(legacy ? "LEGACY_UNAVAILABLE" : "MISSING_GEOMETRY", legacy);
  if (encodedPolyline.length > ROUTE_COHERENCE_MAX_ENCODED_CHARACTERS)
    return unavailableResult("GEOMETRY_LIMIT_EXCEEDED", false);
  let decoded: LatLng[];
  try {
    decoded = decodeBoundedPolyline(encodedPolyline);
  } catch (error) {
    if (error instanceof GeometryLimitError)
      return unavailableResult("GEOMETRY_LIMIT_EXCEEDED", false);
    return unavailableResult(legacy ? "LEGACY_UNAVAILABLE" : "MALFORMED_GEOMETRY", legacy);
  }
  if (
    decoded.length < MIN_ANALYSABLE_ROUTE_POINTS ||
    decoded.some(
      (point) =>
        !Number.isFinite(point.lat) ||
        !Number.isFinite(point.lng) ||
        Math.abs(point.lat) > 90 ||
        Math.abs(point.lng) > 180,
    )
  )
    return unavailableResult(legacy ? "LEGACY_UNAVAILABLE" : "MALFORMED_GEOMETRY", legacy);

  const sampledResult = resample(decoded);
  const sampled = sampledResult.points;
  const routeSegments = segments(sampled);
  const totalDistance = routeSegments.reduce((sum, segment) => sum + segment.length, 0);
  if (routeSegments.length < 2 || !Number.isFinite(totalDistance) || totalDistance <= 0)
    return unavailableResult(
      legacy ? "LEGACY_UNAVAILABLE" : "MALFORMED_GEOMETRY",
      legacy,
      sampled.length,
    );

  const work: WorkBudget = { comparisons: 0, exceeded: false };
  const pointProgress = [0, ...routeSegments.map((segment) => segment.progress + segment.length)];
  const uniqueMatches = new Map<string, Match>();
  let largestWaypointOverlap = 0;
  let waypointSpurIndex: number | null = null;
  let waypointSpurDetected = false;
  let associationStatus: WaypointAssociationStatus | null = null;

  for (const [waypointIndex, waypoint] of waypoints.entries()) {
    const association = associationForWaypoint(
      waypoint,
      sampled,
      pointProgress,
      sampledResult.intervalMeters,
      work,
    );
    associationStatus = leastCertainAssociation(associationStatus, association.status);
    if (work.exceeded)
      return unavailableResult("WORK_LIMIT_EXCEEDED", false, sampled.length, work.comparisons);
    if (association.pointIndex == null) continue;
    const waypointProgress = pointProgress[association.pointIndex];
    const before = routeSegments.flatMap((segment, index) =>
      segment.progress < waypointProgress &&
      waypointProgress - segment.progress <= WAYPOINT_RETRACE_WINDOW_METERS
        ? [index]
        : [],
    );
    const after = routeSegments.flatMap((segment, index) =>
      segment.progress >= waypointProgress &&
      segment.progress - waypointProgress <= WAYPOINT_RETRACE_WINDOW_METERS
        ? [index]
        : [],
    );
    const matches = matchedSegments(routeSegments, before, after, work, instrumentation);
    if (work.exceeded)
      return unavailableResult("WORK_LIMIT_EXCEEDED", false, sampled.length, work.comparisons);
    const localRetraceMatches = unambiguousRetraceMatches(routeSegments, matches);
    const localPairs = new Map<string, Match>();
    for (const match of matches) {
      const key = `${Math.min(match.firstIndex, match.secondIndex)}:${Math.max(match.firstIndex, match.secondIndex)}`;
      localPairs.set(key, match);
      uniqueMatches.set(key, match);
    }
    const localOverlap = localRetraceMatches.reduce((sum, match) => sum + match.distance, 0);
    if (localOverlap > largestWaypointOverlap) largestWaypointOverlap = localOverlap;
    const directionalReturn = hasDirectionalCorridorReturn({
      sampled,
      pointProgress,
      waypoint,
      waypointPointIndex: association.pointIndex,
      work,
      instrumentation,
    });
    if (work.exceeded)
      return unavailableResult("WORK_LIMIT_EXCEEDED", false, sampled.length, work.comparisons);
    if (
      directionalReturn ||
      (localOverlap > SHORT_ACCESS_ROAD_EXEMPTION_METERS &&
        localOverlap >= MATERIAL_WAYPOINT_SPUR_METERS)
    ) {
      waypointSpurDetected = true;
      waypointSpurIndex ??= waypointIndex;
    }
  }

  if (work.exceeded)
    return unavailableResult("WORK_LIMIT_EXCEEDED", false, sampled.length, work.comparisons);
  if (instrumentation) instrumentation.wholeRouteIndexBuilds += 1;
  const allIndexes = routeSegments.map((_, index) => index);
  for (const match of matchedSegments(
    routeSegments,
    allIndexes,
    allIndexes,
    work,
    instrumentation,
  )) {
    const key = `${Math.min(match.firstIndex, match.secondIndex)}:${Math.max(match.firstIndex, match.secondIndex)}`;
    uniqueMatches.set(key, match);
  }
  if (work.exceeded)
    return unavailableResult("WORK_LIMIT_EXCEEDED", false, sampled.length, work.comparisons);

  const reverseOverlapDistanceMeters = Math.round(
    uniqueRetracedRoadDistance(
      routeSegments,
      unambiguousRetraceMatches(routeSegments, [...uniqueMatches.values()]),
    ),
  );
  const reverseOverlapRatio =
    Math.round((reverseOverlapDistanceMeters / totalDistance) * 1_000) / 1_000;
  const aggregateRetrace =
    reverseOverlapDistanceMeters >= MATERIAL_AGGREGATE_RETRACE_METERS ||
    (reverseOverlapDistanceMeters >= MIN_REVERSE_OVERLAP_DISTANCE_METERS &&
      reverseOverlapRatio > MAX_ALLOWED_REVERSE_OVERLAP_RATIO);
  return {
    routeShapeEligible: !waypointSpurDetected && !aggregateRetrace,
    routeShapeRejectionReason: waypointSpurDetected
      ? "WAYPOINT_SPUR"
      : aggregateRetrace
        ? "MATERIAL_REVERSE_RETRACE"
        : null,
    reverseOverlapDistanceMeters,
    reverseOverlapRatio,
    waypointSpurDetected,
    affectedWaypointIndex: waypointSpurDetected ? waypointSpurIndex : null,
    waypointAssociationStatus: associationStatus ?? "UNAVAILABLE",
    routeShapeAnalysisStatus: "ANALYSED",
    sampledPointCount: sampled.length,
    spatialBucketComparisons: work.comparisons,
  };
}

export function safeEvaluateRouteCoherence(
  encodedPolyline: string | null | undefined,
  waypoints: LatLng[] = [],
  options: { legacy?: boolean } = {},
  evaluator: typeof evaluateRouteCoherence = evaluateRouteCoherence,
): RouteCoherenceResult {
  try {
    return evaluator(encodedPolyline, waypoints, options);
  } catch {
    const legacy = options.legacy === true;
    return unavailableResult(legacy ? "LEGACY_UNAVAILABLE" : "MALFORMED_GEOMETRY", legacy);
  }
}

const ROUTE_ANCHOR_TOLERANCE_METERS = 1_000;
const DESTINATION_ENDPOINT_TOLERANCE_METERS = 1_000;
const PREMATURE_DESTINATION_RADIUS_METERS = 250;
const MATERIAL_REMAINING_AFTER_DESTINATION_METERS = 5_000;
const MATERIAL_DEPARTURE_FROM_DESTINATION_METERS = 1_500;
const MIN_DISTINCT_ANCHOR_PROGRESS_METERS = 100;

/** Validates the exact submitted request order against returned travelled geometry. */
export function validateRouteAnchorSequence(
  encodedPolyline: string | null | undefined,
  expectedAnchors: LatLng[],
): RouteAnchorValidationResult {
  if (!encodedPolyline || expectedAnchors.length < 2)
    return { eligible: false, rejectionReason: "ANCHOR_ORDER_INVALID", matchedAnchorCount: 0 };
  let decoded: LatLng[];
  try {
    decoded = decodeBoundedPolyline(encodedPolyline);
  } catch {
    return { eligible: false, rejectionReason: "ANCHOR_ORDER_INVALID", matchedAnchorCount: 0 };
  }
  if (
    decoded.length < 2 ||
    expectedAnchors.some(
      (point) =>
        !Number.isFinite(point.lat) ||
        !Number.isFinite(point.lng) ||
        Math.abs(point.lat) > 90 ||
        Math.abs(point.lng) > 180,
    )
  )
    return { eligible: false, rejectionReason: "ANCHOR_ORDER_INVALID", matchedAnchorCount: 0 };
  const sampled = resample(decoded).points;
  const progress = [0];
  for (let index = 1; index < sampled.length; index += 1)
    progress.push(
      progress[index - 1] + haversineDistanceMeters(sampled[index - 1], sampled[index]),
    );
  const matches = expectedAnchors.map((anchor) => {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    sampled.forEach((point, index) => {
      const distance = haversineDistanceMeters(point, anchor);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    return { index: bestIndex, distance: bestDistance, progress: progress[bestIndex] };
  });
  for (let index = 0; index < matches.length; index += 1) {
    if (matches[index].distance > ROUTE_ANCHOR_TOLERANCE_METERS)
      return {
        eligible: false,
        rejectionReason:
          index === matches.length - 1 ? "DESTINATION_TERMINATION_INVALID" : "ANCHOR_ORDER_INVALID",
        matchedAnchorCount: index,
      };
    if (index > 0) {
      const distinct =
        haversineDistanceMeters(expectedAnchors[index - 1], expectedAnchors[index]) >
        ROUTE_ANCHOR_TOLERANCE_METERS;
      if (
        matches[index].progress < matches[index - 1].progress ||
        (distinct &&
          matches[index].progress - matches[index - 1].progress <
            MIN_DISTINCT_ANCHOR_PROGRESS_METERS)
      )
        return {
          eligible: false,
          rejectionReason: "ANCHOR_ORDER_INVALID",
          matchedAnchorCount: index,
        };
    }
  }
  const destination = expectedAnchors.at(-1)!;
  if (haversineDistanceMeters(sampled.at(-1)!, destination) > DESTINATION_ENDPOINT_TOLERANCE_METERS)
    return {
      eligible: false,
      rejectionReason: "DESTINATION_TERMINATION_INVALID",
      matchedAnchorCount: matches.length - 1,
    };
  const totalDistance = progress.at(-1)!;
  for (let index = 0; index < sampled.length; index += 1) {
    if (
      haversineDistanceMeters(sampled[index], destination) <= PREMATURE_DESTINATION_RADIUS_METERS &&
      totalDistance - progress[index] >= MATERIAL_REMAINING_AFTER_DESTINATION_METERS &&
      sampled
        .slice(index + 1)
        .some(
          (point) =>
            haversineDistanceMeters(point, destination) >=
            MATERIAL_DEPARTURE_FROM_DESTINATION_METERS,
        )
    )
      return {
        eligible: false,
        rejectionReason: "DESTINATION_TERMINATION_INVALID",
        matchedAnchorCount: matches.length,
      };
  }
  return { eligible: true, rejectionReason: null, matchedAnchorCount: matches.length };
}

export function safeEvaluateRouteCoherenceWithAnchors(
  encodedPolyline: string | null | undefined,
  shapingWaypoints: LatLng[],
  expectedAnchors: LatLng[],
): RouteCoherenceResult {
  const coherence = safeEvaluateRouteCoherence(encodedPolyline, shapingWaypoints);
  if (!coherence.routeShapeEligible) return coherence;
  try {
    const anchors = validateRouteAnchorSequence(encodedPolyline, expectedAnchors);
    return anchors.eligible
      ? coherence
      : {
          ...coherence,
          routeShapeEligible: false,
          routeShapeRejectionReason: anchors.rejectionReason,
        };
  } catch {
    return {
      ...coherence,
      routeShapeEligible: false,
      routeShapeRejectionReason: "ANCHOR_ORDER_INVALID",
    };
  }
}
