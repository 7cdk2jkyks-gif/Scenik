import { useEffect, useRef, useState } from "react";
import { loadGoogleMaps } from "@/lib/google-maps-loader";
import { decodePolyline } from "@/lib/polyline";
import { WifiOff } from "lucide-react";

type LatLngLiteral = { lat: number; lng: number };

let latestKnownUserLocation: LatLngLiteral | null = null;

declare global {
  interface Window {
    google?: {
      maps: {
        LatLngBounds: new () => { extend: (p: LatLngLiteral) => void };
        Map: new (
          el: HTMLElement,
          opts: Record<string, unknown>,
        ) => {
          fitBounds: (b: unknown, padding?: number) => void;
          panTo: (p: LatLngLiteral) => void;
          setCenter: (p: LatLngLiteral) => void;
          setZoom: (z: number) => void;
          setOptions: (opts: Record<string, unknown>) => void;
          addListener: (
            ev: string,
            cb: (e: { latLng?: { lat: () => number; lng: () => number } }) => void,
          ) => { remove?: () => void };
        };
        Marker: new (opts: Record<string, unknown>) => {
          setMap: (m: unknown | null) => void;
          setPosition: (p: LatLngLiteral) => void;
          addListener?: (ev: string, cb: () => void) => void;
        };
        Polyline: new (opts: Record<string, unknown>) => { setMap: (m: unknown | null) => void };
        Circle: new (opts: Record<string, unknown>) => {
          setMap: (m: unknown | null) => void;
          setCenter: (p: LatLngLiteral) => void;
          setRadius: (r: number) => void;
        };
        TrafficLayer: new () => { setMap: (m: unknown | null) => void };
        InfoWindow: new (opts?: Record<string, unknown>) => {
          open: (opts: Record<string, unknown>) => void;
          close: () => void;
          setContent: (c: string | HTMLElement) => void;
        };
        Point: new (x: number, y: number) => unknown;
        Size: new (w: number, h: number) => unknown;
        SymbolPath: { CIRCLE: number };
        event: { removeListener: (l: unknown) => void };
        geometry?: {
          encoding: {
            decodePath: (encoded: string) => Array<{ lat: () => number; lng: () => number }>;
          };
        };
      };
    };
  }
}

export interface RoadReportMarker {
  id: string;
  kind: "camera" | "closure" | "works" | "hazard";
  lat: number;
  lng: number;
  note?: string;
  mine?: boolean;
}

export interface MapPoint {
  lat: number;
  lng: number;
  label?: string;
  kind?: "start" | "end" | "waypoint";
}

export interface DirectionStep {
  instruction: string;
  distance: string;
  duration: string;
}

export interface RouteSummary {
  distance: string;
  duration: string;
  steps: DirectionStep[];
}

export type LocationPermission = "prompt" | "granted" | "denied" | "unsupported" | "error";

export interface RouteProgress {
  onRoute: boolean;
  percent: number; // 0-100
  remainingMeters: number;
  remainingSeconds: number;
  distanceFromRouteMeters: number;
}

export interface NavStepInput {
  distanceMeters: number;
  instruction?: string;
  maneuver?: string;
  endLat?: number;
  endLng?: number;
}

export interface StepProgress {
  stepIndex: number;
  distanceToManeuverMeters: number;
  step: NavStepInput;
}

export function ScenicMap({
  points,
  encodedPolyline,
  className,
  onError,
  showUserLocation = false,
  onLocationStatus,
  routeDistanceMeters,
  routeDurationSeconds,
  onProgress,
  navMode = false,
  steps,
  onStepChange,
  onReroute,
  showTraffic = false,
  reports = [],
  onMapClick,
  onReportDelete,
  alternateRoutes = [],
  onAlternateClick,
  onLocationTick,
  initialUserLocation,
  onUserLocationChange,
  locationRetryKey = 0,
  offline = false,
}: {
  points: MapPoint[];
  encodedPolyline?: string;
  className?: string;
  onError?: (message: string) => void;
  showUserLocation?: boolean;
  onLocationStatus?: (status: LocationPermission, message?: string) => void;
  routeDistanceMeters?: number;
  routeDurationSeconds?: number;
  onProgress?: (p: RouteProgress | null) => void;
  navMode?: boolean;
  steps?: NavStepInput[];
  onStepChange?: (s: StepProgress | null) => void;
  onReroute?: (pos: LatLngLiteral) => void;
  showTraffic?: boolean;
  reports?: RoadReportMarker[];
  onMapClick?: (p: LatLngLiteral) => void;
  onReportDelete?: (id: string) => void;
  alternateRoutes?: Array<{ id: string; encodedPolyline: string }>;
  onAlternateClick?: (id: string) => void;
  onLocationTick?: (p: LatLngLiteral) => void;
  initialUserLocation?: LatLngLiteral | null;
  onUserLocationChange?: (p: LatLngLiteral) => void;
  /** Bump this number to force re-requesting geolocation permission. */
  locationRetryKey?: number;
  /** Skip loading Google Maps tiles/imagery; still track GPS + progress from cached route data. */
  offline?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<InstanceType<NonNullable<Window["google"]>["maps"]["Map"]> | null>(null);
  const userMarkerRef = useRef<InstanceType<
    NonNullable<Window["google"]>["maps"]["Marker"]
  > | null>(null);
  const accuracyCircleRef = useRef<InstanceType<
    NonNullable<Window["google"]>["maps"]["Circle"]
  > | null>(null);
  const completedLineRef = useRef<{
    setMap: (m: unknown | null) => void;
    setPath?: (p: LatLngLiteral[]) => void;
  } | null>(null);
  const pathRef = useRef<LatLngLiteral[]>([]);
  const cumDistRef = useRef<number[]>([]);
  const totalPathDistRef = useRef<number>(0);
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const onStepChangeRef = useRef(onStepChange);
  onStepChangeRef.current = onStepChange;
  const onRerouteRef = useRef(onReroute);
  onRerouteRef.current = onReroute;
  const stepCumRef = useRef<number[]>([]);
  const stepsRef = useRef<NavStepInput[] | undefined>(steps);
  stepsRef.current = steps;
  const routeDistanceMetersRef = useRef(routeDistanceMeters);
  routeDistanceMetersRef.current = routeDistanceMeters;
  const routeDurationSecondsRef = useRef(routeDurationSeconds);
  routeDurationSecondsRef.current = routeDurationSeconds;
  const offRouteSinceRef = useRef<number | null>(null);
  const lastRerouteAtRef = useRef<number>(0);
  const navModeRef = useRef(navMode);
  navModeRef.current = navMode;
  const cameraInitRef = useRef(false);
  const noRoutePannedRef = useRef(false);
  const onLocationTickRef = useRef(onLocationTick);
  onLocationTickRef.current = onLocationTick;
  const onUserLocationChangeRef = useRef(onUserLocationChange);
  onUserLocationChangeRef.current = onUserLocationChange;
  const lastTickAtRef = useRef<number>(0);
  // GPS smoothing state
  const smoothedRef = useRef<{ lat: number; lng: number; accuracy: number; t: number } | null>(
    null,
  );
  const lastDisplayRef = useRef<LatLngLiteral | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const markers: Array<{ setMap: (m: unknown | null) => void }> = [];
    let polyline: { setMap: (m: unknown | null) => void } | null = null;

    // Offline branch: skip Google Maps entirely (no tile requests) but still
    // populate path refs from the cached polyline so GPS progress + step
    // tracking keep working. Tiles are never cached — Google ToS-compliant.
    if (offline) {
      if (encodedPolyline) {
        try {
          const latLngs = decodePolyline(encodedPolyline);
          if (latLngs.length >= 2) {
            pathRef.current = latLngs;
            const cum: number[] = [0];
            let total = 0;
            for (let i = 1; i < latLngs.length; i++) {
              total += haversineMeters(latLngs[i - 1], latLngs[i]);
              cum.push(total);
            }
            cumDistRef.current = cum;
            totalPathDistRef.current = total;
          }
        } catch {
          /* noop — progress will simply be inert */
        }
      }
      return () => {
        cancelled = true;
        pathRef.current = [];
        cumDistRef.current = [];
        totalPathDistRef.current = 0;
      };
    }

    loadGoogleMaps()
      .then(() => {
        if (cancelled || !ref.current || !window.google) return;
        const g = window.google;

        // When entering nav mode with a known last position, boot the map
        // already centred+zoomed on the user so there's no visible camera jump.
        const knownUserLocation =
          lastDisplayRef.current ?? latestKnownUserLocation ?? initialUserLocation;
        const bootAtUser = navModeRef.current && knownUserLocation;
        const center = bootAtUser
          ? knownUserLocation!
          : (points[0] ?? { lat: 37.7749, lng: -122.4194 });
        const map = new g.maps.Map(ref.current, {
          center: { lat: center.lat, lng: center.lng },
          zoom: navModeRef.current ? 17 : 8,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          gestureHandling: "greedy",
          styles: [
            { elementType: "geometry", stylers: [{ color: "#f5ecd9" }] },
            { elementType: "labels.text.stroke", stylers: [{ color: "#f5ecd9" }] },
            { elementType: "labels.text.fill", stylers: [{ color: "#5a4632" }] },
            { featureType: "water", stylers: [{ color: "#a8c8c4" }] },
            { featureType: "road", elementType: "geometry", stylers: [{ color: "#e8d6b0" }] },
            {
              featureType: "road.highway",
              elementType: "geometry",
              stylers: [{ color: "#d9b27a" }],
            },
            { featureType: "landscape.natural", stylers: [{ color: "#e9dcb6" }] },
            { featureType: "poi.park", stylers: [{ color: "#c7d2a6" }] },
            { featureType: "transit", stylers: [{ visibility: "off" }] },
          ],
        });
        mapRef.current = map;

        if (points.length > 0) {
          const bounds = new g.maps.LatLngBounds();
          points.forEach((p) => bounds.extend({ lat: p.lat, lng: p.lng }));

          points.forEach((p, i) => {
            const isStart = p.kind === "start";
            const isEnd = p.kind === "end";
            const m = new g.maps.Marker({
              map,
              position: { lat: p.lat, lng: p.lng },
              label: isStart ? "A" : isEnd ? "B" : String(i),
              title: p.label,
            });
            markers.push(m);
          });

          if (encodedPolyline && g.maps.geometry?.encoding) {
            try {
              const path = g.maps.geometry.encoding.decodePath(encodedPolyline);
              const latLngs = path.map((p) => ({ lat: p.lat(), lng: p.lng() }));
              latLngs.forEach((p) => bounds.extend(p));
              // Outer soft glow (wide, low opacity) — gives the line a clean halo on any basemap
              new g.maps.Polyline({
                map,
                path: latLngs,
                strokeColor: "#ffffff",
                strokeWeight: 13,
                strokeOpacity: 0.55,
                geodesic: true,
                clickable: false,
                zIndex: 48,
              });
              // Dark casing for crisp edges
              new g.maps.Polyline({
                map,
                path: latLngs,
                strokeColor: "#7a1f0d",
                strokeWeight: 9,
                strokeOpacity: 0.95,
                geodesic: true,
                clickable: false,
                zIndex: 49,
              });
              // Main route stroke
              polyline = new g.maps.Polyline({
                map,
                path: latLngs,
                strokeColor: "#ff6a44",
                strokeWeight: 5,
                strokeOpacity: 1,
                geodesic: true,
                clickable: false,
                zIndex: 50,
              });
              // Cache path + cumulative distances for progress tracking
              pathRef.current = latLngs;
              const cum: number[] = [0];
              let total = 0;
              for (let i = 1; i < latLngs.length; i++) {
                total += haversineMeters(latLngs[i - 1], latLngs[i]);
                cum.push(total);
              }
              cumDistRef.current = cum;
              totalPathDistRef.current = total;
              // Completed (traveled) overlay — starts empty, drawn in deep green
              completedLineRef.current = new g.maps.Polyline({
                map,
                path: [],
                strokeColor: "#1f7a3a",
                strokeWeight: 5,
                strokeOpacity: 1,
                geodesic: true,
                clickable: false,
                zIndex: 51,
              }) as { setMap: (m: unknown | null) => void; setPath?: (p: LatLngLiteral[]) => void };
            } catch {
              onError?.("Unable to draw route on map.");
            }
          }

          // In nav mode, stay locked on the user — do not fit the whole route bounds.
          if (!navModeRef.current) map.fitBounds(bounds, 60);
        }

        setMapReady(true);
      })
      .catch((err) => {
        console.error(err);
        onError?.("Unable to load map. Please try again.");
      });

    return () => {
      cancelled = true;
      markers.forEach((m) => m.setMap(null));
      if (polyline) polyline.setMap(null);
      completedLineRef.current?.setMap(null);
      completedLineRef.current = null;
      userMarkerRef.current?.setMap(null);
      accuracyCircleRef.current?.setMap(null);
      userMarkerRef.current = null;
      accuracyCircleRef.current = null;
      pathRef.current = [];
      cumDistRef.current = [];
      totalPathDistRef.current = 0;
      setMapReady(false);
      mapRef.current = null;
    };
  }, [JSON.stringify(points), encodedPolyline, offline]);

  // User location tracking — start the browser GPS watch as soon as the caller
  // asks for location, even if Google Maps is still loading.
  useEffect(() => {
    if (!showUserLocation) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      onLocationStatus?.("unsupported", "Location is not supported on this device.");
      return;
    }

    let watchId: number | null = null;
    let firstFix = true;
    const hasRoute = points.length > 0;
    noRoutePannedRef.current = false;

    const updatePosition = (pos: GeolocationPosition) => {
      const rawPt = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      latestKnownUserLocation = rawPt;
      onUserLocationChangeRef.current?.(rawPt);
      const rawAccuracy = pos.coords.accuracy ?? 30;
      const nowMs = Date.now();

      // --- GPS smoothing: reject wild jumps, blend with previous via accuracy-weighted EMA ---
      // Drop low-quality readings (very large accuracy) unless we have no fix yet
      if (smoothedRef.current && rawAccuracy > 150) return;

      let smoothedPt: LatLngLiteral;
      let accuracy: number;
      if (!smoothedRef.current) {
        smoothedPt = rawPt;
        accuracy = rawAccuracy;
      } else {
        const prev = smoothedRef.current;
        const dt = Math.max(0.1, (nowMs - prev.t) / 1000);
        const dist = haversineMeters(prev, rawPt);
        // Reject impossible jumps (> 60 m/s ≈ 216 km/h) — likely a fix glitch
        if (dist / dt > 60) return;
        // Accuracy-weighted blend: trust the more accurate of (prediction, new reading)
        const predVar = prev.accuracy * prev.accuracy + Math.min(900, dt * dt * 4); // process noise
        const measVar = rawAccuracy * rawAccuracy;
        const k = predVar / (predVar + measVar); // Kalman gain
        smoothedPt = {
          lat: prev.lat + k * (rawPt.lat - prev.lat),
          lng: prev.lng + k * (rawPt.lng - prev.lng),
        };
        accuracy = Math.sqrt((1 - k) * predVar);
      }
      smoothedRef.current = { ...smoothedPt, accuracy, t: nowMs };
      latestKnownUserLocation = smoothedPt;
      onUserLocationChangeRef.current?.(smoothedPt);

      if (firstFix) {
        firstFix = false;
        onLocationStatus?.("granted");
      }

      // Notify callers immediately on GPS fixes, even while the map is still booting.
      const nowTick = Date.now();
      if (onLocationTickRef.current && nowTick - lastTickAtRef.current > 15000) {
        lastTickAtRef.current = nowTick;
        try {
          onLocationTickRef.current(smoothedPt);
        } catch {
          /* noop */
        }
      }

      const g = window.google;
      const map = mapRef.current;
      const pt = smoothedPt;

      // Map-dependent rendering (marker, accuracy circle, panning, camera).
      // Skipped entirely when Google Maps hasn't loaded (offline mode or
      // still-booting map) — progress tracking below still runs.
      if (g && map) {
        // --- Smooth marker animation between fixes ---
        const startPt = lastDisplayRef.current ?? smoothedPt;
        const endPt = smoothedPt;
        const animStart = nowMs;
        const animDur = 800; // ms
        if (animFrameRef.current != null) cancelAnimationFrame(animFrameRef.current);
        const step = () => {
          const t = Math.min(1, (Date.now() - animStart) / animDur);
          const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOutQuad
          const interp = {
            lat: startPt.lat + (endPt.lat - startPt.lat) * e,
            lng: startPt.lng + (endPt.lng - startPt.lng) * e,
          };
          if (!userMarkerRef.current) {
            userMarkerRef.current = new g.maps.Marker({
              map,
              position: interp,
              title: "Your location",
              zIndex: 9999,
              icon: {
                path: g.maps.SymbolPath.CIRCLE,
                scale: 8,
                fillColor: "#1a73e8",
                fillOpacity: 1,
                strokeColor: "#ffffff",
                strokeWeight: 3,
              },
            });
            accuracyCircleRef.current = new g.maps.Circle({
              map,
              center: interp,
              radius: accuracy,
              fillColor: "#1a73e8",
              fillOpacity: 0.15,
              strokeColor: "#1a73e8",
              strokeOpacity: 0.3,
              strokeWeight: 1,
            });
          } else {
            userMarkerRef.current.setPosition(interp);
            accuracyCircleRef.current?.setCenter(interp);
            accuracyCircleRef.current?.setRadius(accuracy);
          }
          if (navModeRef.current) map.setCenter(interp);
          lastDisplayRef.current = interp;
          if (t < 1) animFrameRef.current = requestAnimationFrame(step);
          else animFrameRef.current = null;
        };
        animFrameRef.current = requestAnimationFrame(step);

        if (!hasRoute && !noRoutePannedRef.current) {
          noRoutePannedRef.current = true;
          map.panTo(pt);
        }

        // Navigation camera: zoom in on first nav fix (panning handled by animation loop)
        if (navModeRef.current && !cameraInitRef.current) {
          cameraInitRef.current = true;
          map.setCenter(pt);
          map.setZoom(17);
        }
      } else {
        // No map yet — still record the display point so any future map init
        // can boot centred on the user.
        lastDisplayRef.current = smoothedPt;
      }

      // Route progress
      if (pathRef.current.length >= 2 && totalPathDistRef.current > 0) {
        const snap = snapToPath(pt, pathRef.current, cumDistRef.current);
        const currentRouteDistanceMeters = routeDistanceMetersRef.current;
        const currentRouteDurationSeconds = routeDurationSecondsRef.current;
        const totalRouteMeters =
          currentRouteDistanceMeters && currentRouteDistanceMeters > 0
            ? currentRouteDistanceMeters
            : totalPathDistRef.current;
        const traveled = (snap.traveledMeters / totalPathDistRef.current) * totalRouteMeters;
        const remaining = Math.max(0, totalRouteMeters - traveled);
        const percent = Math.max(0, Math.min(100, (traveled / totalRouteMeters) * 100));
        const onRoute = snap.distanceMeters < Math.max(80, (pos.coords.accuracy ?? 0) + 50);
        const remainingSec =
          currentRouteDurationSeconds && totalRouteMeters > 0
            ? (remaining / totalRouteMeters) * currentRouteDurationSeconds
            : 0;

        if (onRoute && completedLineRef.current?.setPath) {
          const completed = pathRef.current.slice(0, snap.segmentIndex + 1).concat([snap.snapped]);
          completedLineRef.current.setPath(completed);
        } else if (!onRoute && completedLineRef.current?.setPath) {
          completedLineRef.current.setPath([]);
        }

        onProgressRef.current?.({
          onRoute,
          percent,
          remainingMeters: remaining,
          remainingSeconds: remainingSec,
          distanceFromRouteMeters: snap.distanceMeters,
        });

        // Step tracking
        const stepArr = stepsRef.current;
        const stepCum = stepCumRef.current;
        if (stepArr && stepArr.length > 0 && stepCum.length === stepArr.length) {
          let idx = stepCum.findIndex((c) => c > traveled + 1);
          if (idx < 0) idx = stepArr.length - 1;
          const dist = Math.max(0, stepCum[idx] - traveled);
          onStepChangeRef.current?.({
            stepIndex: idx,
            distanceToManeuverMeters: dist,
            step: stepArr[idx],
          });
        }

        // Off-route → trigger reroute (smoothed accuracy + faster reaction)
        if (navModeRef.current && onRerouteRef.current) {
          const now = Date.now();
          const acc = smoothedRef.current?.accuracy ?? rawAccuracy;
          const farOff = snap.distanceMeters > Math.max(60, acc + 40);
          if (farOff) {
            if (offRouteSinceRef.current === null) offRouteSinceRef.current = now;
            const offFor = now - (offRouteSinceRef.current ?? now);
            const sinceLast = now - lastRerouteAtRef.current;
            // React after ~5s sustained off-route, with a 20s cooldown between recomputes
            if (offFor > 5000 && sinceLast > 20000) {
              lastRerouteAtRef.current = now;
              offRouteSinceRef.current = null;
              onRerouteRef.current(pt);
            }
          } else {
            offRouteSinceRef.current = null;
          }
        }
      }
    };

    const handleError = (err: GeolocationPositionError) => {
      if (err.code === err.PERMISSION_DENIED) {
        // The browser reports PERMISSION_DENIED for two very different reasons:
        //  1) the user actually blocked location for this origin, or
        //  2) the page runs in a context that isn't allowed to request location
        //     (e.g. an iframe without allow="geolocation", or non-secure origin).
        // Ask the Permissions API which one it is so we can show an accurate message.
        const nav = typeof navigator !== "undefined" ? navigator : null;
        const permQuery = nav?.permissions?.query?.({ name: "geolocation" as PermissionName });
        if (permQuery && typeof permQuery.then === "function") {
          permQuery
            .then((status) => {
              if (status.state === "denied") {
                onLocationStatus?.(
                  "denied",
                  "Location permission is blocked for this site. Enable it in your browser's site settings, then tap Try again.",
                );
              } else {
                onLocationStatus?.(
                  "denied",
                  "This page couldn't access your location. If you're viewing Scenik inside a preview or embed, open it in a new tab and try again.",
                );
              }
            })
            .catch(() =>
              onLocationStatus?.(
                "denied",
                "Location permission was denied. Tap Try again to request it once more.",
              ),
            );
        } else {
          onLocationStatus?.(
            "denied",
            "Location permission was denied. Tap Try again to request it once more.",
          );
        }
      } else if (err.code === err.POSITION_UNAVAILABLE) {
        onLocationStatus?.("error", "Your location is unavailable right now. Tap Try again.");
      } else if (err.code === err.TIMEOUT) {
        onLocationStatus?.("error", "Locating you took too long. Tap Try again.");
      } else {
        onLocationStatus?.("error", "Unable to access your location. Tap Try again.");
      }
    };

    onLocationStatus?.("prompt");
    watchId = navigator.geolocation.watchPosition(updatePosition, handleError, {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 15000,
    });

    return () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (animFrameRef.current != null) cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
      userMarkerRef.current?.setMap(null);
      accuracyCircleRef.current?.setMap(null);
      userMarkerRef.current = null;
      accuracyCircleRef.current = null;
      smoothedRef.current = null;
      lastDisplayRef.current = null;
    };
  }, [showUserLocation, points.length === 0, locationRetryKey]);

  // If GPS returns before the map is ready, paint the latest fix immediately
  // once the map exists instead of waiting for the next watchPosition tick.
  useEffect(() => {
    if (!showUserLocation || !mapReady || !mapRef.current || !window.google) return;
    const pt = lastDisplayRef.current ?? latestKnownUserLocation ?? initialUserLocation;
    if (!pt || userMarkerRef.current) return;
    const g = window.google;
    const map = mapRef.current;
    userMarkerRef.current = new g.maps.Marker({
      map,
      position: pt,
      title: "Your location",
      zIndex: 9999,
      icon: {
        path: g.maps.SymbolPath.CIRCLE,
        scale: 8,
        fillColor: "#1a73e8",
        fillOpacity: 1,
        strokeColor: "#ffffff",
        strokeWeight: 3,
      },
    });
    accuracyCircleRef.current = new g.maps.Circle({
      map,
      center: pt,
      radius: 30,
      fillColor: "#1a73e8",
      fillOpacity: 0.15,
      strokeColor: "#1a73e8",
      strokeOpacity: 0.3,
      strokeWeight: 1,
    });
    lastDisplayRef.current = pt;
    if (navModeRef.current) {
      cameraInitRef.current = true;
      map.setCenter(pt);
      map.setZoom(17);
    }
  }, [showUserLocation, mapReady, initialUserLocation?.lat, initialUserLocation?.lng]);

  // Precompute step cumulative distances
  useEffect(() => {
    if (!steps || steps.length === 0) {
      stepCumRef.current = [];
      return;
    }
    const totalSteps = steps.reduce((a, s) => a + (s.distanceMeters || 0), 0);
    const totalRoute =
      routeDistanceMeters && routeDistanceMeters > 0 ? routeDistanceMeters : totalSteps;
    const scale = totalSteps > 0 ? totalRoute / totalSteps : 1;
    const cum: number[] = [];
    let acc = 0;
    for (const s of steps) {
      acc += (s.distanceMeters || 0) * scale;
      cum.push(acc);
    }
    stepCumRef.current = cum;
  }, [steps, routeDistanceMeters]);

  // Reset camera-init flag whenever nav mode toggles
  useEffect(() => {
    if (!navMode) {
      cameraInitRef.current = false;
      return;
    }
    if (!mapReady || !mapRef.current) return;
    if (cameraInitRef.current) return;
    // If any map instance already has a location fix, jump instantly.
    const knownUserLocation =
      lastDisplayRef.current ?? latestKnownUserLocation ?? initialUserLocation;
    if (knownUserLocation) {
      cameraInitRef.current = true;
      mapRef.current.setCenter(knownUserLocation);
      mapRef.current.setZoom(17);
      return;
    }
    // Otherwise ask the browser for the cached position — returns instantly
    // when permission was already granted, so we don't wait for a fresh fix.
    if (typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const pt = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          if (!mapRef.current) return;
          cameraInitRef.current = true;
          mapRef.current.setCenter(pt);
          mapRef.current.setZoom(17);
        },
        () => {
          /* ignore — watchPosition will catch up */
        },
        { maximumAge: Infinity, timeout: 0, enableHighAccuracy: false },
      );
    }
  }, [navMode, mapReady, initialUserLocation?.lat, initialUserLocation?.lng]);

  // Wake lock during navigation
  useEffect(() => {
    if (!navMode) return;
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> };
    };
    if (nav.wakeLock?.request) {
      nav.wakeLock
        .request("screen")
        .then((l) => {
          lock = l;
        })
        .catch(() => {});
    }
    const onVis = () => {
      if (document.visibilityState === "visible" && nav.wakeLock?.request && !lock) {
        nav.wakeLock
          .request("screen")
          .then((l) => {
            lock = l;
          })
          .catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      lock?.release().catch(() => {});
    };
  }, [navMode]);

  // Traffic layer toggle
  useEffect(() => {
    if (!mapReady || !mapRef.current || !window.google) return;
    if (!showTraffic) return;
    const layer = new window.google.maps.TrafficLayer();
    layer.setMap(mapRef.current);
    return () => layer.setMap(null);
  }, [showTraffic, mapReady]);

  // Map click → report callback
  useEffect(() => {
    if (!mapReady || !mapRef.current || !window.google || !onMapClick) return;
    const map = mapRef.current;
    const listener = map.addListener("click", (e) => {
      if (!e.latLng) return;
      onMapClick({ lat: e.latLng.lat(), lng: e.latLng.lng() });
    });
    return () => {
      try {
        window.google?.maps.event.removeListener(listener);
      } catch {
        /* noop */
      }
    };
  }, [mapReady, onMapClick]);

  // Road report markers
  const reportsKey = reports.map((r) => `${r.id}:${r.kind}:${r.mine ? 1 : 0}`).join("|");
  useEffect(() => {
    if (!mapReady || !mapRef.current || !window.google) return;
    const g = window.google;
    const map = mapRef.current;
    const markers: Array<{ setMap: (m: unknown | null) => void }> = [];
    const info = new g.maps.InfoWindow();
    const colors: Record<RoadReportMarker["kind"], string> = {
      camera: "#dc2626",
      closure: "#7c2d12",
      works: "#ca8a04",
      hazard: "#ea580c",
    };
    const labels: Record<RoadReportMarker["kind"], string> = {
      camera: "📷",
      closure: "⛔",
      works: "🚧",
      hazard: "⚠️",
    };
    reports.forEach((r) => {
      const m = new g.maps.Marker({
        map,
        position: { lat: r.lat, lng: r.lng },
        title: `${r.kind}${r.note ? ` — ${r.note}` : ""}`,
        label: { text: labels[r.kind], fontSize: "16px" },
        icon: {
          path: g.maps.SymbolPath.CIRCLE,
          scale: 14,
          fillColor: colors[r.kind],
          fillOpacity: 0.95,
          strokeColor: "#ffffff",
          strokeWeight: 2,
        },
        zIndex: 5000,
      });
      m.addListener?.("click", () => {
        const safeNote = (r.note ?? "").replace(
          /[<>&"']/g,
          (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
        );
        const html = `
          <div style="font-family: inherit; font-size: 12px; max-width: 200px;">
            <div style="font-weight:600; text-transform:capitalize; margin-bottom:4px;">${r.kind}</div>
            ${safeNote ? `<div style="color:#555; margin-bottom:6px;">${safeNote}</div>` : ""}
            ${r.mine && onReportDelete ? `<button id="del-${r.id}" style="background:#dc2626;color:#fff;border:0;border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;">Remove</button>` : ""}
          </div>`;
        info.setContent(html);
        info.open({ map, anchor: m });
        if (r.mine && onReportDelete) {
          setTimeout(() => {
            const btn = document.getElementById(`del-${r.id}`);
            btn?.addEventListener(
              "click",
              () => {
                onReportDelete(r.id);
                info.close();
              },
              { once: true },
            );
          }, 0);
        }
      });
      markers.push(m);
    });
    return () => {
      markers.forEach((m) => m.setMap(null));
      try {
        info.close();
      } catch {
        /* noop */
      }
    };
  }, [mapReady, reportsKey, onReportDelete]);

  // Alternate routes (drawn as dashed grey lines under main route)
  const altKey = alternateRoutes.map((a) => a.id).join("|");
  useEffect(() => {
    if (!mapReady || !mapRef.current || !window.google?.maps.geometry?.encoding) return;
    const g = window.google;
    const map = mapRef.current;
    const lines: Array<{ setMap: (m: unknown | null) => void }> = [];
    alternateRoutes.forEach((alt) => {
      try {
        const path = g.maps.geometry!.encoding.decodePath(alt.encodedPolyline);
        const latLngs = path.map((p) => ({ lat: p.lat(), lng: p.lng() }));
        // Dashed grey alternate
        const line = new g.maps.Polyline({
          map,
          path: latLngs,
          strokeColor: "#1f2937",
          strokeWeight: 5,
          strokeOpacity: 0,
          geodesic: true,
          clickable: !!onAlternateClick,
          zIndex: 45,
          icons: [
            {
              icon: { path: "M 0,-1 0,1", strokeOpacity: 0.7, strokeWeight: 4, scale: 3 },
              offset: "0",
              repeat: "14px",
            },
          ],
        }) as {
          setMap: (m: unknown | null) => void;
          addListener?: (ev: string, cb: () => void) => void;
        };
        line.addListener?.("click", () => onAlternateClick?.(alt.id));
        lines.push(line);
      } catch {
        /* noop */
      }
    });
    return () => {
      lines.forEach((l) => l.setMap(null));
    };
  }, [mapReady, altKey, onAlternateClick]);

  if (offline) {
    return (
      <div
        className={`${className ?? "h-full w-full"} relative flex items-center justify-center overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-amber-50 via-stone-50 to-amber-100`}
        aria-label="Offline mode — map imagery unavailable"
      >
        {/* Decorative paper-map texture using CSS only — no external tiles. */}
        <div
          aria-hidden
          className="absolute inset-0 opacity-30"
          style={{
            backgroundImage:
              "repeating-linear-gradient(45deg, rgba(120,80,40,0.08) 0 1px, transparent 1px 22px), repeating-linear-gradient(-45deg, rgba(120,80,40,0.08) 0 1px, transparent 1px 22px)",
          }}
        />
        <div className="relative z-10 mx-4 max-w-sm rounded-xl border border-amber-500/50 bg-background/95 px-5 py-4 text-center shadow-paper">
          <WifiOff className="mx-auto h-6 w-6 text-amber-700" strokeWidth={2} />
          <div className="mt-2 font-serif text-base font-semibold text-ink">Offline Mode</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Map imagery unavailable. Navigation continues using saved route data.
          </p>
        </div>
      </div>
    );
  }
  return <div ref={ref} className={className ?? "h-full w-full rounded-2xl border bg-muted"} />;
}

// ---- Geo helpers ----
const R_EARTH = 6371000;
function toRad(d: number) {
  return (d * Math.PI) / 180;
}
function haversineMeters(a: LatLngLiteral, b: LatLngLiteral): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Project point onto segment AB in a local equirectangular plane, return snapped point + t in [0,1]
function projectOnSegment(
  p: LatLngLiteral,
  a: LatLngLiteral,
  b: LatLngLiteral,
): { snapped: LatLngLiteral; t: number } {
  const latRef = toRad((a.lat + b.lat) / 2);
  const ax = a.lng * Math.cos(latRef),
    ay = a.lat;
  const bx = b.lng * Math.cos(latRef),
    by = b.lat;
  const px = p.lng * Math.cos(latRef),
    py = p.lat;
  const dx = bx - ax,
    dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { snapped: a, t: 0 };
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { snapped: { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) }, t };
}

function snapToPath(
  p: LatLngLiteral,
  path: LatLngLiteral[],
  cum: number[],
): {
  snapped: LatLngLiteral;
  segmentIndex: number;
  traveledMeters: number;
  distanceMeters: number;
} {
  let best = { snapped: path[0], segmentIndex: 0, traveledMeters: 0, distanceMeters: Infinity };
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i],
      b = path[i + 1];
    const { snapped, t } = projectOnSegment(p, a, b);
    const d = haversineMeters(p, snapped);
    if (d < best.distanceMeters) {
      const segLen = cum[i + 1] - cum[i];
      best = { snapped, segmentIndex: i, traveledMeters: cum[i] + t * segLen, distanceMeters: d };
    }
  }
  return best;
}
