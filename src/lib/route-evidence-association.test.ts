import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  associateEvidenceWithRoute,
  EVIDENCE_ANTIPODAL_ANGLE_TOLERANCE_RADIANS,
  EVIDENCE_ASSOCIATION_MAX_COMPARISONS,
  EVIDENCE_DEGENERATE_SEGMENT_ANGLE_RADIANS,
  EVIDENCE_EARTH_RADIUS_METERS,
  EVIDENCE_INDEX_CELL_SIZE_METERS,
  EVIDENCE_ROUTE_MAX_DECODED_POINTS,
  EVIDENCE_ROUTE_MAX_ENCODED_CHARACTERS,
  EVIDENCE_ROUTE_MAX_SAMPLES,
  safeAssociateEvidenceWithRoute,
  sphericalPointToSegmentDistanceMeters,
} from "./route-evidence-association";
import { scoreScenicRoute } from "./scenic-score";
import { selectRouteCandidate } from "./route-selection";
import {
  evidenceForRoute,
  haversineDistanceMeters,
  routeCorridorSamples,
  type LatLng,
  type ScenicPlace,
} from "./scenic-waypoint";

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

const place = (id: string, lat: number, lng: number, primaryType = "woods"): ScenicPlace => ({
  id,
  lat,
  lng,
  primaryType,
  types: [primaryType],
});

function destinationPoint(origin: LatLng, bearingDegrees: number, distanceMeters: number): LatLng {
  const angularDistance = distanceMeters / EVIDENCE_EARTH_RADIUS_METERS;
  const latitude = (origin.lat * Math.PI) / 180;
  const longitude = (origin.lng * Math.PI) / 180;
  const bearing = (bearingDegrees * Math.PI) / 180;
  const targetLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance) +
      Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const targetLongitude =
    longitude +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
      Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(targetLatitude),
    );
  return {
    lat: (targetLatitude * 180) / Math.PI,
    lng: (((((targetLongitude * 180) / Math.PI + 540) % 360) + 360) % 360) - 180,
  };
}

function initialBearingDegrees(from: LatLng, to: LatLng): number {
  const fromLatitude = (from.lat * Math.PI) / 180;
  const toLatitude = (to.lat * Math.PI) / 180;
  const longitudeDelta = ((((to.lng - from.lng + 540) % 360) + 360) % 360) - 180;
  const longitudeRadians = (longitudeDelta * Math.PI) / 180;
  return (
    (Math.atan2(
      Math.sin(longitudeRadians) * Math.cos(toLatitude),
      Math.cos(fromLatitude) * Math.sin(toLatitude) -
        Math.sin(fromLatitude) * Math.cos(toLatitude) * Math.cos(longitudeRadians),
    ) *
      180) /
    Math.PI
  );
}

function ecef(point: LatLng): [number, number, number] {
  const latitude = (point.lat * Math.PI) / 180;
  const longitude = (point.lng * Math.PI) / 180;
  return [
    EVIDENCE_EARTH_RADIUS_METERS * Math.cos(latitude) * Math.cos(longitude),
    EVIDENCE_EARTH_RADIUS_METERS * Math.cos(latitude) * Math.sin(longitude),
    EVIDENCE_EARTH_RADIUS_METERS * Math.sin(latitude),
  ];
}

function pointFromEcef([x, y, z]: [number, number, number]): LatLng {
  return {
    lat: (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI,
    lng: (Math.atan2(y, x) * 180) / Math.PI,
  };
}

const cellBoundaryDistance = (coordinate: number) => {
  const remainder =
    ((coordinate % EVIDENCE_INDEX_CELL_SIZE_METERS) + EVIDENCE_INDEX_CELL_SIZE_METERS) %
    EVIDENCE_INDEX_CELL_SIZE_METERS;
  return Math.min(remainder, EVIDENCE_INDEX_CELL_SIZE_METERS - remainder);
};

describe("candidate route evidence association", () => {
  const denseStraightRoute = (segments: number) =>
    Array.from({ length: segments + 1 }, (_, index) => ({ lat: 0, lng: (5 * index) / segments }));
  it("matches evidence between the former seven sparse points and excludes distant evidence", () => {
    const points = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 5 },
    ];
    const near = place("near", 0.003, 2.3);
    const far = place("far", 0.02, 2.3);
    const oldSamples = routeCorridorSamples(points[0], points[1], [], 7);
    assert.equal(evidenceForRoute([near], oldSamples, 750).natural, 0);
    const result = associateEvidenceWithRoute({
      encodedPolyline: encode(points),
      places: [near, far],
      proximityMeters: 750,
    });
    assert.equal(result.evidence.natural, 1);
    assert.equal(result.evidenceMatchedToGeometry, 1);

    const directions = {
      encodedPolyline: encode(points),
      distance: "556 km",
      duration: "360 min",
      distanceMeters: 556_000,
      durationSeconds: 21_600,
      steps: [
        {
          instruction: "Continue",
          distance: "556 km",
          duration: "360 min",
          distanceMeters: 556_000,
          durationSeconds: 21_600,
        },
      ],
    };
    const score = (evidence: typeof result.evidence) =>
      scoreScenicRoute({
        start: points[0],
        end: points[1],
        mood: "Adventurous",
        theme: "Forest",
        extraMinutes: 30,
        stopCount: 0,
        directions,
        evidence,
        fastestDurationSeconds: 21_600,
      });
    const before = score(evidenceForRoute([near], oldSamples, 750));
    const after = score(result.evidence);
    assert.deepEqual(
      {
        evidence: [
          before.breakdown.natural_beauty,
          before.breakdown.mood_match,
          before.breakdown.theme_match,
        ],
        score: before.total,
      },
      { evidence: [1.6, 2, 2], score: 25 },
    );
    assert.deepEqual(
      {
        evidence: [
          after.breakdown.natural_beauty,
          after.breakdown.mood_match,
          after.breakdown.theme_match,
        ],
        score: after.total,
      },
      { evidence: [2.9, 2.7, 3.4], score: 32 },
    );
  });

  it("is independent of provider vertex density and gives equal credit on short and long routes", () => {
    const sparse = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
    ];
    const dense = Array.from({ length: 101 }, (_, index) => ({ lat: 0, lng: index / 100 }));
    const evidence = [place("wood", 0.002, 0.5)];
    const sparseResult = associateEvidenceWithRoute({
      encodedPolyline: encode(sparse),
      places: evidence,
      proximityMeters: 750,
    });
    const denseResult = associateEvidenceWithRoute({
      encodedPolyline: encode(dense),
      places: evidence,
      proximityMeters: 750,
    });
    const longResult = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 0, lng: -2 },
        { lat: 0, lng: 3 },
      ]),
      places: evidence,
      proximityMeters: 750,
    });
    assert.deepEqual(sparseResult.evidence, denseResult.evidence);
    assert.deepEqual(sparseResult.evidence, longResult.evidence);
  });

  it("handles dateline routes on the short wrapped path", () => {
    const result = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 10, lng: 179.8 },
        { lat: 10, lng: -179.8 },
      ]),
      places: [place("dateline", 10.002, 179.99)],
      proximityMeters: 750,
    });
    assert.equal(result.status, "ANALYSED");
    assert.equal(result.evidence.natural, 1);
    assert.ok(result.geometryDistanceMeters < 50_000);
  });

  it("uses one spherical model for high-latitude indexing and final eligibility", () => {
    const oldRegressionSegment = [
      { lat: 80, lng: -179.95 },
      { lat: 89.9, lng: -179.95 },
    ];
    const oldRegressionEvidence = { lat: 80.00112289, lng: -179.89225793 };
    const oldReferenceLatitude =
      (oldRegressionEvidence.lat + oldRegressionSegment[0].lat + oldRegressionSegment[1].lat) / 3;
    const oldProjectedDistance =
      Math.abs(oldRegressionEvidence.lng - oldRegressionSegment[0].lng) *
      111_320 *
      Math.cos((oldReferenceLatitude * Math.PI) / 180);
    assert.ok(Math.abs(oldProjectedDistance - 749.9) < 0.1);
    assert.ok(
      sphericalPointToSegmentDistanceMeters(
        oldRegressionEvidence,
        oldRegressionSegment[0],
        oldRegressionSegment[1],
      ) > 1_100,
    );
    const excluded = associateEvidenceWithRoute({
      encodedPolyline: encode(oldRegressionSegment),
      places: [place("old-projection", oldRegressionEvidence.lat, oldRegressionEvidence.lng)],
      proximityMeters: 750,
    });
    assert.equal(excluded.status, "ANALYSED");
    assert.equal(excluded.evidenceMatchedToGeometry, 0);

    for (const latitude of [80, -80]) {
      const segment = [
        { lat: latitude, lng: -30 },
        { lat: latitude > 0 ? 89 : -89, lng: -30 },
      ];
      const nearest = { lat: latitude > 0 ? 80.1 : -80.1, lng: -30 };
      for (const [distance, expected] of [
        [749.9, 1],
        [750, 1],
        [750.1, 0],
      ] as const) {
        const evidencePoint = destinationPoint(nearest, 90, distance);
        const sphericalDistance = sphericalPointToSegmentDistanceMeters(
          evidencePoint,
          segment[0],
          segment[1],
        );
        assert.ok(Math.abs(sphericalDistance - distance) < 0.001, `${latitude}: ${distance}`);
        const result = associateEvidenceWithRoute({
          encodedPolyline: encode(segment),
          places: [place(`${latitude}-${distance}`, evidencePoint.lat, evidencePoint.lng)],
          proximityMeters: 750,
        });
        assert.equal(result.status, "ANALYSED");
        assert.equal(result.evidenceMatchedToGeometry, expected, `${latitude}: ${distance}`);
        if (expected) assert.ok(result.comparisons > 0);
      }
    }
  });

  it("retrieves spherical segments at adversarial global cell positions", () => {
    const fixtures = [
      { lat: 0.001, lng: 0.001 },
      { lat: 0.001, lng: 90.001 },
      { lat: -0.001, lng: -90.001 },
      { lat: 44.999, lng: 44.999 },
      { lat: -44.999, lng: -135.001 },
      { lat: 79.999, lng: 179.999 },
      { lat: -79.999, lng: -179.999 },
      { lat: 89.5, lng: 20 },
      { lat: -89.5, lng: -160 },
    ];
    for (const [index, midpoint] of fixtures.entries()) {
      const segment = [
        destinationPoint(midpoint, 180, 500),
        destinationPoint(midpoint, 0, 500),
      ].map((point) => ({ lat: Number(point.lat.toFixed(5)), lng: Number(point.lng.toFixed(5)) }));
      const actualLength = haversineDistanceMeters(segment[0], segment[1]);
      const actualBearing = initialBearingDegrees(segment[0], segment[1]);
      const actualMidpoint = destinationPoint(segment[0], actualBearing, actualLength / 2);
      const perpendicular = initialBearingDegrees(actualMidpoint, segment[1]) + 90;
      for (const distance of [0, 125, 749.9, 750, 750.1]) {
        const evidencePoint = destinationPoint(actualMidpoint, perpendicular, distance);
        const exact = sphericalPointToSegmentDistanceMeters(evidencePoint, segment[0], segment[1]);
        const result = associateEvidenceWithRoute({
          encodedPolyline: encode(segment),
          places: [place(`global-${index}-${distance}`, evidencePoint.lat, evidencePoint.lng)],
          proximityMeters: 750,
        });
        assert.equal(result.status, "ANALYSED");
        assert.equal(
          result.evidenceMatchedToGeometry,
          exact <= 750.000001 ? 1 : 0,
          `${JSON.stringify({ distance, exact, index, midpoint })}`,
        );
        if (exact <= 750.000001) assert.ok(result.comparisons > 0);
      }
    }
  });

  it("fails closed at the work ceiling with deterministic sample bounds", () => {
    const result = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 0, lng: 0 },
        { lat: 0, lng: 1 },
      ]),
      places: [place("near", 0, 0.5)],
      proximityMeters: 750,
      maximumComparisons: 0,
    });
    assert.equal(result.status, "WORK_LIMIT_EXCEEDED");
    assert.deepEqual(result.evidence, {
      natural: 0,
      historic: 0,
      cultural: 0,
      coastal: 0,
      viewpoint: 0,
      wildlife: 0,
      food: 0,
      otherPoi: 0,
    });
    assert.ok(result.sampleCount <= EVIDENCE_ROUTE_MAX_SAMPLES);
    assert.ok(result.comparisons <= EVIDENCE_ASSOCIATION_MAX_COMPARISONS);
  });

  it("credits unmatched evidence through a verified inserted waypoint only", () => {
    const wood = place("waypoint", 0.02, 0.5);
    const result = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 0, lng: 0 },
        { lat: 0, lng: 1 },
      ]),
      places: [wood],
      waypoints: [wood],
      proximityMeters: 750,
    });
    assert.equal(result.evidenceMatchedToGeometry, 0);
    assert.equal(result.evidenceMatchedThroughWaypoints, 1);
    assert.deepEqual(result.matchedGeometryPlaces, []);
    assert.equal(result.evidence.natural, 1);
  });

  it("uses travelled provider segments rather than bend-crossing resample chords", () => {
    const fixtures: Array<{ name: string; points: LatLng[] }> = [
      {
        name: "U-shape",
        points: [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 0.02 },
          { lat: 0.02, lng: 0.02 },
          { lat: 0.02, lng: 0 },
        ],
      },
      {
        name: "hairpin",
        points: [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 0.02 },
          { lat: 0.003, lng: 0.02 },
          { lat: 0.003, lng: 0 },
        ],
      },
      {
        name: "switchback",
        points: [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 0.02 },
          { lat: 0.004, lng: 0.004 },
          { lat: 0.008, lng: 0.02 },
        ],
      },
      {
        name: "coastal bend",
        points: [
          { lat: 0, lng: 0 },
          { lat: 0.008, lng: 0.006 },
          { lat: 0.012, lng: 0.015 },
          { lat: 0.02, lng: 0.02 },
        ],
      },
      {
        name: "roundabout",
        points: [
          { lat: 0, lng: 0 },
          { lat: 0.003, lng: 0 },
          { lat: 0.003, lng: 0.003 },
          { lat: 0, lng: 0.003 },
          { lat: 0, lng: 0 },
        ],
      },
      {
        name: "interchange/self-crossing",
        points: [
          { lat: 0, lng: 0 },
          { lat: 0.02, lng: 0.02 },
          { lat: 0, lng: 0.02 },
          { lat: 0.02, lng: 0 },
        ],
      },
    ];
    for (const fixture of fixtures) {
      const nearTravelled = place(`${fixture.name}-near`, 0.001, 0.001);
      const result = associateEvidenceWithRoute({
        encodedPolyline: encode(fixture.points),
        places: [nearTravelled],
        proximityMeters: 750,
      });
      assert.equal(result.evidence.natural, 1, fixture.name);
    }

    const uShape = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.02 },
      { lat: 0.02, lng: 0.02 },
      { lat: 0.02, lng: 0 },
    ];
    const untravelledInterior = place("chord-only", 0.01, 0.01);
    const result = associateEvidenceWithRoute({
      encodedPolyline: encode(uShape),
      places: [untravelledInterior],
      proximityMeters: 750,
    });
    assert.equal(result.evidenceMatchedToGeometry, 0);
  });

  it("handles short, boundary, duplicate, parallel and zero-length geometry deterministically", () => {
    const metersToLongitude = (meters: number) => (meters / 6_371_000) * (180 / Math.PI);
    for (const meters of [100, 499, 500, 501]) {
      const result = associateEvidenceWithRoute({
        encodedPolyline: encode([
          { lat: 0, lng: 0 },
          { lat: 0, lng: metersToLongitude(meters) },
        ]),
        places: [place(`p-${meters}`, 0.001, metersToLongitude(meters / 2))],
        proximityMeters: 750,
      });
      assert.equal(result.status, "ANALYSED");
      assert.equal(result.evidence.natural, 1);
    }
    const duplicated = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.02 },
      ]),
      places: [place("parallel-near", 0.004, 0.01), place("parallel-far", 0.02, 0.01)],
      proximityMeters: 750,
    });
    assert.equal(duplicated.evidenceMatchedToGeometry, 1);
  });

  it("handles eastbound, westbound and repeated dateline crossings", () => {
    for (const points of [
      [
        { lat: 10, lng: 179.8 },
        { lat: 10, lng: -179.8 },
      ],
      [
        { lat: 10, lng: -179.8 },
        { lat: 10, lng: 179.8 },
      ],
      [
        { lat: 10, lng: 179.8 },
        { lat: 10, lng: -179.8 },
        { lat: 10, lng: 179.7 },
      ],
    ]) {
      const result = associateEvidenceWithRoute({
        encodedPolyline: encode(points),
        places: [place("date", 10.002, 179.99)],
        proximityMeters: 750,
      });
      assert.equal(result.status, "ANALYSED");
      assert.equal(result.evidence.natural, 1);
    }
  });

  it("fails closed for an ambiguous antipodal segment and remains finite at the poles", () => {
    const ambiguous = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 0, lng: 0 },
        { lat: 0, lng: 180 },
      ]),
      places: [place("ambiguous", 0, 90)],
      proximityMeters: 750,
    });
    assert.notEqual(ambiguous.status, "ANALYSED");
    assert.equal(ambiguous.evidence.natural, 0);
    for (const pole of [90, -90]) {
      const distance = sphericalPointToSegmentDistanceMeters(
        { lat: pole, lng: 180 },
        { lat: pole, lng: -180 },
        { lat: pole, lng: 0 },
      );
      assert.ok(Number.isFinite(distance));
      assert.ok(distance < 0.1);
    }
  });

  it("applies the named antipodal boundary directly and supports unambiguous long arcs", () => {
    const start = { lat: 0, lng: 0 };
    const endpoint = (distanceFromAntipodeRadians: number) => ({
      lat: 0,
      lng: 180 - (distanceFromAntipodeRadians * 180) / Math.PI,
    });
    for (const gap of [0, EVIDENCE_ANTIPODAL_ANGLE_TOLERANCE_RADIANS * 0.5]) {
      assert.throws(() => sphericalPointToSegmentDistanceMeters(start, start, endpoint(gap)));
    }
    const atBoundary = endpoint(EVIDENCE_ANTIPODAL_ANGLE_TOLERANCE_RADIANS);
    assert.throws(() => sphericalPointToSegmentDistanceMeters(start, start, atBoundary));
    const supported = endpoint(EVIDENCE_ANTIPODAL_ANGLE_TOLERANCE_RADIANS * 1.01);
    assert.ok(Number.isFinite(sphericalPointToSegmentDistanceMeters(start, start, supported)));
    assert.ok(
      Number.isFinite(
        sphericalPointToSegmentDistanceMeters({ lat: 40, lng: 90 }, start, { lat: 0, lng: 120 }),
      ),
    );
  });

  it("handles globally distributed duplicate segments without throwing or losing evidence", () => {
    const reproducer = { lat: -82.87301, lng: 8.50937 };
    const fixtures = [
      { lat: 0, lng: 0 },
      { lat: 51.5074, lng: -0.1278 },
      { lat: 35.2, lng: -120.7 },
      { lat: -33.8688, lng: 151.2093 },
      { lat: 80.12345, lng: 43.98765 },
      { lat: -80.12345, lng: -43.98765 },
      { lat: 20, lng: 179.999 },
      { lat: -20, lng: -179.999 },
      { lat: 89.9, lng: 10 },
      { lat: -89.9, lng: -170 },
      reproducer,
    ];
    for (let index = 0; index < 4_096; index += 1) {
      fixtures.push({
        lat: -89.9 + (((index * 7_919) % 40_961) / 40_960) * 179.8,
        lng: -180 + (((index * 10_471) % 40_961) / 40_960) * 360,
      });
    }
    for (const [index, point] of fixtures.entries()) {
      const decodedPoint = {
        lat: Number(point.lat.toFixed(5)),
        lng: Number(point.lng.toFixed(5)),
      };
      assert.equal(
        sphericalPointToSegmentDistanceMeters(decodedPoint, decodedPoint, decodedPoint),
        0,
      );
      const near = destinationPoint(decodedPoint, 90, 749.9);
      const far = destinationPoint(decodedPoint, 90, 750.1);
      const result = associateEvidenceWithRoute({
        encodedPolyline: encode([decodedPoint, decodedPoint]),
        places: [
          place(`duplicate-near-${index}`, near.lat, near.lng),
          place(`far-${index}`, far.lat, far.lng),
        ],
        proximityMeters: 750,
      });
      assert.equal(result.status, "ANALYSED", String(index));
      assert.equal(result.sampleCount, 1, String(index));
      assert.equal(result.evidenceMatchedToGeometry, 1, String(index));
    }
  });

  it("keeps duplicates safe at every route position and beside dateline and polar segments", () => {
    const routes: LatLng[][] = [
      [
        { lat: 51.5, lng: -0.12 },
        { lat: 51.5, lng: -0.12 },
        { lat: 51.51, lng: -0.1 },
      ],
      [
        { lat: 51.5, lng: -0.12 },
        { lat: 51.51, lng: -0.1 },
        { lat: 51.51, lng: -0.1 },
      ],
      [
        { lat: 51.5, lng: -0.12 },
        { lat: 51.505, lng: -0.11 },
        { lat: 51.505, lng: -0.11 },
        { lat: 51.51, lng: -0.1 },
      ],
      [
        { lat: 10, lng: 179.9 },
        { lat: 10, lng: 179.9 },
        { lat: 10, lng: -179.9 },
        { lat: 10, lng: -179.9 },
      ],
      [
        { lat: 82, lng: 20 },
        { lat: 82, lng: 20 },
        { lat: 83, lng: 30 },
      ],
    ];
    for (const [index, points] of routes.entries()) {
      const endpoint = points[Math.floor(points.length / 2)];
      const result = associateEvidenceWithRoute({
        encodedPolyline: encode(points),
        places: [place(`mixed-${index}`, endpoint.lat, endpoint.lng)],
        proximityMeters: 750,
      });
      assert.equal(result.status, "ANALYSED");
      assert.equal(result.evidenceMatchedToGeometry, 1);
    }
  });

  it("uses a documented sub-millimetre degeneracy boundary without collapsing road geometry", () => {
    const origin = { lat: 0, lng: 0 };
    const toleranceMeters =
      EVIDENCE_DEGENERATE_SEGMENT_ANGLE_RADIANS * EVIDENCE_EARTH_RADIUS_METERS;
    for (const [length, degenerate] of [
      [0, true],
      [toleranceMeters * 0.5, true],
      [toleranceMeters * 0.99, true],
      [toleranceMeters * 1.01, false],
      [0.001, false],
      [0.01, false],
      [0.1, false],
      [1, false],
      [10, false],
    ] as const) {
      const endpoint = destinationPoint(origin, 90, length);
      const distanceAtEndpoint = sphericalPointToSegmentDistanceMeters(endpoint, origin, endpoint);
      if (degenerate) assert.ok(Math.abs(distanceAtEndpoint - length) < 1e-6, String(length));
      else assert.ok(distanceAtEndpoint < 1e-6, String(length));
      assert.ok(Number.isFinite(distanceAtEndpoint));
    }
  });

  it("persists a deterministic completeness probe with substantial boundary coverage", () => {
    const regions = [
      { lat: 0, lng: 20 },
      { lat: 52, lng: -2 },
      { lat: 78, lng: 40 },
      { lat: -78, lng: -40 },
      { lat: 15, lng: 179.8 },
      { lat: -15, lng: -179.8 },
    ];
    let within = 0;
    let boundary = 0;
    let outside = 0;
    for (const region of regions) {
      for (const bearing of [15, 95, 185, 275]) {
        for (const length of [1_125, 5_125, 20_125]) {
          const rawEnd = destinationPoint(region, bearing, length);
          const start = { lat: Number(region.lat.toFixed(5)), lng: Number(region.lng.toFixed(5)) };
          const end = { lat: Number(rawEnd.lat.toFixed(5)), lng: Number(rawEnd.lng.toFixed(5)) };
          const actualLength = haversineDistanceMeters(start, end);
          const actualBearing = initialBearingDegrees(start, end);
          for (const fraction of [0, 0.1, 0.5, 0.99]) {
            const onArc = destinationPoint(start, actualBearing, actualLength * fraction);
            const tangentBearing = initialBearingDegrees(onArc, end);
            for (const offset of [0, 100, 500, 749.9, 750, 750.1, 900]) {
              const evidencePoint = destinationPoint(onArc, tangentBearing + 90, offset);
              const result = associateEvidenceWithRoute({
                encodedPolyline: encode([start, end]),
                places: [
                  place(
                    `probe-${within}-${boundary}-${outside}`,
                    evidencePoint.lat,
                    evidencePoint.lng,
                  ),
                ],
                proximityMeters: 750,
              });
              assert.equal(result.status, "ANALYSED");
              const expected = offset <= 750 ? 1 : 0;
              assert.equal(
                result.evidenceMatchedToGeometry,
                expected,
                `${JSON.stringify({ region, bearing, length, fraction, offset })}`,
              );
              if (offset < 750) within += 1;
              else if (offset === 750) boundary += 1;
              else outside += 1;
            }
          }
        }
      }
    }
    assert.deepEqual({ within, boundary, outside }, { within: 1_152, boundary: 288, outside: 576 });
  });

  it("verifies real ECEF face, edge and corner remainders before association", () => {
    const radius = EVIDENCE_EARTH_RADIUS_METERS;
    const vectors: Array<{ expectedBoundaries: number; vector: [number, number, number] }> = [
      {
        expectedBoundaries: 1,
        vector: [4_000_000, Math.sqrt(radius ** 2 - 4_000_000 ** 2 - 1_000_123 ** 2), 1_000_123],
      },
      {
        expectedBoundaries: 2,
        vector: [4_000_000, Math.sqrt(radius ** 2 - 4_000_000 ** 2 - 3_000_000 ** 2), 3_000_000],
      },
      { expectedBoundaries: 3, vector: [-3_006_000, 5_617_000, 54_000] },
      { expectedBoundaries: 3, vector: [3_006_000, -5_617_000, -54_000] },
    ];
    for (const [index, fixture] of vectors.entries()) {
      const evidencePoint = pointFromEcef(fixture.vector);
      const actualVector = ecef(evidencePoint);
      const boundaryAxes = actualVector.filter(
        (coordinate) => cellBoundaryDistance(coordinate) < 0.001,
      );
      assert.equal(boundaryAxes.length, fixture.expectedBoundaries, String(index));
      for (const offset of [749, 751]) {
        const midpoint = destinationPoint(evidencePoint, 90, offset);
        const segment = [
          destinationPoint(midpoint, 180, 500),
          destinationPoint(midpoint, 0, 500),
        ].map((point) => ({
          lat: Number(point.lat.toFixed(5)),
          lng: Number(point.lng.toFixed(5)),
        }));
        const exact = sphericalPointToSegmentDistanceMeters(evidencePoint, segment[0], segment[1]);
        assert.equal(exact <= 750.000001, offset < 750);
        const result = associateEvidenceWithRoute({
          encodedPolyline: encode(segment),
          places: [place(`ecef-${index}-${offset}`, evidencePoint.lat, evidencePoint.lng)],
          proximityMeters: 750,
        });
        assert.equal(result.status, "ANALYSED");
        assert.equal(result.evidenceMatchedToGeometry, offset < 750 ? 1 : 0);
        if (offset < 750) assert.ok(result.comparisons > 0);
      }
    }
  });

  it("enforces evidence, waypoint, geometry, decoded-point and fixed-sample limits", () => {
    const route = encode([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.01 },
    ]);
    const invalid = associateEvidenceWithRoute({
      encodedPolyline: route,
      places: [place("bad", Number.NaN, 0)],
      waypoints: [{ lat: 91, lng: 0 }],
      proximityMeters: 750,
    });
    assert.equal(invalid.status, "ASSOCIATION_FAILED");
    const boundedEvidence = associateEvidenceWithRoute({
      encodedPolyline: route,
      places: [
        ...Array.from({ length: 70 }, (_, index) => place(`far-${index}`, 20, 20)),
        place("truncated-near", 0, 0.005),
      ],
      proximityMeters: 750,
    });
    assert.equal(boundedEvidence.evidenceConsidered, 70);
    assert.equal(boundedEvidence.evidenceMatchedToGeometry, 0);
    assert.equal(
      associateEvidenceWithRoute({
        encodedPolyline: route,
        places: [],
        waypoints: Array.from({ length: 3 }, () => ({ lat: 0, lng: 0 })),
        proximityMeters: 750,
      }).status,
      "ASSOCIATION_FAILED",
    );
    assert.equal(
      associateEvidenceWithRoute({
        encodedPolyline: "!".repeat(EVIDENCE_ROUTE_MAX_ENCODED_CHARACTERS),
        places: [],
        proximityMeters: 750,
      }).status,
      "MALFORMED_GEOMETRY",
    );
    assert.equal(
      associateEvidenceWithRoute({
        encodedPolyline: "?".repeat(EVIDENCE_ROUTE_MAX_ENCODED_CHARACTERS + 1),
        places: [],
        proximityMeters: 750,
      }).status,
      "GEOMETRY_LIMIT_EXCEEDED",
    );
    const exactDecodedLimit = encode(
      Array.from({ length: EVIDENCE_ROUTE_MAX_DECODED_POINTS }, () => ({ lat: 0, lng: 0 })),
    );
    assert.equal(
      associateEvidenceWithRoute({
        encodedPolyline: exactDecodedLimit,
        places: [],
        proximityMeters: 750,
      }).status,
      "ANALYSED",
    );
    assert.equal(
      associateEvidenceWithRoute({
        encodedPolyline: `${exactDecodedLimit}??`,
        places: [],
        proximityMeters: 750,
      }).status,
      "GEOMETRY_LIMIT_EXCEEDED",
    );
    const metersToLongitude = (meters: number) => (meters / 6_371_000) * (180 / Math.PI);
    const atLimit = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 0, lng: 0 },
        { lat: 0, lng: metersToLongitude((EVIDENCE_ROUTE_MAX_SAMPLES - 1) * 500 - 1) },
      ]),
      places: [],
      proximityMeters: 750,
    });
    assert.equal(atLimit.status, "ANALYSED");
    assert.equal(atLimit.sampleCount, EVIDENCE_ROUTE_MAX_SAMPLES);
    const aboveLimit = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 0, lng: 0 },
        { lat: 0, lng: metersToLongitude((EVIDENCE_ROUTE_MAX_SAMPLES - 1) * 500 + 2) },
      ]),
      places: [],
      proximityMeters: 750,
    });
    assert.equal(aboveLimit.status, "SAMPLE_LIMIT_EXCEEDED");
  });

  it("counts route, waypoint and linear classification comparisons in one fail-closed budget", () => {
    const classificationExhaustion = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.01 },
      ]),
      places: [place("one", 0, 0.005)],
      waypoints: [{ lat: 0, lng: 0.005 }],
      proximityMeters: 750,
      maximumComparisons: 1,
    });
    assert.equal(classificationExhaustion.status, "WORK_LIMIT_EXCEEDED");
    assert.equal(classificationExhaustion.comparisons, 1);
    assert.equal(classificationExhaustion.evidence.natural, 0);

    const waypointExhaustion = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.01 },
      ]),
      places: [place("waypoint-only", 0.02, 0.005)],
      waypoints: [{ lat: 0.02, lng: 0.005 }],
      proximityMeters: 750,
      maximumComparisons: 1,
    });
    assert.equal(waypointExhaustion.status, "WORK_LIMIT_EXCEEDED");
    assert.equal(waypointExhaustion.comparisons, 1);
    assert.equal(waypointExhaustion.evidence.natural, 0);
    assert.equal(
      associateEvidenceWithRoute({
        encodedPolyline: encode([
          { lat: 0, lng: 0 },
          { lat: 0, lng: 0.01 },
        ]),
        places: [place("invalid-budget", 0, 0.005)],
        proximityMeters: 750,
        maximumComparisons: Number.NaN,
      }).status,
      "WORK_LIMIT_EXCEEDED",
    );
  });

  it("contains unexpected evidence failures without fabricating partial evidence", () => {
    const result = safeAssociateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.01 },
      ]),
      places: null as unknown as ScenicPlace[],
      proximityMeters: 750,
    });
    assert.equal(result.status, "ASSOCIATION_FAILED");
    assert.equal(result.evidence.natural, 0);

    const directions = {
      encodedPolyline: encode([
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.01 },
      ]),
      distance: "1 km",
      duration: "10 min",
      distanceMeters: 1_000,
      durationSeconds: 600,
      steps: [],
    };
    const baselineScore = scoreScenicRoute({
      start: { lat: 0, lng: 0 },
      end: { lat: 0, lng: 0.01 },
      mood: "Adventurous",
      theme: "Forest",
      extraMinutes: 30,
      stopCount: 0,
      directions,
      evidence: result.evidence,
      fastestDurationSeconds: 600,
    });
    const selection = selectRouteCandidate(
      [
        {
          candidateId: "baseline-0",
          directions,
          score: baselineScore.total,
          scoreResult: baselineScore,
          originalIndex: 0,
          source: "fastest" as const,
          routeShapeEligible: true,
        },
      ],
      30,
    );
    assert.equal(selection.selected.candidateId, "baseline-0");
  });

  it("associates realistic 2k, 4k, 5k and 10k segment routes through nearby index cells", () => {
    for (const segments of [2_000, 4_000, 5_000, 10_000]) {
      const places = [
        place(`first-${segments}`, 0.001, 0.001),
        place(`last-${segments}`, 0.001, 4.999),
        ...Array.from({ length: 68 }, (_, index) => place(`far-${segments}-${index}`, 10, index)),
      ];
      const result = associateEvidenceWithRoute({
        encodedPolyline: encode(denseStraightRoute(segments)),
        places,
        proximityMeters: 750,
      });
      assert.equal(result.status, "ANALYSED", `${segments} segments`);
      assert.equal(result.evidenceMatchedToGeometry, 2, `${segments} segments`);
      assert.ok(result.comparisons < EVIDENCE_ASSOCIATION_MAX_COMPARISONS);
    }
  });

  it("associates beginning, middle and end evidence on distributed road-like geometry", () => {
    const points = Array.from({ length: 10_001 }, (_, index) => {
      const progress = index / 10_000;
      return {
        lat: 50 + progress * 5 + Math.sin(progress * Math.PI * 18) * 0.02,
        lng: -5 + progress * 7 + Math.sin(progress * Math.PI * 11) * 0.03,
      };
    });
    const places = [
      place("road-start", points[10].lat + 0.001, points[10].lng),
      place("road-middle", points[5_000].lat + 0.001, points[5_000].lng, "castle"),
      place("road-end", points[9_990].lat + 0.001, points[9_990].lng, "lake"),
      ...Array.from({ length: 67 }, (_, index) => place(`road-far-${index}`, -20, index)),
    ];
    const result = associateEvidenceWithRoute({
      encodedPolyline: encode(points),
      places,
      proximityMeters: 750,
    });
    assert.equal(result.status, "ANALYSED");
    assert.equal(result.evidenceMatchedToGeometry, 3);
    assert.ok(result.comparisons < EVIDENCE_ASSOCIATION_MAX_COMPARISONS);
  });

  it("is invariant to evidence order for the same bounded unique set", () => {
    const points = denseStraightRoute(5_000);
    const places = [
      place("first", 0.001, 0.001),
      place("middle", 0.001, 2.5, "castle"),
      place("last", 0.001, 4.999, "lake"),
      ...Array.from({ length: 30 }, (_, index) => place(`far-${index}`, 10, index)),
    ];
    const forward = associateEvidenceWithRoute({
      encodedPolyline: encode(points),
      places,
      proximityMeters: 750,
    });
    const reversed = associateEvidenceWithRoute({
      encodedPolyline: encode(points),
      places: [...places].reverse(),
      proximityMeters: 750,
    });
    assert.equal(forward.status, "ANALYSED");
    assert.deepEqual(forward.evidence, reversed.evidence);
    assert.equal(forward.evidenceMatchedToGeometry, reversed.evidenceMatchedToGeometry);
    assert.deepEqual(
      forward.matchedGeometryPlaces.map(({ id }) => id).sort(),
      reversed.matchedGeometryPlaces.map(({ id }) => id).sort(),
    );

    const reversedGeometry = associateEvidenceWithRoute({
      encodedPolyline: encode([...points].reverse()),
      places,
      proximityMeters: 750,
    });
    assert.deepEqual(forward.evidence, reversedGeometry.evidence);
    assert.deepEqual(
      forward.matchedGeometryPlaces.map(({ id }) => id).sort(),
      reversedGeometry.matchedGeometryPlaces.map(({ id }) => id).sort(),
    );
  });

  it("analyses 70 entirely distant Places without spending exact comparisons", () => {
    const result = associateEvidenceWithRoute({
      encodedPolyline: encode(denseStraightRoute(10_000)),
      places: Array.from({ length: 70 }, (_, index) => place(`distant-${index}`, 10, index)),
      proximityMeters: 750,
    });
    assert.equal(result.status, "ANALYSED");
    assert.equal(result.comparisons, 0);
    assert.equal(result.evidenceMatchedToGeometry, 0);
  });

  it("collects 70 unique valid IDs without duplicates consuming the cap", () => {
    const near = place("near-unique", 0.001, 0.005);
    const firstDuplicate = place("duplicate", 10, 10);
    const duplicateWithDifferentData = place("duplicate", 0.001, 0.005);
    const source = [
      firstDuplicate,
      ...Array.from({ length: 90 }, () => duplicateWithDifferentData),
      { ...place("blank", 0, 0), id: " " },
      { ...place("too-long", 0, 0), id: "x".repeat(257) },
      { ...place("missing", 0, 0), id: undefined } as unknown as ScenicPlace,
      near,
      ...Array.from({ length: 80 }, (_, index) => place(`unique-${index}`, 10, index)),
    ];
    const snapshot = JSON.stringify(source);
    const result = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.01 },
      ]),
      places: source,
      proximityMeters: 750,
    });
    assert.equal(result.status, "ANALYSED");
    assert.equal(result.evidenceConsidered, 70);
    assert.equal(result.evidenceMatchedToGeometry, 1);
    assert.equal(result.evidence.natural, 1);
    assert.equal(JSON.stringify(source), snapshot);
    assert.equal(firstDuplicate.lat, 10);
  });

  it("scans exactly 700 raw inputs and never observes input 701", () => {
    const route = encode([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.01 },
    ]);
    const duplicate = place("duplicate", 20, 20);
    const at700 = associateEvidenceWithRoute({
      encodedPolyline: route,
      places: [...Array.from({ length: 699 }, () => duplicate), place("near-700", 0, 0.005)],
      proximityMeters: 750,
    });
    assert.equal(at700.evidenceMatchedToGeometry, 1);
    const at701 = associateEvidenceWithRoute({
      encodedPolyline: route,
      places: [...Array.from({ length: 700 }, () => duplicate), place("near-701", 0, 0.005)],
      proximityMeters: 750,
    });
    assert.equal(at701.status, "ANALYSED");
    assert.equal(at701.evidenceMatchedToGeometry, 0);
  });

  it("enforces exact comparison and index limits without partial evidence", () => {
    const route = encode([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.001 },
    ]);
    const input = {
      encodedPolyline: route,
      places: [place("near", 0, 0.0005)],
      proximityMeters: 750,
    };
    assert.equal(
      associateEvidenceWithRoute({ ...input, maximumComparisons: 2 }).status,
      "ANALYSED",
    );
    assert.equal(
      associateEvidenceWithRoute({ ...input, maximumComparisons: 1 }).status,
      "WORK_LIMIT_EXCEEDED",
    );
    assert.equal(
      associateEvidenceWithRoute({
        ...input,
        indexLimits: { maximumConstructionWork: 2 },
      }).status,
      "ANALYSED",
    );
    assert.equal(
      associateEvidenceWithRoute({ ...input, indexLimits: { maximumCells: 2 } }).status,
      "ANALYSED",
    );
    assert.equal(
      associateEvidenceWithRoute({ ...input, indexLimits: { maximumReferences: 2 } }).status,
      "ANALYSED",
    );
    for (const indexLimits of [
      { maximumConstructionWork: 1 },
      { maximumCells: 0 },
      { maximumCells: 1 },
      { maximumReferences: 0 },
      { maximumReferences: 1 },
      { maximumQueryReferences: 0 },
      { maximumQuerySegments: 0 },
    ]) {
      const result = associateEvidenceWithRoute({ ...input, indexLimits });
      assert.equal(result.status, "INDEX_LIMIT_EXCEEDED");
      assert.equal(result.evidence.natural, 0);
    }
  });

  it("checks unique candidates and query references before limit-plus-one insertion", () => {
    const input = {
      encodedPolyline: encode([
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.000001 },
        { lat: 0, lng: 0 },
      ]),
      places: [place("near", 0, 0)],
      proximityMeters: 750,
    };
    assert.equal(
      associateEvidenceWithRoute({
        ...input,
        indexLimits: { maximumQueryReferences: 2, maximumQuerySegments: 2 },
      }).status,
      "ANALYSED",
    );
    for (const indexLimits of [
      { maximumQueryReferences: 1, maximumQuerySegments: 2 },
      { maximumQueryReferences: 2, maximumQuerySegments: 1 },
    ]) {
      const result = associateEvidenceWithRoute({ ...input, indexLimits });
      assert.equal(result.status, "INDEX_LIMIT_EXCEEDED");
      assert.equal(result.evidence.natural, 0);
    }
  });

  it("fails closed when a pathological same-cell query exceeds its candidate bound", () => {
    const points = Array.from({ length: 20_002 }, (_, index) => ({
      lat: 0,
      lng: index % 2 === 0 ? 0 : 0.000001,
    }));
    const result = associateEvidenceWithRoute({
      encodedPolyline: encode(points),
      places: [place("near", 0, 0)],
      proximityMeters: 750,
    });
    assert.equal(result.status, "INDEX_LIMIT_EXCEEDED");
    assert.equal(result.evidence.natural, 0);
  });

  it("keeps candidate association state isolated", () => {
    const encodedPolyline = encode(denseStraightRoute(2_000));
    const first = associateEvidenceWithRoute({
      encodedPolyline,
      places: [place("near", 0.001, 2.5)],
      proximityMeters: 750,
    });
    first.evidence.natural = 99;
    const second = associateEvidenceWithRoute({
      encodedPolyline,
      places: [place("far", 10, 10)],
      proximityMeters: 750,
    });
    assert.equal(second.evidence.natural, 0);
  });

  it("projects evidence onto the nearest travelled position instead of a segment midpoint", () => {
    const route = encode([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.1 },
    ]);
    const quarter = associateEvidenceWithRoute({
      encodedPolyline: route,
      places: [place("quarter", 0.001, 0.025)],
      proximityMeters: 750,
    }).matchedGeometryPlaces[0];
    const late = associateEvidenceWithRoute({
      encodedPolyline: route,
      places: [place("late", 0.001, 0.09)],
      proximityMeters: 750,
    }).matchedGeometryPlaces[0];
    assert.ok(Math.abs(quarter.routeProgress - 0.25) < 0.002);
    assert.ok(Math.abs(late.routeProgress - 0.9) < 0.002);
    assert.ok(Number.isFinite(quarter.distanceToRouteMeters));
  });

  it("chooses the geometrically nearest parallel segment and the earliest equal retrace", () => {
    const parallel = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 0.005, lng: 0 },
        { lat: 0.005, lng: 0.1 },
        { lat: 0, lng: 0.1 },
        { lat: 0, lng: 0 },
      ]),
      places: [place("parallel", 0.001, 0.075)],
      proximityMeters: 750,
    }).matchedGeometryPlaces[0];
    assert.ok(parallel.routeProgress > 0.5);
    assert.ok(parallel.distanceToRouteMeters < 150);

    const retraced = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.1 },
        { lat: 0, lng: 0 },
      ]),
      places: [place("retrace", 0.001, 0.025)],
      proximityMeters: 750,
    }).matchedGeometryPlaces[0];
    assert.ok(Math.abs(retraced.routeProgress - 0.125) < 0.002);
  });

  it("uses nearest projected distance at a self-crossing rather than segment order", () => {
    const crossing = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: -0.02, lng: -0.02 },
        { lat: 0.02, lng: 0.02 },
        { lat: 0.02, lng: -0.02 },
        { lat: -0.02, lng: 0.02 },
      ]),
      places: [place("crossing", 0.002, -0.001)],
      proximityMeters: 750,
    }).matchedGeometryPlaces[0];
    assert.ok(crossing.routeProgress > 0.6);
    assert.ok(crossing.distanceToRouteMeters < 100);
  });

  it("uses cumulative segment length and clamps endpoint and repeated-point projections", () => {
    const result = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.01 },
        { lat: 0, lng: 0.1 },
      ]),
      places: [place("unequal", 0.001, 0.055), place("endpoint", 0.001, 0.1)],
      proximityMeters: 750,
    });
    const unequal = result.matchedGeometryPlaces.find(({ id }) => id === "unequal")!;
    const endpoint = result.matchedGeometryPlaces.find(({ id }) => id === "endpoint")!;
    assert.ok(Math.abs(unequal.routeProgress - 0.55) < 0.002);
    assert.ok(Math.abs(endpoint.routeProgress - 1) < 0.002);
    for (const match of result.matchedGeometryPlaces) {
      assert.ok(Number.isFinite(match.routeProgress));
      assert.ok(Number.isFinite(match.distanceToRouteMeters));
      assert.ok(match.routeProgress >= 0 && match.routeProgress <= 1);
    }
  });

  it("reverses chronology and projects safely across the dateline and at high latitude", () => {
    const evidence = [place("early", 0.001, 0.02), place("late", 0.001, 0.08)];
    const forward = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.1 },
      ]),
      places: evidence,
      proximityMeters: 750,
    });
    const reversed = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 0, lng: 0.1 },
        { lat: 0, lng: 0 },
      ]),
      places: evidence,
      proximityMeters: 750,
    });
    assert.ok(
      forward.matchedGeometryPlaces[0].routeProgress <
        forward.matchedGeometryPlaces[1].routeProgress,
    );
    assert.ok(
      reversed.matchedGeometryPlaces[0].routeProgress >
        reversed.matchedGeometryPlaces[1].routeProgress,
    );

    const dateline = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 10, lng: 179.9 },
        { lat: 10, lng: -179.9 },
      ]),
      places: [place("dateline-progress", 10.001, -179.95)],
      proximityMeters: 750,
    }).matchedGeometryPlaces[0];
    const polar = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 80, lng: 0 },
        { lat: 80, lng: 0.1 },
      ]),
      places: [place("polar-progress", 80.0005, 0.075)],
      proximityMeters: 750,
    }).matchedGeometryPlaces[0];
    assert.ok(Math.abs(dateline.routeProgress - 0.75) < 0.01);
    assert.ok(Math.abs(polar.routeProgress - 0.75) < 0.02);
    assert.ok(Number.isFinite(dateline.distanceToRouteMeters));
    assert.ok(Number.isFinite(polar.distanceToRouteMeters));
  });

  it("keeps the 750 metre projection threshold inclusive", () => {
    const origin = { lat: 0, lng: 0.05 };
    const onBoundary = destinationPoint(origin, 0, 750);
    const outside = destinationPoint(origin, 0, 750.01);
    const result = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.1 },
      ]),
      places: [
        place("boundary", onBoundary.lat, onBoundary.lng),
        place("outside", outside.lat, outside.lng),
      ],
      proximityMeters: 750,
    });
    assert.deepEqual(
      result.matchedGeometryPlaces.map(({ id }) => id),
      ["boundary"],
    );
  });

  it("isolates candidate-local fields when candidates reuse the exact same Place object", () => {
    const shared = place("shared", 0, 0.025);
    shared.types.push("park");
    const sourceSnapshot = structuredClone(shared);
    const first = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.1 },
      ]),
      places: [shared],
      proximityMeters: 750,
    });
    const firstSnapshot = structuredClone(first.matchedGeometryPlaces[0]);
    const second = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 0.004, lng: -0.1 },
        { lat: 0.004, lng: 0.1 },
      ]),
      places: [shared],
      proximityMeters: 750,
    });
    assert.deepEqual(shared, sourceSnapshot);
    assert.deepEqual(first.matchedGeometryPlaces[0], firstSnapshot);
    assert.notEqual(firstSnapshot.routeProgress, second.matchedGeometryPlaces[0].routeProgress);
    assert.notEqual(
      firstSnapshot.distanceToRouteMeters,
      second.matchedGeometryPlaces[0].distanceToRouteMeters,
    );
    first.matchedGeometryPlaces[0].routeProgress = 1;
    first.matchedGeometryPlaces[0].types.push("mutated");
    assert.deepEqual(shared, sourceSnapshot);
    assert.deepEqual(second.matchedGeometryPlaces[0].types, sourceSnapshot.types);

    const repeatedSecond = associateEvidenceWithRoute({
      encodedPolyline: encode([
        { lat: 0.004, lng: -0.1 },
        { lat: 0.004, lng: 0.1 },
      ]),
      places: [shared],
      proximityMeters: 750,
    });
    assert.deepEqual(repeatedSecond.matchedGeometryPlaces, second.matchedGeometryPlaces);
  });
});
