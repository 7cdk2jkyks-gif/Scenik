import process from "node:process";

const GEOCODING_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const PLACES_NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby";
const REQUEST_TIMEOUT_MS = 10_000;

export const ROUTES_FIELD_MASK = [
  "routes.duration",
  "routes.distanceMeters",
  "routes.polyline.encodedPolyline",
  "routes.legs.steps.navigationInstruction",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.staticDuration",
  "routes.legs.steps.startLocation",
  "routes.legs.steps.endLocation",
].join(",");

export interface GeocodedLocation {
  lat: number;
  lng: number;
  formatted: string;
}

export interface NavStep {
  instruction: string;
  distance: string;
  duration: string;
  distanceMeters: number;
  durationSeconds: number;
  maneuver?: string;
  startLat?: number;
  startLng?: number;
  endLat?: number;
  endLng?: number;
}

export interface ComputedDirections {
  encodedPolyline: string;
  distance: string;
  duration: string;
  distanceMeters: number;
  durationSeconds: number;
  steps: NavStep[];
  alternatives?: Array<{
    encodedPolyline: string;
    distanceMeters: number;
    durationSeconds: number;
  }>;
  candidates?: ComputedDirections[];
}

export interface NearbyScenicPlace {
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
}

type GeocodingResult = {
  formatted_address?: unknown;
  geometry?: { location?: { lat?: unknown; lng?: unknown } };
};

type GeocodingResponse = {
  status?: unknown;
  results?: unknown;
};

type RawStep = {
  navigationInstruction?: { instructions?: unknown; maneuver?: unknown };
  distanceMeters?: unknown;
  staticDuration?: unknown;
  startLocation?: { latLng?: { latitude?: unknown; longitude?: unknown } };
  endLocation?: { latLng?: { latitude?: unknown; longitude?: unknown } };
};

type RawRoute = {
  polyline?: { encodedPolyline?: unknown };
  legs?: Array<{ steps?: RawStep[] }>;
  distanceMeters?: unknown;
  duration?: unknown;
};

function mapsKey(): string {
  // Nitro exposes runtime bindings through node:process. Read inside the
  // operation rather than at module evaluation time so request-time bindings
  // are available in production runtimes.
  const rawKey = process.env.GOOGLE_MAPS_API_KEY;
  const key = rawKey?.trim() ?? "";
  const errorCode = key ? null : "MAPS_NOT_CONFIGURED";
  console.info("[google-maps-config]", {
    operation: "configuration",
    googleMapsApiKeyExists: rawKey !== undefined,
    trimmedCharacterCount: key.length,
    errorCode,
  });
  if (!key) {
    throw new Error("MAPS_NOT_CONFIGURED");
  }
  return key;
}

function logMapsFailure(operation: string, responseStatus: number, errorCode: string): void {
  console.error("[google-maps]", { operation, responseStatus, errorCode });
}

function logRoutesSuccess(responseStatus: number, routes: RawRoute[]): void {
  const first = routes[0];
  console.info("[google-maps]", {
    operation: "computeRoutes",
    responseStatus,
    errorCode: null,
    routeCount: routes.length,
    hasDistance: typeof first?.distanceMeters === "number",
    hasDuration: typeof first?.duration === "string",
    hasPolyline: typeof first?.polyline?.encodedPolyline === "string",
    hasSteps: Array.isArray(first?.legs) && first.legs.some((leg) => Array.isArray(leg.steps)),
  });
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

async function geocode(
  query: URLSearchParams,
  operation: "forwardGeocode" | "reverseGeocode",
): Promise<GeocodedLocation> {
  query.set("key", mapsKey());

  let response: Response;
  try {
    response = await fetchWithTimeout(`${GEOCODING_URL}?${query.toString()}`, { method: "GET" });
  } catch {
    logMapsFailure(operation, 0, "GEOCODING_FAILED");
    throw new Error("GEOCODING_FAILED");
  }

  if (!response.ok) {
    logMapsFailure(operation, response.status, "GEOCODING_FAILED");
    throw new Error("GEOCODING_FAILED");
  }

  const data = (await response.json().catch(() => null)) as GeocodingResponse | null;
  const status = typeof data?.status === "string" ? data.status : "MALFORMED";
  if (status === "ZERO_RESULTS") {
    logMapsFailure(operation, response.status, "GEOCODING_ZERO_RESULTS");
    throw new Error("GEOCODING_ZERO_RESULTS");
  }
  if (status !== "OK") {
    const code =
      status === "REQUEST_DENIED"
        ? "GEOCODING_REQUEST_DENIED"
        : status === "OVER_QUERY_LIMIT"
          ? "GEOCODING_QUOTA_EXCEEDED"
          : "GEOCODING_FAILED";
    logMapsFailure(operation, response.status, code);
    throw new Error(code);
  }

  const results = Array.isArray(data?.results) ? (data.results as GeocodingResult[]) : [];
  const first = results[0];
  const lat = first?.geometry?.location?.lat;
  const lng = first?.geometry?.location?.lng;
  const formatted = first?.formatted_address;
  if (!isFiniteNumber(lat) || !isFiniteNumber(lng) || typeof formatted !== "string" || !formatted) {
    logMapsFailure(operation, response.status, "GEOCODING_FAILED");
    throw new Error("GEOCODING_FAILED");
  }

  console.info("[google-maps]", {
    operation,
    responseStatus: response.status,
    errorCode: null,
  });
  return { lat, lng, formatted };
}

export async function geocodeAddress(address: string): Promise<GeocodedLocation> {
  return geocode(new URLSearchParams({ address }), "forwardGeocode");
}

export async function reverseGeocodeLatLng(lat: number, lng: number): Promise<GeocodedLocation> {
  return geocode(new URLSearchParams({ latlng: `${lat},${lng}` }), "reverseGeocode");
}

export async function searchNearbyScenicPlaces(input: {
  center: { lat: number; lng: number };
  radiusMeters: number;
  includedTypes: string[];
}): Promise<NearbyScenicPlace[]> {
  if (input.includedTypes.length === 0) return [];
  let response: Response;
  try {
    response = await fetchWithTimeout(PLACES_NEARBY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": mapsKey(),
        "X-Goog-FieldMask":
          "places.id,places.location,places.primaryType,places.types,places.displayName,places.primaryTypeDisplayName,places.rating,places.userRatingCount",
      },
      body: JSON.stringify({
        includedTypes: input.includedTypes,
        maxResultCount: 10,
        rankPreference: "DISTANCE",
        locationRestriction: {
          circle: {
            center: { latitude: input.center.lat, longitude: input.center.lng },
            radius: Math.max(500, Math.min(10_000, Math.round(input.radiusMeters))),
          },
        },
        languageCode: "en",
      }),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "MAPS_NOT_CONFIGURED") throw error;
    throw new Error("PLACES_FAILED");
  }
  if (!response.ok) throw new Error("PLACES_FAILED");
  const data = (await response.json().catch(() => null)) as { places?: unknown } | null;
  const places = Array.isArray(data?.places) ? data.places : [];
  return places.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const place = value as {
      id?: unknown;
      location?: { latitude?: unknown; longitude?: unknown };
      primaryType?: unknown;
      types?: unknown;
      displayName?: { text?: unknown };
      primaryTypeDisplayName?: { text?: unknown };
      rating?: unknown;
      userRatingCount?: unknown;
    };
    const lat = place.location?.latitude;
    const lng = place.location?.longitude;
    if (typeof place.id !== "string" || !isFiniteNumber(lat) || !isFiniteNumber(lng)) return [];
    return [
      {
        id: place.id,
        lat,
        lng,
        primaryType: typeof place.primaryType === "string" ? place.primaryType : "",
        types: Array.isArray(place.types)
          ? place.types.filter((type): type is string => typeof type === "string")
          : [],
        displayName:
          typeof place.displayName?.text === "string" ? place.displayName.text : undefined,
        categoryName:
          typeof place.primaryTypeDisplayName?.text === "string"
            ? place.primaryTypeDisplayName.text
            : undefined,
        rating: isFiniteNumber(place.rating) ? place.rating : undefined,
        userRatingCount: isFiniteNumber(place.userRatingCount) ? place.userRatingCount : undefined,
      },
    ];
  });
}

function seconds(value: unknown): number {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?s$/.test(value)) return 0;
  return Math.round(Number.parseFloat(value.slice(0, -1)));
}

function formatMeters(value: number): string {
  return `${(value / 1000).toFixed(1)} km`;
}

function formatDuration(value: number): string {
  const hours = Math.floor(value / 3600);
  const minutes = Math.round((value % 3600) / 60);
  return hours > 0 ? `${hours} hr ${minutes} min` : `${minutes} min`;
}

function parseRoute(route: RawRoute | undefined): ComputedDirections | null {
  const encodedPolyline = route?.polyline?.encodedPolyline;
  const distanceMeters = route?.distanceMeters;
  const durationSeconds = seconds(route?.duration);
  if (
    typeof encodedPolyline !== "string" ||
    !encodedPolyline ||
    !isFiniteNumber(distanceMeters) ||
    distanceMeters < 0 ||
    durationSeconds <= 0
  ) {
    return null;
  }

  const steps: NavStep[] = [];
  for (const leg of route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      const stepDistance = isFiniteNumber(step.distanceMeters) ? step.distanceMeters : 0;
      const stepDuration = seconds(step.staticDuration);
      const instruction = step.navigationInstruction?.instructions;
      const maneuver = step.navigationInstruction?.maneuver;
      steps.push({
        instruction: typeof instruction === "string" ? instruction : "Continue",
        maneuver: typeof maneuver === "string" ? maneuver : undefined,
        distance: stepDistance ? formatMeters(stepDistance) : "",
        duration: stepDuration ? formatDuration(stepDuration) : "",
        distanceMeters: stepDistance,
        durationSeconds: stepDuration,
        startLat: isFiniteNumber(step.startLocation?.latLng?.latitude)
          ? step.startLocation.latLng.latitude
          : undefined,
        startLng: isFiniteNumber(step.startLocation?.latLng?.longitude)
          ? step.startLocation.latLng.longitude
          : undefined,
        endLat: isFiniteNumber(step.endLocation?.latLng?.latitude)
          ? step.endLocation.latLng.latitude
          : undefined,
        endLng: isFiniteNumber(step.endLocation?.latLng?.longitude)
          ? step.endLocation.latLng.longitude
          : undefined,
      });
    }
  }

  return {
    encodedPolyline,
    distance: formatMeters(distanceMeters),
    duration: formatDuration(durationSeconds),
    distanceMeters,
    durationSeconds,
    steps,
  };
}

export async function computeDirections(input: {
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  waypoints: { lat: number; lng: number }[];
  alternatives?: boolean;
  avoidHighways?: boolean;
}): Promise<ComputedDirections> {
  const body: Record<string, unknown> = {
    origin: { location: { latLng: { latitude: input.origin.lat, longitude: input.origin.lng } } },
    destination: {
      location: { latLng: { latitude: input.destination.lat, longitude: input.destination.lng } },
    },
    intermediates: input.waypoints.map((waypoint) => ({
      location: { latLng: { latitude: waypoint.lat, longitude: waypoint.lng } },
    })),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    languageCode: "en-US",
    units: "METRIC",
  };
  if (input.avoidHighways) body.routeModifiers = { avoidHighways: true };
  if (input.alternatives && input.waypoints.length === 0) body.computeAlternativeRoutes = true;

  let response: Response;
  try {
    response = await fetchWithTimeout(ROUTES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": mapsKey(),
        "X-Goog-FieldMask": ROUTES_FIELD_MASK,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "MAPS_NOT_CONFIGURED") throw error;
    logMapsFailure("computeRoutes", 0, "DIRECTIONS_FAILED");
    throw new Error("DIRECTIONS_FAILED");
  }

  if (!response.ok) {
    logMapsFailure("computeRoutes", response.status, "DIRECTIONS_FAILED");
    throw new Error("DIRECTIONS_FAILED");
  }

  const data = (await response.json().catch(() => null)) as { routes?: unknown } | null;
  const routes = Array.isArray(data?.routes) ? (data.routes as RawRoute[]) : [];
  logRoutesSuccess(response.status, routes);
  if (routes.length > 0 && routes.every((route) => seconds(route.duration) <= 0)) {
    logMapsFailure("computeRoutes", response.status, "MALFORMED_ROUTE_DURATION");
    throw new Error("MALFORMED_ROUTE_DURATION");
  }

  const parsedRoutes = routes
    .map(parseRoute)
    .filter((route): route is ComputedDirections => !!route);
  const route = parsedRoutes[0];
  if (!route) {
    logMapsFailure("computeRoutes", response.status, "DIRECTIONS_FAILED");
    throw new Error("DIRECTIONS_FAILED");
  }

  const alternatives = parsedRoutes.slice(1).map((candidate) => ({
    encodedPolyline: candidate.encodedPolyline,
    distanceMeters: candidate.distanceMeters,
    durationSeconds: candidate.durationSeconds,
  }));

  return {
    ...route,
    alternatives: alternatives.length ? alternatives : undefined,
    candidates: input.alternatives ? parsedRoutes : undefined,
  };
}
