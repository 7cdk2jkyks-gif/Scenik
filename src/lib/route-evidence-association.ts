import {
  EMPTY_SCENIC_EVIDENCE,
  evidenceForRoute,
  haversineDistanceMeters,
  type LatLng,
  type ScenicEvidenceCounts,
  type ScenicPlace,
} from "./scenic-waypoint";

/** Uniform spacing keeps association independent of provider vertex density. */
export const EVIDENCE_ROUTE_SAMPLE_SPACING_METERS = 500;
/** A 2,000 km route fits at the normal spacing before deterministic reduction. */
export const EVIDENCE_ROUTE_MAX_SAMPLES = 4_000;
export const EVIDENCE_ROUTE_MAX_DECODED_POINTS = 100_000;
export const EVIDENCE_ROUTE_MAX_ENCODED_CHARACTERS = 1_000_000;
/** Product corridor plans contain at most two verified inserted waypoints. */
export const EVIDENCE_ASSOCIATION_MAX_WAYPOINTS = 2;
/** The shared discovery pool is capped at 70 unique Places. */
export const EVIDENCE_ASSOCIATION_MAX_PLACES = 70;
export const EVIDENCE_ASSOCIATION_MAX_PROXIMITY_METERS = 750;
/** Scan at most this many raw inputs while collecting 70 unique valid Places. */
export const EVIDENCE_ASSOCIATION_MAX_PLACE_INPUTS = 700;
/** One candidate-local ceiling for exact segment, waypoint, and classification comparisons. */
export const EVIDENCE_ASSOCIATION_MAX_COMPARISONS = 300_000;
/** Mean spherical Earth radius used by both association geometry and its ECEF index. */
export const EVIDENCE_EARTH_RADIUS_METERS = 6_371_000;
export const EVIDENCE_INDEX_CELL_SIZE_METERS = 1_000;
export const EVIDENCE_INDEX_SEGMENT_SAMPLE_SPACING_METERS = 250;
export const EVIDENCE_INDEX_MAX_CELLS = 100_000;
export const EVIDENCE_INDEX_MAX_REFERENCES = 500_000;
export const EVIDENCE_INDEX_MAX_CONSTRUCTION_WORK = 500_000;
export const EVIDENCE_INDEX_MAX_QUERY_REFERENCES = 50_000;
export const EVIDENCE_INDEX_MAX_QUERY_SEGMENTS = 20_000;
/** Arcs shorter than about 0.64 mm are endpoint-like at the chosen Earth radius. */
export const EVIDENCE_DEGENERATE_SEGMENT_ANGLE_RADIANS = 1e-10;
/** Arcs within about 6.4 cm of antipodal have no numerically stable unique minor arc. */
export const EVIDENCE_ANTIPODAL_ANGLE_TOLERANCE_RADIANS = 1e-8;
/** Reject normalization below this dimensionless vector magnitude. */
export const EVIDENCE_VECTOR_NORMALISATION_TOLERANCE = 1e-15;
/** About 0.64 mm of angular slack for bounded-arc membership calculations. */
export const EVIDENCE_ARC_CONTAINMENT_TOLERANCE_RADIANS = 1e-10;
/** One micrometre of inclusive threshold slack for floating-point surface distances. */
export const EVIDENCE_DISTANCE_EPSILON_METERS = 1e-6;

export type EvidenceAssociationStatus =
  | "ANALYSED"
  | "MISSING_GEOMETRY"
  | "MALFORMED_GEOMETRY"
  | "GEOMETRY_LIMIT_EXCEEDED"
  | "SAMPLE_LIMIT_EXCEEDED"
  | "INDEX_LIMIT_EXCEEDED"
  | "ASSOCIATION_FAILED"
  | "WORK_LIMIT_EXCEEDED";

export type EvidenceAssociationResult = {
  evidence: ScenicEvidenceCounts;
  geometryDistanceMeters: number;
  sampleCount: number;
  evidenceConsidered: number;
  evidenceMatchedToGeometry: number;
  evidenceMatchedThroughWaypoints: number;
  comparisons: number;
  status: EvidenceAssociationStatus;
  /** Internal, candidate-local evidence. Never copied into diagnostics. */
  matchedGeometryPlaces: Array<
    ScenicPlace & { routeProgress: number; distanceToRouteMeters: number }
  >;
};

class GeometryLimitError extends Error {}
class GeometryModelError extends Error {}

function normaliseLongitude(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

function decodePolyline(encoded: string): LatLng[] {
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
    if (points.length >= EVIDENCE_ROUTE_MAX_DECODED_POINTS) throw new GeometryLimitError();
    const point = { lat: lat * 1e-5, lng: normaliseLongitude(lng * 1e-5) };
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng) || Math.abs(point.lat) > 90)
      throw new Error("MALFORMED_POLYLINE");
    points.push(point);
  }
  return points;
}

function fixedSpacingGeometrySummary(points: LatLng[]): {
  sampleCount: number;
  distanceMeters: number;
} {
  const lengths = points
    .slice(1)
    .map((point, index) => haversineDistanceMeters(points[index], point));
  const distanceMeters = lengths.reduce((sum, length) => sum + length, 0);
  if (distanceMeters <= 0) return { sampleCount: 1, distanceMeters: 0 };
  return {
    sampleCount: Math.ceil(distanceMeters / EVIDENCE_ROUTE_SAMPLE_SPACING_METERS) + 1,
    distanceMeters,
  };
}

type UnitVector = [number, number, number];

const clampUnit = (value: number) => Math.max(-1, Math.min(1, value));
const dot = (first: UnitVector, second: UnitVector) =>
  first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
const cross = (first: UnitVector, second: UnitVector): UnitVector => [
  first[1] * second[2] - first[2] * second[1],
  first[2] * second[0] - first[0] * second[2],
  first[0] * second[1] - first[1] * second[0],
];
const magnitude = (vector: UnitVector) => Math.hypot(...vector);
const normaliseVector = (vector: UnitVector): UnitVector => {
  const length = magnitude(vector);
  if (!Number.isFinite(length) || length < EVIDENCE_VECTOR_NORMALISATION_TOLERANCE)
    throw new GeometryModelError();
  return [vector[0] / length, vector[1] / length, vector[2] / length];
};
const scaleVector = (vector: UnitVector, scale: number): UnitVector => [
  vector[0] * scale,
  vector[1] * scale,
  vector[2] * scale,
];
const addVectors = (first: UnitVector, second: UnitVector): UnitVector => [
  first[0] + second[0],
  first[1] + second[1],
  first[2] + second[2],
];

function unitVector(point: LatLng): UnitVector {
  const latitude = (point.lat * Math.PI) / 180;
  const longitude = (normaliseLongitude(point.lng) * Math.PI) / 180;
  const cosLatitude = Math.cos(latitude);
  return [cosLatitude * Math.cos(longitude), cosLatitude * Math.sin(longitude), Math.sin(latitude)];
}

const centralAngle = (first: UnitVector, second: UnitVector) => {
  const crossMagnitude = magnitude(cross(first, second));
  const clampedDot = clampUnit(dot(first, second));
  if (!Number.isFinite(crossMagnitude) || !Number.isFinite(clampedDot))
    throw new GeometryModelError();
  const angle = Math.atan2(crossMagnitude, clampedDot);
  if (!Number.isFinite(angle)) throw new GeometryModelError();
  return angle;
};

function segmentArc(from: LatLng, to: LatLng) {
  const start = unitVector(from);
  const end = unitVector(to);
  const angle = centralAngle(start, end);
  // Antipodal endpoints do not define one stable minor arc. Provider road segments never need
  // this ambiguity, so fail closed rather than choosing a direction from floating-point noise.
  if (Math.PI - angle <= EVIDENCE_ANTIPODAL_ANGLE_TOLERANCE_RADIANS) throw new GeometryModelError();
  return {
    angle,
    degenerate: angle <= EVIDENCE_DEGENERATE_SEGMENT_ANGLE_RADIANS,
    end,
    start,
  };
}

function interpolateMinorArc(arc: ReturnType<typeof segmentArc>, fraction: number): UnitVector {
  if (arc.degenerate)
    return normaliseVector(
      addVectors(scaleVector(arc.start, 1 - fraction), scaleVector(arc.end, fraction)),
    );
  const denominator = Math.sin(arc.angle);
  if (
    !Number.isFinite(denominator) ||
    Math.abs(denominator) < EVIDENCE_VECTOR_NORMALISATION_TOLERANCE
  )
    throw new GeometryModelError();
  return normaliseVector(
    addVectors(
      scaleVector(arc.start, Math.sin((1 - fraction) * arc.angle) / denominator),
      scaleVector(arc.end, Math.sin(fraction * arc.angle) / denominator),
    ),
  );
}

type SegmentProjection = { distanceMeters: number; fraction: number };

/** Physical surface projection onto the bounded minor-great-circle arc travelled by a segment. */
function sphericalPointToSegmentProjection(
  point: LatLng,
  from: LatLng,
  to: LatLng,
): SegmentProjection {
  const target = unitVector(point);
  const arc = segmentArc(from, to);
  if (arc.degenerate)
    return {
      distanceMeters: centralAngle(target, arc.start) * EVIDENCE_EARTH_RADIUS_METERS,
      fraction: 0,
    };
  const normal = normaliseVector(cross(arc.start, arc.end));
  const projected = addVectors(target, scaleVector(normal, -dot(target, normal)));
  const startDistance = centralAngle(target, arc.start);
  const endDistance = centralAngle(target, arc.end);
  let closestDistance = Math.min(startDistance, endDistance);
  let fraction = startDistance <= endDistance ? 0 : 1;
  if (magnitude(projected) >= EVIDENCE_VECTOR_NORMALISATION_TOLERANCE) {
    const firstProjection = normaliseVector(projected);
    for (const candidate of [firstProjection, scaleVector(firstProjection, -1) as UnitVector]) {
      const travelledAngle = centralAngle(arc.start, candidate);
      const coveredAngle = travelledAngle + centralAngle(candidate, arc.end);
      const candidateDistance = centralAngle(target, candidate);
      if (
        coveredAngle <= arc.angle + EVIDENCE_ARC_CONTAINMENT_TOLERANCE_RADIANS &&
        candidateDistance < closestDistance
      ) {
        closestDistance = candidateDistance;
        fraction = Math.max(0, Math.min(1, travelledAngle / arc.angle));
      }
    }
  }
  const distance = closestDistance * EVIDENCE_EARTH_RADIUS_METERS;
  if (!Number.isFinite(distance) || !Number.isFinite(fraction)) throw new GeometryModelError();
  return { distanceMeters: Math.max(0, distance), fraction: Math.max(0, Math.min(1, fraction)) };
}

/** Physical surface distance to the bounded minor-great-circle arc travelled by a segment. */
export function sphericalPointToSegmentDistanceMeters(
  point: LatLng,
  from: LatLng,
  to: LatLng,
): number {
  return sphericalPointToSegmentProjection(point, from, to).distanceMeters;
}

type Segment = { from: LatLng; to: LatLng };
type IndexLimits = {
  maximumCells: number;
  maximumReferences: number;
  maximumConstructionWork: number;
  maximumQueryReferences: number;
  maximumQuerySegments: number;
};

class IndexLimitError extends Error {}

function earthCell(point: LatLng | UnitVector): [number, number, number] {
  const vector = Array.isArray(point) ? point : unitVector(point);
  return [
    Math.floor((EVIDENCE_EARTH_RADIUS_METERS * vector[0]) / EVIDENCE_INDEX_CELL_SIZE_METERS),
    Math.floor((EVIDENCE_EARTH_RADIUS_METERS * vector[1]) / EVIDENCE_INDEX_CELL_SIZE_METERS),
    Math.floor((EVIDENCE_EARTH_RADIUS_METERS * vector[2]) / EVIDENCE_INDEX_CELL_SIZE_METERS),
  ];
}

const cellKey = (cell: [number, number, number]) => cell.join(":");

function buildSegmentIndex(points: LatLng[], limits: IndexLimits) {
  const segments: Segment[] = [];
  const buckets = new Map<string, number[]>();
  let constructionWork = 0;
  let references = 0;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    const segmentIndex = segments.length;
    segments.push({ from, to });
    const arc = segmentArc(from, to);
    const length = arc.angle * EVIDENCE_EARTH_RADIUS_METERS;
    const sampleIntervals = arc.degenerate
      ? 0
      : Math.max(1, Math.ceil(length / EVIDENCE_INDEX_SEGMENT_SAMPLE_SPACING_METERS));
    const segmentCells = new Set<string>();
    for (let sample = 0; sample <= sampleIntervals; sample += 1) {
      if (constructionWork >= limits.maximumConstructionWork) throw new IndexLimitError();
      constructionWork += 1;
      const fraction = sampleIntervals === 0 ? 0 : sample / sampleIntervals;
      segmentCells.add(cellKey(earthCell(interpolateMinorArc(arc, fraction))));
    }
    for (const key of segmentCells) {
      if (!buckets.has(key) && buckets.size >= limits.maximumCells) throw new IndexLimitError();
      if (references >= limits.maximumReferences) throw new IndexLimitError();
      references += 1;
      const bucket = buckets.get(key) ?? [];
      bucket.push(segmentIndex);
      buckets.set(key, bucket);
    }
  }
  return { buckets, constructionWork, references, segments };
}

function nearbySegmentIndexes(
  point: LatLng,
  index: ReturnType<typeof buildSegmentIndex>,
  limits: IndexLimits,
): number[] {
  const origin = earthCell(point);
  const candidates = new Set<number>();
  let queryReferences = 0;
  for (let x = -1; x <= 1; x += 1) {
    for (let y = -1; y <= 1; y += 1) {
      for (let z = -1; z <= 1; z += 1) {
        const bucket = index.buckets.get(cellKey([origin[0] + x, origin[1] + y, origin[2] + z]));
        if (!bucket) continue;
        for (const segmentIndex of bucket) {
          if (queryReferences >= limits.maximumQueryReferences) throw new IndexLimitError();
          queryReferences += 1;
          if (!candidates.has(segmentIndex)) {
            if (candidates.size >= limits.maximumQuerySegments) throw new IndexLimitError();
            candidates.add(segmentIndex);
          }
        }
      }
    }
  }
  return [...candidates].sort((first, second) => first - second);
}

const emptyResult = (
  status: EvidenceAssociationStatus,
  evidenceConsidered = 0,
): EvidenceAssociationResult => ({
  evidence: { ...EMPTY_SCENIC_EVIDENCE },
  geometryDistanceMeters: 0,
  sampleCount: 0,
  evidenceConsidered,
  evidenceMatchedToGeometry: 0,
  evidenceMatchedThroughWaypoints: 0,
  comparisons: 0,
  status,
  matchedGeometryPlaces: [],
});

export function associateEvidenceWithRoute(input: {
  encodedPolyline: string | null | undefined;
  places: ScenicPlace[];
  waypoints?: LatLng[];
  proximityMeters: number;
  maximumComparisons?: number;
  indexLimits?: Partial<IndexLimits>;
}): EvidenceAssociationResult {
  const validCoordinate = (value: LatLng) =>
    Number.isFinite(value.lat) &&
    Number.isFinite(value.lng) &&
    Math.abs(value.lat) <= 90 &&
    Math.abs(value.lng) <= 180;
  const uniquePlaces: ScenicPlace[] = [];
  const placeIds = new Set<string>();
  for (const place of input.places.slice(0, EVIDENCE_ASSOCIATION_MAX_PLACE_INPUTS)) {
    if (uniquePlaces.length >= EVIDENCE_ASSOCIATION_MAX_PLACES) break;
    if (
      !validCoordinate(place) ||
      typeof place.id !== "string" ||
      !place.id.trim() ||
      place.id.length > 256 ||
      typeof place.primaryType !== "string" ||
      !Array.isArray(place.types) ||
      place.types.some((type) => typeof type !== "string") ||
      placeIds.has(place.id)
    )
      continue;
    placeIds.add(place.id);
    uniquePlaces.push({ ...place, types: [...place.types] });
  }
  if (
    !Number.isFinite(input.proximityMeters) ||
    input.proximityMeters < 0 ||
    input.proximityMeters > EVIDENCE_ASSOCIATION_MAX_PROXIMITY_METERS
  )
    return emptyResult("ASSOCIATION_FAILED", uniquePlaces.length);
  if (!input.encodedPolyline) return emptyResult("MISSING_GEOMETRY", uniquePlaces.length);
  if (input.encodedPolyline.length > EVIDENCE_ROUTE_MAX_ENCODED_CHARACTERS)
    return emptyResult("GEOMETRY_LIMIT_EXCEEDED", uniquePlaces.length);
  let decoded: LatLng[];
  try {
    decoded = decodePolyline(input.encodedPolyline);
  } catch (error) {
    return emptyResult(
      error instanceof GeometryLimitError ? "GEOMETRY_LIMIT_EXCEEDED" : "MALFORMED_GEOMETRY",
      uniquePlaces.length,
    );
  }
  if (decoded.length < 2) return emptyResult("MALFORMED_GEOMETRY", uniquePlaces.length);
  const geometry = fixedSpacingGeometrySummary(decoded);
  if (geometry.sampleCount > EVIDENCE_ROUTE_MAX_SAMPLES)
    return {
      ...emptyResult("SAMPLE_LIMIT_EXCEEDED", uniquePlaces.length),
      geometryDistanceMeters: Math.round(geometry.distanceMeters),
      sampleCount: geometry.sampleCount,
    };
  const waypoints = input.waypoints ?? [];
  if (waypoints.length > EVIDENCE_ASSOCIATION_MAX_WAYPOINTS)
    return {
      ...emptyResult("ASSOCIATION_FAILED", uniquePlaces.length),
      geometryDistanceMeters: Math.round(geometry.distanceMeters),
      sampleCount: geometry.sampleCount,
    };
  if (waypoints.some((waypoint) => !validCoordinate(waypoint)))
    return {
      ...emptyResult("ASSOCIATION_FAILED", uniquePlaces.length),
      geometryDistanceMeters: Math.round(geometry.distanceMeters),
      sampleCount: geometry.sampleCount,
    };
  const boundedLimit = (value: number | undefined, maximum: number) =>
    Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value!))) : maximum;
  const indexLimits: IndexLimits = {
    maximumCells: boundedLimit(input.indexLimits?.maximumCells, EVIDENCE_INDEX_MAX_CELLS),
    maximumReferences: boundedLimit(
      input.indexLimits?.maximumReferences,
      EVIDENCE_INDEX_MAX_REFERENCES,
    ),
    maximumConstructionWork: boundedLimit(
      input.indexLimits?.maximumConstructionWork,
      EVIDENCE_INDEX_MAX_CONSTRUCTION_WORK,
    ),
    maximumQueryReferences: boundedLimit(
      input.indexLimits?.maximumQueryReferences,
      EVIDENCE_INDEX_MAX_QUERY_REFERENCES,
    ),
    maximumQuerySegments: boundedLimit(
      input.indexLimits?.maximumQuerySegments,
      EVIDENCE_INDEX_MAX_QUERY_SEGMENTS,
    ),
  };
  let segmentIndex: ReturnType<typeof buildSegmentIndex>;
  try {
    segmentIndex = buildSegmentIndex(decoded, indexLimits);
  } catch (error) {
    return {
      ...emptyResult(
        error instanceof GeometryModelError ? "ASSOCIATION_FAILED" : "INDEX_LIMIT_EXCEEDED",
        uniquePlaces.length,
      ),
      geometryDistanceMeters: Math.round(geometry.distanceMeters),
      sampleCount: geometry.sampleCount,
    };
  }
  const requestedMaximum = input.maximumComparisons ?? EVIDENCE_ASSOCIATION_MAX_COMPARISONS;
  const maximumComparisons = Number.isFinite(requestedMaximum)
    ? Math.max(0, Math.min(EVIDENCE_ASSOCIATION_MAX_COMPARISONS, Math.floor(requestedMaximum)))
    : 0;
  const segmentLengths = segmentIndex.segments.map(({ from, to }) =>
    haversineDistanceMeters(from, to),
  );
  const segmentStarts = segmentLengths.reduce<number[]>(
    (starts, length) => {
      starts.push((starts.at(-1) ?? 0) + length);
      return starts;
    },
    [0],
  );
  const matchedGeometry: Array<
    ScenicPlace & { routeProgress: number; distanceToRouteMeters: number }
  > = [];
  const matchedWaypoints: ScenicPlace[] = [];
  let comparisons = 0;
  for (const place of uniquePlaces) {
    let geometryMatch: {
      segmentIndex: number;
      distanceMeters: number;
      fraction: number;
    } | null = null;
    let nearbySegments: number[];
    try {
      nearbySegments = nearbySegmentIndexes(place, segmentIndex, indexLimits);
    } catch {
      return {
        ...emptyResult("INDEX_LIMIT_EXCEEDED", uniquePlaces.length),
        geometryDistanceMeters: Math.round(geometry.distanceMeters),
        sampleCount: geometry.sampleCount,
        comparisons,
      };
    }
    for (const index of nearbySegments) {
      if (comparisons >= maximumComparisons)
        return {
          ...emptyResult("WORK_LIMIT_EXCEEDED", uniquePlaces.length),
          geometryDistanceMeters: Math.round(geometry.distanceMeters),
          sampleCount: geometry.sampleCount,
          comparisons,
        };
      comparisons += 1;
      const projection = sphericalPointToSegmentProjection(
        place,
        segmentIndex.segments[index].from,
        segmentIndex.segments[index].to,
      );
      if (
        projection.distanceMeters <= input.proximityMeters + EVIDENCE_DISTANCE_EPSILON_METERS &&
        (!geometryMatch ||
          projection.distanceMeters <
            geometryMatch.distanceMeters - EVIDENCE_DISTANCE_EPSILON_METERS)
      )
        geometryMatch = { segmentIndex: index, ...projection };
    }
    if (geometryMatch) {
      const routeDistance = Math.max(1, geometry.distanceMeters);
      matchedGeometry.push({
        ...place,
        types: [...place.types],
        routeProgress: Math.max(
          0,
          Math.min(
            1,
            (segmentStarts[geometryMatch.segmentIndex] +
              geometryMatch.fraction * segmentLengths[geometryMatch.segmentIndex]) /
              routeDistance,
          ),
        ),
        distanceToRouteMeters: geometryMatch.distanceMeters,
      });
      continue;
    }
    let waypointMatch = false;
    for (const waypoint of waypoints) {
      if (comparisons >= maximumComparisons)
        return {
          ...emptyResult("WORK_LIMIT_EXCEEDED", uniquePlaces.length),
          geometryDistanceMeters: Math.round(geometry.distanceMeters),
          sampleCount: geometry.sampleCount,
          comparisons,
        };
      comparisons += 1;
      if (haversineDistanceMeters(place, waypoint) <= input.proximityMeters) {
        waypointMatch = true;
        break;
      }
    }
    if (waypointMatch) matchedWaypoints.push(place);
  }
  const matched = [...matchedGeometry, ...matchedWaypoints];
  const evidence = { ...EMPTY_SCENIC_EVIDENCE };
  for (const place of matched) {
    if (comparisons >= maximumComparisons)
      return {
        ...emptyResult("WORK_LIMIT_EXCEEDED", uniquePlaces.length),
        geometryDistanceMeters: Math.round(geometry.distanceMeters),
        sampleCount: geometry.sampleCount,
        comparisons,
      };
    comparisons += 1;
    const contribution = evidenceForRoute([place], [place], 0.01);
    for (const category of Object.keys(evidence) as Array<keyof ScenicEvidenceCounts>)
      evidence[category] += contribution[category];
  }
  return {
    evidence,
    geometryDistanceMeters: Math.round(geometry.distanceMeters),
    sampleCount: geometry.sampleCount,
    evidenceConsidered: uniquePlaces.length,
    evidenceMatchedToGeometry: matchedGeometry.length,
    evidenceMatchedThroughWaypoints: matchedWaypoints.length,
    comparisons,
    status: "ANALYSED",
    matchedGeometryPlaces: matchedGeometry.map((place) => ({ ...place, types: [...place.types] })),
  };
}

/** Contains malformed provider evidence without allowing it to affect route selection availability. */
export function safeAssociateEvidenceWithRoute(
  input: Parameters<typeof associateEvidenceWithRoute>[0],
): EvidenceAssociationResult {
  try {
    return associateEvidenceWithRoute(input);
  } catch {
    const evidenceConsidered = Math.min(
      EVIDENCE_ASSOCIATION_MAX_PLACES,
      Array.isArray(input.places) ? input.places.length : 0,
    );
    return emptyResult("ASSOCIATION_FAILED", evidenceConsidered);
  }
}
