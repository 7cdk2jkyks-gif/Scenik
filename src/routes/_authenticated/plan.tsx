import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useRef, useEffect, useMemo } from "react";
import { ChevronDown, ChevronUp, Lock } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  planScenicRoute,
  saveRoute,
  recomputeDirections,
  fetchSpeedLimit,
  reverseGeocode,
  waypointFacts,
  recommendThemesFn,
} from "@/lib/routes.functions";
import {
  saveSearch,
  listSavedSearches,
  deleteSavedSearch,
  clearAllSavedSearches,
} from "@/lib/searches.functions";
import { createRoadReport, listRoadReports, deleteRoadReport } from "@/lib/reports.functions";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  ScenicMap,
  type RouteSummary,
  type LocationPermission,
  type RouteProgress,
  type StepProgress,
  type RoadReportMarker,
} from "@/components/ScenicMap";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  MapPin,
  Bookmark,
  Loader2,
  Navigation,
  RefreshCw,
  AlertTriangle,
  ThumbsUp,
  ThumbsDown,
  Meh,
  Check,
  LocateFixed,
  LocateOff,
  Volume2,
  VolumeX,
  X,
  History,
  Trash2,
  Camera,
  Construction,
  AlertOctagon,
  AlertCircle,
  TrafficCone,
  Gauge,
  Route as RouteIcon,
  Crosshair,
  Plus,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { formatDistance, formatSpeed, useUnits } from "@/lib/units";
import { capture } from "@/lib/analytics/client";
import { AnalyticsEvent } from "@/lib/analytics/events";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { saveLastPlan, loadLastPlan } from "@/lib/offline-cache";
import { OfflineBanner } from "@/components/OfflineBanner";
import { getFastLocation } from "@/lib/geolocation";
import { getPlatform, isNativePlatform } from "@/lib/native";
import { OfflineUpgradeBanner } from "@/components/OfflineUpgradeBanner";
import { LocationDisclosure } from "@/components/LocationDisclosure";
import { useSubscription } from "@/hooks/useSubscription";

type Rating = "excellent" | "average" | "poor";
const MISSING_OPTIONS = [
  "Better scenery",
  "Less traffic",
  "More landmarks",
  "More viewpoints",
  "Other",
];

const REPORT_KINDS: Array<{
  id: RoadReportMarker["kind"];
  label: string;
  Icon: typeof Camera;
  hint: string;
}> = [
  { id: "camera", label: "Speed camera", Icon: Camera, hint: "Fixed or mobile camera" },
  { id: "closure", label: "Road closed", Icon: AlertOctagon, hint: "Blocked, no through traffic" },
  { id: "works", label: "Road works", Icon: Construction, hint: "Lane closures, repairs" },
  { id: "hazard", label: "Hazard", Icon: AlertCircle, hint: "Debris, accident, flooding" },
];

function ReportDialog({
  target,
  onCancel,
  onSubmit,
  submitting,
}: {
  target: { lat: number; lng: number } | null;
  onCancel: () => void;
  onSubmit: (kind: RoadReportMarker["kind"], note: string) => void;
  submitting: boolean;
}) {
  const [kind, setKind] = useState<RoadReportMarker["kind"]>("camera");
  const [note, setNote] = useState("");
  useEffect(() => {
    if (target) {
      setKind("camera");
      setNote("");
    }
  }, [target]);
  return (
    <Dialog
      open={!!target}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-serif">Report on the road</DialogTitle>
          <DialogDescription>Help other drivers by flagging what's at this spot.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {REPORT_KINDS.map(({ id, label, Icon, hint }) => {
            const active = kind === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setKind(id)}
                className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left text-xs transition ${
                  active
                    ? "border-primary bg-primary/5"
                    : "border-border bg-background hover:border-primary/40"
                }`}
              >
                <Icon className={`h-4 w-4 ${active ? "text-primary" : "text-muted-foreground"}`} />
                <span className="font-medium text-ink">{label}</span>
                <span className="text-[10px] text-muted-foreground">{hint}</span>
              </button>
            );
          })}
        </div>
        <Textarea
          placeholder="Add a note (optional, max 280 chars)"
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 280))}
          rows={3}
        />
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => onSubmit(kind, note)} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Reporting…
              </>
            ) : (
              "Submit report"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RouteFeedback({ routeKey }: { routeKey: string }) {
  const [rating, setRating] = useState<Rating | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);

  // Reset when a new route is generated
  const lastKey = useRef(routeKey);
  if (lastKey.current !== routeKey) {
    lastKey.current = routeKey;
    if (rating || submitted) {
      setRating(null);
      setMissing([]);
      setSubmitted(false);
    }
  }

  const toggleMissing = (v: string) => {
    setMissing((m) => (m.includes(v) ? m.filter((x) => x !== v) : [...m, v]));
  };

  const submitPoor = () => {
    setSubmitted(true);
    capture(AnalyticsEvent.RouteFeedbackSubmitted, {
      rating: "poor",
      missing_options: missing,
      route_key: routeKey,
    });
    toast.success("Thanks — we'll use this to improve your next route.");
  };

  if (submitted) {
    return (
      <div className="mt-6 flex items-center gap-2 rounded-xl border border-border bg-background p-4 text-sm text-muted-foreground">
        <Check className="h-4 w-4 text-primary" /> Thanks for the feedback!
      </div>
    );
  }

  return (
    <div className="mt-6 rounded-xl border border-border bg-background p-4">
      <h3 className="font-serif text-sm font-semibold uppercase tracking-widest text-muted-foreground">
        How was this route?
      </h3>
      <div className="mt-3 flex flex-wrap gap-2">
        {[
          { id: "excellent" as const, label: "Excellent", Icon: ThumbsUp },
          { id: "average" as const, label: "Average", Icon: Meh },
          { id: "poor" as const, label: "Poor", Icon: ThumbsDown },
        ].map(({ id, label, Icon }) => {
          const active = rating === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                setRating(id);
                if (id !== "poor") {
                  setSubmitted(true);
                  capture(AnalyticsEvent.RouteFeedbackSubmitted, {
                    rating: id,
                    missing_options: [],
                    route_key: routeKey,
                  });
                  toast.success("Thanks for the feedback!");
                }
              }}
              className={`inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium transition ${
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-ink hover:border-primary/50"
              }`}
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          );
        })}
      </div>

      {rating === "poor" && (
        <div className="mt-4 border-t border-border pt-4">
          <p className="text-sm font-medium text-ink">What was missing?</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {MISSING_OPTIONS.map((opt) => {
              const id = `missing-${opt}`;
              return (
                <label
                  key={opt}
                  htmlFor={id}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-background p-2.5 text-sm hover:border-primary/50"
                >
                  <Checkbox
                    id={id}
                    checked={missing.includes(opt)}
                    onCheckedChange={() => toggleMissing(opt)}
                  />
                  <span>{opt}</span>
                </label>
              );
            })}
          </div>
          <Button size="sm" className="mt-4" onClick={submitPoor} disabled={missing.length === 0}>
            Submit feedback
          </Button>
        </div>
      )}
    </div>
  );
}

function friendlyError(msg: string): string {
  if (/Failed to fetch|NetworkError|network|fetch failed/i.test(msg)) {
    return "Please check your internet connection and try again.";
  }
  if (/NETWORK/.test(msg)) return "Please check your internet connection and try again.";
  if (/AI_INVALID/.test(msg))
    return "We couldn't understand your request. Please provide more detail.";
  if (/AI_RATE_LIMIT/.test(msg))
    return "We're handling lots of trips right now — please try again in a moment.";
  if (/AI_CREDITS/.test(msg))
    return "Route generation is temporarily unavailable. Please try again later.";
  if (/GEOCODE_NOT_FOUND:(.+)/.test(msg)) {
    const m = msg.match(/GEOCODE_NOT_FOUND:(.+)/);
    return `We couldn't find "${m?.[1] ?? "that location"}". Please try a different address.`;
  }
  if (/GEOCODE_FAILED|AI_FAILED/.test(msg)) {
    return "We couldn't generate a route right now. Please try again.";
  }
  return "We couldn't generate a route right now. Please try again.";
}

// Distance formatting now comes from src/lib/units.ts via the useUnits() hook (component-scoped).

function formatEta(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "—";
  const arrival = new Date(Date.now() + seconds * 1000);
  const hh = arrival.getHours();
  const mm = arrival.getMinutes().toString().padStart(2, "0");
  const hr = Math.floor(seconds / 3600);
  const min = Math.round((seconds % 3600) / 60);
  const dur = hr > 0 ? `${hr} hr ${min} min` : `${min} min`;
  return `${hh}:${mm} · ${dur}`;
}

export const Route = createFileRoute("/_authenticated/plan")({
  component: PlanPage,
});

const MOODS = [
  "Adventurous",
  "Romantic",
  "Peaceful",
  "Curious",
  "Reflective",
  "Joyful",
  "Relaxed",
  "Energetic",
  "Nostalgic",
  "Inspired",
  "Playful",
  "Cosy",
  "Awestruck",
  "Spontaneous",
  "Focused",
];
const THEMES = [
  "Coastal",
  "Mountain",
  "Forest",
  "Countryside",
  "Historic",
  "Foodie",
  "Wildlife",
  "Waterfalls",
  "Villages",
  "Scenic Viewpoints",
  "Dog Friendly",
  "Lakes & Rivers",
  "Castles & Ruins",
  "Art & Culture",
  "Stargazing",
];

// Free plan gets the first few of each; Premium unlocks all 15 moods and 15 themes.
const FREE_MOOD_COUNT = 5;
const FREE_THEME_COUNT = 7;
const FREE_MOODS = new Set(MOODS.slice(0, FREE_MOOD_COUNT));
const FREE_THEMES = new Set(THEMES.slice(0, FREE_THEME_COUNT));

// Themes tied to specific geography — only shown when the corridor recommender
// confirms they actually exist along the route.
const GEO_RESTRICTED_THEMES = new Set<string>([
  "Coastal",
  "Mountain",
  "Waterfalls",
]);


type PlanResult = Awaited<ReturnType<typeof planScenicRoute>>;

function PlanPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const units = useUnits();

  const formatKm = (m: number) => formatDistance(m, units);
  const planFn = useServerFn(planScenicRoute);

  const saveFn = useServerFn(saveRoute);
  const recomputeFn = useServerFn(recomputeDirections);
  const fetchSpeedFn = useServerFn(fetchSpeedLimit);
  const reverseGeocodeFn = useServerFn(reverseGeocode);
  const saveSearchFn = useServerFn(saveSearch);
  const listSearchesFn = useServerFn(listSavedSearches);
  const deleteSearchFn = useServerFn(deleteSavedSearch);
  const clearAllSearchesFn = useServerFn(clearAllSavedSearches);
  const createReportFn = useServerFn(createRoadReport);
  const listReportsFn = useServerFn(listRoadReports);
  const deleteReportFn = useServerFn(deleteRoadReport);
  const waypointFactsFn = useServerFn(waypointFacts);
  const recommendThemesServer = useServerFn(recommendThemesFn);

  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [stops, setStops] = useState<string[]>([]);
  const [locating, setLocating] = useState(false);
  const [startLocationMessage, setStartLocationMessage] = useState<{
    kind: "error" | "warning";
    text: string;
  } | null>(null);
  const [moods, setMoods] = useState<string[]>([]);
  const [themes, setThemes] = useState<string[]>([]);
  const [extra, setExtra] = useState(30);
  const [result, setResult] = useState<PlanResult | null>(null);
  const [routeSummary, setRouteSummary] = useState<RouteSummary | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [navError, setNavError] = useState<string | null>(null);
  const [locStatus, setLocStatus] = useState<LocationPermission>("prompt");
  const [locMessage, setLocMessage] = useState<string | null>(null);
  const [currentUserLocation, setCurrentUserLocation] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [locEnabled, setLocEnabled] = useState(false);
  const [progress, setProgress] = useState<RouteProgress | null>(null);
  const [stepProgress, setStepProgress] = useState<StepProgress | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  const [rerouting, setRerouting] = useState(false);
  const [showTraffic, setShowTraffic] = useState(true);
  const [reportTarget, setReportTarget] = useState<{ lat: number; lng: number } | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [speedKmh, setSpeedKmh] = useState<number | null>(null);
  const [altOffer, setAltOffer] = useState<{
    encodedPolyline: string;
    savedSeconds: number;
    durationSeconds: number;
    distanceMeters: number;
  } | null>(null);
  const [clearSearchesOpen, setClearSearchesOpen] = useState(false);
  // After user chooses "Keep current route", suppress further offers unless a
  // materially better alternative appears (i.e. new traffic further along the route).
  const [dismissedSavingsSec, setDismissedSavingsSec] = useState<number | null>(null);
  const [navLocGateDismissed, setNavLocGateDismissed] = useState(false);
  const [locRetryKey, setLocRetryKey] = useState(0);
  const [locationDisclosureOpen, setLocationDisclosureOpen] = useState(false);
  const pendingLocationActionRef = useRef<"start" | "nav" | null>(null);
  const startLocationActiveRef = useRef(false);

  const retryLocation = () => {
    setLocMessage(null);
    setLocStatus("prompt");
    setLocEnabled(true);
    setLocRetryKey((k) => k + 1);
    // Kick the OS prompt from this user gesture — some browsers/WebViews won't
    // re-prompt via watchPosition alone after a prior denial.
    getFastLocation()
      .then((c) => {
        setCurrentUserLocation(c);
        setLocStatus("granted");
        setLocMessage(null);
      })
      .catch(() => {
        /* ScenicMap's watch will report the accurate status/message. */
      });
  };

  function allowLocation() {
    setLocationDisclosureOpen(false);
    setLocEnabled(true);
    try {
      localStorage.setItem("scenik.locationDisclosed", "1");
    } catch {
      /* ignore */
    }
    const action = pendingLocationActionRef.current;
    pendingLocationActionRef.current = null;
    if (action === "start") {
      actuallyUseCurrentLocationForStart();
    } else if (action === "nav") {
      actuallyOpenNav();
    }
  }

  async function promptLocation(action: "start" | "nav" | null) {
    pendingLocationActionRef.current = action;
    // Skip disclosure if the user has already been shown it, or the browser
    // has already granted the geolocation permission for this origin.
    let alreadyDisclosed = false;
    try {
      alreadyDisclosed = localStorage.getItem("scenik.locationDisclosed") === "1";
    } catch {
      /* ignore */
    }
    let permissionGranted = false;
    try {
      if (
        getPlatform() === "web" &&
        typeof navigator !== "undefined" &&
        (navigator as Navigator).permissions
      ) {
        const status = await (navigator as Navigator).permissions.query({
          name: "geolocation" as PermissionName,
        });
        permissionGranted = status.state === "granted";
      }
    } catch {
      /* ignore */
    }
    if (alreadyDisclosed || permissionGranted) {
      allowLocation();
    } else {
      setLocationDisclosureOpen(true);
    }
  }

  const [descExpanded, setDescExpanded] = useState(false);
  const [waypointFact, setWaypointFact] = useState<{ name: string; text: string } | null>(null);
  const visitedWpRef = useRef<Set<number>>(new Set());
  const spokenRef = useRef<Set<string>>(new Set());
  const lastStepIdxRef = useRef<number>(-1);
  const warmVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const altCheckingRef = useRef(false);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const [routeCompleted, setRouteCompleted] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  const online = useOnlineStatus();
  const { data: subData } = useSubscription();
  const isPremium = !!subData?.isPremium;
  const offlineActive = !online && isPremium;

  // Hydrate from offline cache on first mount so navigation keeps working
  // after a reload with no connection. Premium-only.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    if (!isPremium) return;
    if (result) return;
    const cached = loadLastPlan<PlanResult>();
    if (!cached?.result) return;
    setResult(cached.result);
    if (cached.result.directions) {
      setRouteSummary({
        distance: cached.result.directions.distance,
        duration: cached.result.directions.duration,
        steps: cached.result.directions.steps,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPremium]);

  // Persist route data (metadata, polyline, turn-by-turn steps, explanation)
  // whenever it changes. Premium-only. We never cache Google Maps tiles or imagery.
  useEffect(() => {
    if (isPremium && result) saveLastPlan(result);
  }, [result, isPremium]);

  // Auto-prefill "Starting from" only when location permission was already granted.
  // New or prompt users see the disclosure first via "Use my current location".
  const startAutoFilledRef = useRef(false);
  useEffect(() => {
    if (startAutoFilledRef.current) return;
    if (start.trim()) {
      startAutoFilledRef.current = true;
      return;
    }
    startAutoFilledRef.current = true;

    const prefill = async () => {
      // Only prefill when location has already been granted, so we don't
      // silently trigger the OS permission prompt on first visit.
      let granted = false;
      try {
        if (isNativePlatform()) {
          const { Geolocation } = await import("@capacitor/geolocation");
          const s = await Geolocation.checkPermissions();
          granted = s.location === "granted";
        } else if (typeof navigator !== "undefined" && (navigator as Navigator).permissions) {
          const status = await (navigator as Navigator).permissions.query({
            name: "geolocation" as PermissionName,
          });
          granted = status.state === "granted";
        }
      } catch {
        /* Permissions API may be unavailable — fall through */
      }
      if (!granted) return;
      try {
        const c = await getFastLocation();
        setCurrentUserLocation(c);
        try {
          const r = await reverseGeocodeFn({ data: { lat: c.lat, lng: c.lng } });
          setStart((cur) => (cur.trim() ? cur : r.address));
        } catch {
          /* silent — user can type manually */
        }
      } catch {
        /* permission denied or unavailable — leave field empty */
      }
    };
    prefill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function requestLocationForStart() {
    if (startLocationActiveRef.current) return;
    console.info("[Location] button tapped");
    console.info(`[Location] platform: ${getPlatform() === "ios" ? "ios" : "web"}`);
    startLocationActiveRef.current = true;
    setLocating(true);
    setStartLocationMessage(null);
    try {
      await promptLocation("start");
    } catch (error) {
      console.error("[Location] location prompt failed:", error);
      setStartLocationMessage({
        kind: "error",
        text: "Couldn't request your location. Please try again.",
      });
      startLocationActiveRef.current = false;
      setLocating(false);
      console.info("[Location] loading cleared");
    }
  }

  async function actuallyUseCurrentLocationForStart() {
    const isNativeIOS = getPlatform() === "ios";
    try {
      let coords: { latitude: number; longitude: number };

      if (isNativeIOS) {
        const { Geolocation } = await import("@capacitor/geolocation");
        const permission = await Geolocation.checkPermissions();
        console.info("[Location] permission status:", permission.location);
        let permissionState = permission.location;
        if (permissionState !== "granted") {
          console.info("[Location] permission requested");
          const requested = await Geolocation.requestPermissions({ permissions: ["location"] });
          permissionState = requested.location;
          console.info("[Location] permission result:", permissionState);
        }
        if (permissionState !== "granted") {
          throw new Error("LOCATION_PERMISSION_DENIED");
        }

        console.info("[Location] fast position started");
        const position = await Geolocation.getCurrentPosition({
          enableHighAccuracy: false,
          timeout: 5_000,
          maximumAge: 60_000,
        });
        console.info("[Location] fast position received");
        coords = position.coords;

        void (async () => {
          try {
            console.info("[Location] accurate position started");
            const accurate = await Geolocation.getCurrentPosition({
              enableHighAccuracy: true,
              timeout: 12_000,
              maximumAge: 0,
            });
            console.info("[Location] accurate position received");
            setCurrentUserLocation({
              lat: accurate.coords.latitude,
              lng: accurate.coords.longitude,
            });
          } catch (error) {
            console.warn("[Location] accurate position failed:", error);
          }
        })();
      } else {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
          throw new Error("LOCATION_UNSUPPORTED");
        }
        console.info("[Location] permission status: browser-managed");
        console.info("[Location] fast position started");
        const position = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: false,
            timeout: 5_000,
            maximumAge: 60_000,
          });
        });
        console.info("[Location] fast position received");
        coords = position.coords;
      }

      setCurrentUserLocation({ lat: coords.latitude, lng: coords.longitude });
      setStart("Current location");
      console.info("[Location] form updated");

      try {
        console.info("[Location] reverse geocode started");
        const r = await Promise.race([
          reverseGeocodeFn({ data: { lat: coords.latitude, lng: coords.longitude } }),
          new Promise<never>((_, reject) =>
            window.setTimeout(() => reject(new Error("REVERSE_GEOCODE_TIMEOUT")), 8_000),
          ),
        ]);
        setStart(r.address);
        setStartLocationMessage(null);
        console.info("[Location] reverse geocode completed");
        console.info("[Location] form updated");
        toast.success("Using your current location");
      } catch (error) {
        console.warn("[Location] reverse geocode failed:", error);
        setStartLocationMessage({
          kind: "warning",
          text: "Your coordinates were found, but the address couldn't be loaded. You can continue using Current location.",
        });
      }
    } catch (error) {
      const denied =
        error instanceof Error &&
        (error.message === "LOCATION_PERMISSION_DENIED" ||
          /permission|denied/i.test(error.message));
      const message = denied
        ? isNativeIOS
          ? "Location access is off. Enable Location for Scenik in iPhone Settings, then try again."
          : "Location permission is blocked. Enable it in your browser settings, then try again."
        : "Couldn't get your location. Please try again.";
      capture(AnalyticsEvent.LocationError, {
        reason: denied ? "permission_denied" : "unavailable",
        source: "start_address_picker",
      });
      setStartLocationMessage({ kind: "error", text: message });
      toast.error(message);
    } finally {
      startLocationActiveRef.current = false;
      setLocating(false);
      console.info("[Location] loading cleared");
    }
  }

  // Pick a warm, natural-sounding voice in the user's chosen language.
  // We prefer modern neural / premium voices and fall back to classic warm defaults.
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      if (!voices.length) return;
      const prefix = "en";
      const inLang = voices.filter((v) => v.lang?.toLowerCase().startsWith(prefix));
      const pool = inLang.length ? inLang : voices;

      // Higher score = more natural / likeable. Prefer neural, premium, enhanced voices.
      const score = (v: SpeechSynthesisVoice) => {
        const name = v.name.toLowerCase();
        let s = 0;
        if (/neural|premium|enhanced|wavenet|natural/.test(name)) s += 40;
        if (/google uk english female|google us english/.test(name)) s += 30;
        if (/samantha|karen|moira|serena|tessa|joanna|allison/.test(name)) s += 25;
        if (
          /microsoft aria|microsoft jenny|microsoft sonia|microsoft ana|microsoft michelle/.test(
            name,
          )
        )
          s += 20;
        if (/female/.test(name)) s += 5;
        if (/male/.test(name)) s -= 2;
        // Deprioritise clearly robotic / default voices
        if (/default|zira|david|mark|fred/.test(name)) s -= 15;
        return s;
      };

      const sorted = [...pool].sort((a, b) => score(b) - score(a));
      warmVoiceRef.current = sorted[0] ?? voices[0] ?? null;
    };
    pick();
    window.speechSynthesis.onvoiceschanged = pick;
    return () => {
      try {
        window.speechSynthesis.onvoiceschanged = null;
      } catch {
        /* noop */
      }
    };
  }, []);

  const searchesQuery = useQuery({
    queryKey: ["saved-searches"],
    queryFn: () => listSearchesFn(),
  });

  const reportsQuery = useQuery({
    queryKey: ["road-reports"],
    queryFn: () => listReportsFn({ data: {} }),
    refetchInterval: 60_000,
  });

  // Debounced trigger for theme recommendations so we don't fire on every keystroke
  const [recoKey, setRecoKey] = useState<{ start: string; end: string } | null>(null);
  useEffect(() => {
    const s = start.trim();
    const e = end.trim();
    if (s.length < 3 || e.length < 3) {
      setRecoKey(null);
      return;
    }
    const t = setTimeout(() => setRecoKey({ start: s, end: e }), 800);
    return () => clearTimeout(t);
  }, [start, end]);

  const recoQuery = useQuery({
    queryKey: ["theme-reco", recoKey?.start, recoKey?.end],
    queryFn: () =>
      recommendThemesServer({
        data: { start: recoKey!.start, end: recoKey!.end, available: THEMES },
      }),
    enabled: !!recoKey,
    staleTime: 10 * 60_000,
    retry: false,
  });

  const reports: RoadReportMarker[] = useMemo(() => {
    const rows = reportsQuery.data ?? [];
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      lat: r.lat,
      lng: r.lng,
      note: r.note,
      mine: !!userId && r.user_id === userId,
    }));
  }, [reportsQuery.data, userId]);

  const saveSearchMut = useMutation({
    mutationFn: () =>
      saveSearchFn({
        data: {
          start_address: start,
          end_address: end,
          mood: moods.join(", "),
          theme: themes.join(", "),
          extra_minutes: extra,
        },
      }),
    onSuccess: () => {
      toast.success("Search saved");
      qc.invalidateQueries({ queryKey: ["saved-searches"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteSearchMut = useMutation({
    mutationFn: (id: string) => deleteSearchFn({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["saved-searches"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const clearAllSearchesMut = useMutation({
    mutationFn: () => clearAllSearchesFn(),
    onSuccess: () => {
      toast.success("All recent searches cleared");
      setClearSearchesOpen(false);
      qc.invalidateQueries({ queryKey: ["saved-searches"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const createReportMut = useMutation({
    mutationFn: (vars: {
      kind: RoadReportMarker["kind"];
      note: string;
      lat: number;
      lng: number;
    }) => createReportFn({ data: vars }),
    onSuccess: () => {
      toast.success("Reported. Thanks!");
      setReportTarget(null);
      qc.invalidateQueries({ queryKey: ["road-reports"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteReportMut = useMutation({
    mutationFn: (id: string) => deleteReportFn({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["road-reports"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  function applySavedSearch(s: {
    start_address: string;
    end_address: string;
    mood: string;
    theme: string;
    extra_minutes: number;
  }) {
    setStart(s.start_address);
    setEnd(s.end_address);
    setMoods(
      s.mood
        ? s.mood
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        : [],
    );
    setThemes(
      s.theme
        ? s.theme
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        : [],
    );
    setExtra(s.extra_minutes);
    toast("Search loaded");
  }

  const toggle = (list: string[], setList: (v: string[]) => void, value: string) => {
    if (list.includes(value)) setList(list.filter((x) => x !== value));
    else setList([...list, value]);
  };

  const plan = useMutation({
    mutationFn: async (vars?: { mood?: string; theme?: string }) => {
      const request = planFn({
        data: {
          start_address: start,
          end_address: end,
          mood: vars?.mood ?? moods.join(", "),
          theme: vars?.theme ?? themes.join(", "),
          extra_minutes: extra,
          stops: stops.map((s) => s.trim()).filter((s) => s.length >= 2),
        },
      });
      return Promise.race([
        request,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Route planning timed out. Please try again.")),
            90_000,
          ),
        ),
      ]);
    },
    onSuccess: (r, vars) => {
      console.log("[Route] API response status: ok");
      setPlanError(null);
      setRouteSummary(
        r.directions
          ? {
              distance: r.directions.distance,
              duration: r.directions.duration,
              steps: r.directions.steps,
            }
          : null,
      );
      setProgress(null);
      setResult(r);
      setDescExpanded(false);
      setRouteCompleted(false);
      visitedWpRef.current = new Set();
      setWaypointFact(null);
      capture(AnalyticsEvent.RouteGenerated, {
        title: r.title,
        scenic_score: r.scenic_score,
        mood: r.mood,
        theme: r.theme,
        moods_selected: (vars?.mood ?? moods.join(", "))
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        themes_selected: (vars?.theme ?? themes.join(", "))
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        extra_minutes: r.extra_minutes,
        waypoint_count: r.waypoints.length,
        stops_count: stops.filter((s) => s.trim().length >= 2).length,
        distance_meters: r.directions?.distanceMeters ?? null,
        duration_seconds: r.directions?.durationSeconds ?? null,
        distance_label: r.directions?.distance ?? null,
        duration_label: r.directions?.duration ?? null,
        route_type:
          !vars?.mood && !vars?.theme && moods.length === 0 && themes.length === 0
            ? "fastest"
            : "scenic",
      });
      requestAnimationFrame(() => {
        resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    },

    onError: async (e: Error) => {
      console.log("[Route] API response status: error");
      console.log("[Route] exact safe error:", e.message);
      if (/FREE_LIMIT_REACHED/.test(e.message)) {
        capture(AnalyticsEvent.FreeLimitReached, { source: "plan" });
        setPlanError("You've used all 3 free routes this month. Upgrade to Premium for unlimited routes.");
        toast.error(
          "You've used all 3 free routes this month. Upgrade to Premium for unlimited.",
          {
            action: { label: "Upgrade", onClick: () => navigate({ to: "/pricing" }) },
          },
        );
        return;
      }
      if (/PREMIUM_REQUIRED:multi_stop/.test(e.message)) {
        capture(AnalyticsEvent.PremiumGateHit, { feature: "multi_stop" });
        setPlanError("Multi-stop planning is a Premium feature.");
        toast.error("Multi-stop planning is a Premium feature.", {
          action: { label: "Upgrade", onClick: () => navigate({ to: "/pricing" }) },
        });
        return;
      }
      if (/Unauthorized|No authorization/i.test(e.message)) {
        const { data: refreshed } = await supabase.auth.refreshSession();
        if (refreshed.session) {
          setPlanError("Connection hiccup — please tap the button again.");
          toast.error("Connection hiccup — please try again.");
          return;
        }
        setPlanError("Your session expired. Please sign in again.");
        toast.error("Your session expired. Please sign in again.");
        navigate({ to: "/auth", replace: true });
        return;
      }
      capture(AnalyticsEvent.RouteGenerationFailed, {
        error_code: e.message.split(":")[0] || "UNKNOWN",
        message: e.message,
      });
      setPlanError(friendlyError(e.message));
      toast.error(friendlyError(e.message));
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!result) throw new Error("Nothing to save");
      return saveFn({
        data: {
          title: result.title,
          mood: result.mood,
          theme: result.theme,
          extra_minutes: result.extra_minutes,
          start_address: result.start.address,
          end_address: result.end.address,
          start_lat: result.start.lat,
          start_lng: result.start.lng,
          end_lat: result.end.lat,
          end_lng: result.end.lng,
          waypoints: result.waypoints,
          scenic_score: result.scenic_score,
          narrative: result.narrative,
          highlights: result.highlights,
        },
      });
    },
    onSuccess: (saved) => {
      capture(AnalyticsEvent.RouteSaved, {
        route_id: (saved as { id?: string })?.id,
        title: result?.title,
        scenic_score: result?.scenic_score,
        waypoint_count: result?.waypoints.length ?? 0,
        mood: result?.mood,
        theme: result?.theme,
      });
      toast.success("Route saved");
      navigate({ to: "/routes" });
    },
    onError: (e: Error) => toast.error(friendlyError(e.message)),
  });

  function openNav() {
    setNavError(null);
    if (!import.meta.env.VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY) {
      toast.error("Unable to launch navigation. Please try again.");
      return;
    }
    promptLocation("nav");

  }

  function actuallyOpenNav() {
    spokenRef.current = new Set();
    visitedWpRef.current = new Set();
    setWaypointFact(null);
    setNavLocGateDismissed(false);
    lastStepIdxRef.current = -1;
    const firstStep = result?.directions?.steps?.[0];
    setStepProgress(
      firstStep
        ? {
            stepIndex: 0,
            distanceToManeuverMeters: firstStep.distanceMeters,
            step: firstStep,
          }
        : null,
    );
    // Prime speech synthesis inside the user gesture. iOS Safari and some
    // desktop browsers (incl. custom-domain contexts) require an in-gesture
    // speak() call before any later programmatic speak() will actually play.
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
        if (window.speechSynthesis.paused) window.speechSynthesis.resume();
        const primer = new SpeechSynthesisUtterance(" ");
        primer.volume = 0.01;
        primer.rate = 1;
        if (warmVoiceRef.current) primer.voice = warmVoiceRef.current;
        primer.lang = warmVoiceRef.current?.lang ?? "en-US";
        window.speechSynthesis.speak(primer);
      } catch {
        /* ignore */
      }
    }
    setNavOpen(true);
    capture(AnalyticsEvent.NavigationStarted, {
      title: result?.title,
      scenic_score: result?.scenic_score,
      distance_meters: result?.directions?.distanceMeters ?? null,
      duration_seconds: result?.directions?.durationSeconds ?? null,
      waypoint_count: result?.waypoints.length ?? 0,
      mood: result?.mood,
      theme: result?.theme,
    });
    getFastLocation()
      .then((c) => setCurrentUserLocation(c))
      .catch(() => {
        /* ignore — the nav map will keep watching */
      });
  }

  function speak(text: string) {
    if (!voiceOn) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      let clean = text
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      // Add tiny spoken pauses so the voice feels more human and less robotic.
      clean = clean
        .replace(/\b(OK|Okay), now\b/gi, "Okay, now")
        .replace(/\bComing up in\b/gi, "coming up in")
        .replace(/\bIn about\b/gi, "in about")
        .replace(/\bRoute updated\b/gi, "Route updated");

      const u = new SpeechSynthesisUtterance(clean);
      if (warmVoiceRef.current) u.voice = warmVoiceRef.current;
      u.rate = 0.96; // natural conversational pace
      u.pitch = 1.05; // warm, friendly tone without sounding chipmunk
      u.volume = 1;
      u.lang = warmVoiceRef.current?.lang ?? "en-US";
      window.speechSynthesis.cancel();
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
      window.speechSynthesis.speak(u);
    } catch {
      /* ignore */
    }
  }

  async function handleReroute(pos: { lat: number; lng: number }) {
    if (!result || rerouting) return;
    setRerouting(true);
    toast("Rerouting…", { icon: <RefreshCw className="h-4 w-4 animate-spin" /> });
    try {
      const fresh = await recomputeFn({
        data: {
          origin: pos,
          destination: { lat: result.end.lat, lng: result.end.lng },
          waypoints: [],
        },
      });
      setResult({ ...result, directions: fresh });
      setRouteSummary({ distance: fresh.distance, duration: fresh.duration, steps: fresh.steps });
      spokenRef.current = new Set();
      lastStepIdxRef.current = -1;
      capture(AnalyticsEvent.NavigationRerouted, {
        route_id: result?.title,
        new_distance_meters: fresh.distanceMeters,
        new_duration_seconds: fresh.durationSeconds,
      });
      speak("Route updated.");
    } catch {
      capture(AnalyticsEvent.NavigationRerouteFailed, { route_title: result?.title });
      toast.error("Couldn't reroute. Continuing on current route.");
    } finally {
      setRerouting(false);
    }
  }

  async function onLocationTick(pos: { lat: number; lng: number }) {
    // Speed limit (fire-and-forget)
    fetchSpeedFn({ data: pos })
      .then((r) => setSpeedKmh(r.kmh))
      .catch(() => setSpeedKmh(null));
    // Scenic-point facts: when navigating, fire a short guide when we arrive near a waypoint
    if (result && navOpen) {
      const R = 6371000;
      const toRad = (n: number) => (n * Math.PI) / 180;
      result.waypoints.forEach((w, idx) => {
        if (visitedWpRef.current.has(idx)) return;
        const dLat = toRad(w.lat - pos.lat);
        const dLng = toRad(w.lng - pos.lng);
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(toRad(pos.lat)) * Math.cos(toRad(w.lat)) * Math.sin(dLng / 2) ** 2;
        const dist = 2 * R * Math.asin(Math.sqrt(a));
        if (dist < 250) {
          visitedWpRef.current.add(idx);
          waypointFactsFn({
            data: {
              name: w.name,
              lat: w.lat,
              lng: w.lng,
              theme: result.theme,
              language: "English",
            },
          })
            .then((r) => {
              setWaypointFact({ name: w.name, text: r.facts });
              speak(`${w.name}. ${r.facts}`);
            })
            .catch(() => {
              /* silent */
            });
        }
      });
    }

    // Traffic-aware alternates — only while navigating, on route, not currently rerouting
    if (!result || !navOpen || rerouting || altCheckingRef.current) return;
    if (!progress?.onRoute) return;
    altCheckingRef.current = true;
    try {
      const fresh = await recomputeFn({
        data: {
          origin: pos,
          destination: { lat: result.end.lat, lng: result.end.lng },
          waypoints: [],
          alternatives: true,
        },
      });
      const remainingSec = progress?.remainingSeconds ?? result.directions?.durationSeconds ?? 0;
      const candidates = [
        {
          encodedPolyline: fresh.encodedPolyline,
          durationSeconds: fresh.durationSeconds,
          distanceMeters: fresh.distanceMeters,
        },
        ...(fresh.alternatives ?? []),
      ];
      const best = candidates
        .map((c) => ({ ...c, savedSeconds: remainingSec - c.durationSeconds }))
        .filter((c) => c.savedSeconds > 120) // > 2 min faster
        .sort((a, b) => b.savedSeconds - a.savedSeconds)[0];
      // Require new alternate to save at least 2 min beyond what was previously dismissed.
      // This means we only re-prompt when fresh traffic further along makes a materially
      // better route available — not for the same offer the user already declined.
      const minSavings = 120 + (dismissedSavingsSec ?? 0);
      if (best && best.savedSeconds > minSavings) {
        setAltOffer(best);
      } else if (!best) {
        setAltOffer(null);
      }
    } catch {
      /* noop */
    } finally {
      altCheckingRef.current = false;
    }
  }

  function acceptAlternate() {
    if (!altOffer || !result) return;
    const fresh = {
      encodedPolyline: altOffer.encodedPolyline,
      distanceMeters: altOffer.distanceMeters,
      durationSeconds: altOffer.durationSeconds,
      distance: `${(altOffer.distanceMeters / 1000).toFixed(1)} km`,
      duration: `${Math.round(altOffer.durationSeconds / 60)} min`,
      steps: result.directions?.steps ?? [],
    };
    setResult({ ...result, directions: fresh });
    setRouteSummary({ distance: fresh.distance, duration: fresh.duration, steps: fresh.steps });
    spokenRef.current = new Set();
    lastStepIdxRef.current = -1;
    capture(AnalyticsEvent.TrafficAlternateAccepted, {
      saved_seconds: altOffer.savedSeconds,
      new_distance_meters: altOffer.distanceMeters,
      new_duration_seconds: altOffer.durationSeconds,
    });
    setAltOffer(null);
    speak("Switching to the no traffic route.");
  }

  function dismissAlternate() {
    if (altOffer) {
      capture(AnalyticsEvent.TrafficAlternateDismissed, {
        saved_seconds: altOffer.savedSeconds,
      });
      setDismissedSavingsSec(altOffer.savedSeconds ?? 0);
    }
    setAltOffer(null);
  }

  // Turn-by-turn voice cues
  useEffect(() => {
    if (!navOpen || !stepProgress) return;
    const { stepIndex, distanceToManeuverMeters: dist, step } = stepProgress;
    const instr = step.instruction || "Continue";
    if (stepIndex !== lastStepIdxRef.current) {
      lastStepIdxRef.current = stepIndex;
    }
    const cue = (threshold: number, prefix: string) => {
      const key = `${stepIndex}-${threshold}`;
      if (dist <= threshold && !spokenRef.current.has(key)) {
        spokenRef.current.add(key);
        speak(`${prefix}, ${instr}`);
      }
    };
    cue(20, "Okay, now");
    cue(
      units === "mi" ? 200 : 200,
      units === "mi" ? "Coming up in 200 yards" : "Coming up in 200 metres",
    );
    cue(
      units === "mi" ? 500 : 500,
      units === "mi" ? "In about a third of a mile" : "In about 500 metres",
    );
  }, [stepProgress, navOpen, units]);

  // Mark route as completed when the user reaches (or nearly reaches) the destination while navigating.
  useEffect(() => {
    if (!navOpen || !progress || !progress.onRoute) return;
    if (progress.percent >= 99 || progress.remainingMeters <= 60) {
      if (!routeCompleted) {
        capture(AnalyticsEvent.RouteCompleted, {
          title: result?.title,
          scenic_score: result?.scenic_score,
          completion_percent: Math.round(progress.percent),
          distance_meters: result?.directions?.distanceMeters ?? null,
          duration_seconds: result?.directions?.durationSeconds ?? null,
          waypoint_count: result?.waypoints.length ?? 0,
        });
      }
      setRouteCompleted(true);
    }
  }, [navOpen, progress, result, routeCompleted]);

  // Route Abandoned: navigation closed before completion.
  const abandonRef = useRef<{ armed: boolean; lastPercent: number }>({
    armed: false,
    lastPercent: 0,
  });
  useEffect(() => {
    if (navOpen) {
      abandonRef.current.armed = true;
      abandonRef.current.lastPercent = progress?.percent ?? 0;
    } else if (abandonRef.current.armed) {
      abandonRef.current.armed = false;
      if (!routeCompleted && abandonRef.current.lastPercent > 0) {
        capture(AnalyticsEvent.RouteAbandoned, {
          title: result?.title,
          scenic_score: result?.scenic_score,
          completion_percent: Math.round(abandonRef.current.lastPercent),
          distance_meters: result?.directions?.distanceMeters ?? null,
        });
      }
    }
  }, [navOpen, progress, result, routeCompleted]);

  // Reset traffic alternate + speed when nav closes
  useEffect(() => {
    if (!navOpen) {
      setAltOffer(null);
      setDismissedSavingsSec(null);
      setSpeedKmh(null);
    }
  }, [navOpen]);

  async function runPlan(overrides?: { moods?: string[]; themes?: string[] }) {
    console.log("[Route] request started");
    console.log("[Route] location present:", Boolean(start.trim()), "destination present:", Boolean(end.trim()));
    if (!start.trim() || !end.trim()) {
      setPlanError("Enter a starting point and a destination first.");
      toast.error("Enter a start and end");
      return;
    }
    // Don't pre-check the session here: getSession() can briefly return null
    // during a token refresh and would wrongly kick the user out. The server
    // function middleware will surface a real 401 via the mutation's onError.

    setMapError(null);
    setPlanError(null);
    const m = overrides?.moods ?? moods;
    const t = overrides?.themes ?? themes;
    plan.mutate({ mood: m.join(", "), theme: t.join(", ") });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await runPlan();
  }

  function surpriseMe() {
    const moodPool = isPremium ? MOODS : MOODS.filter((x) => FREE_MOODS.has(x));
    const themePool = isPremium ? THEMES : THEMES.filter((x) => FREE_THEMES.has(x));
    const m = [moodPool[Math.floor(Math.random() * moodPool.length)]];
    const t = [themePool[Math.floor(Math.random() * themePool.length)]];
    setMoods(m);
    setThemes(t);
    setExtra((prev) => (prev === 0 ? 30 : prev));
    const label = [m[0], t[0]].filter(Boolean).join(" · ");
    toast.success(`Surprise: ${label}`);
    runPlan({ moods: m, themes: t });
  }

  const points = result
    ? [
        {
          lat: result.start.lat,
          lng: result.start.lng,
          label: result.start.address,
          kind: "start" as const,
        },
        ...result.waypoints.map((w) => ({
          lat: w.lat,
          lng: w.lng,
          label: w.name,
          kind: "waypoint" as const,
        })),
        {
          lat: result.end.lat,
          lng: result.end.lng,
          label: result.end.address,
          kind: "end" as const,
        },
      ]
    : [];

  return (
    <div className="mx-auto max-w-6xl px-3 py-4 sm:px-6 sm:py-8">
      {!online &&
        (isPremium ? (
          <OfflineBanner className="mb-4" />
        ) : (
          <OfflineUpgradeBanner className="mb-4" />
        ))}
      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        {/* Form */}
        <Card className="min-w-0 border-border bg-card p-4 shadow-paper sm:p-6">
          <h1 className="font-serif text-xl font-semibold text-ink sm:text-2xl">
            Plan a scenic drive
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick a mood, a theme, both, or neither — Scenik threads the prettiest route either way.
          </p>

          <form onSubmit={onSubmit} className="mt-6 space-y-5">
            <div>
              <AddressAutocomplete
                id="start"
                label="Starting from"
                placeholder="e.g. San Francisco, CA"
                value={start}
                onChange={setStart}
              />
              <button
                type="button"
                onClick={requestLocationForStart}
                disabled={locating}
                className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline disabled:opacity-60"
              >
                {locating ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Crosshair className="h-3 w-3" />
                )}
                {locating ? "Locating…" : "Use my current location"}
              </button>
              {startLocationMessage && (
                <p
                  role={startLocationMessage.kind === "error" ? "alert" : "status"}
                  className={`mt-1.5 text-xs ${
                    startLocationMessage.kind === "error" ? "text-destructive" : "text-amber-700"
                  }`}
                >
                  {startLocationMessage.text}
                </p>
              )}
            </div>

            {/* Stops between start and end */}
            {stops.length > 0 && (
              <div className="space-y-3">
                {stops.map((value, i) => (
                  <div key={i} className="flex items-end gap-2">
                    <div className="flex-1">
                      <AddressAutocomplete
                        id={`stop-${i}`}
                        label={`Stop ${i + 1}`}
                        placeholder="Add a place to visit"
                        value={value}
                        onChange={(v) =>
                          setStops((arr) => arr.map((x, idx) => (idx === i ? v : x)))
                        }
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => setStops((arr) => arr.filter((_, idx) => idx !== i))}
                      className="mb-0.5 shrink-0 rounded-md border border-border bg-background p-2 text-muted-foreground hover:border-destructive/40 hover:text-destructive"
                      title="Remove stop"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {stops.length < 8 && (
              <button
                type="button"
                onClick={() => setStops((arr) => [...arr, ""])}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
              >
                <Plus className="h-3.5 w-3.5" /> Add a stop
              </button>
            )}

            <AddressAutocomplete
              id="end"
              label="Heading to"
              placeholder="e.g. Monterey, CA"
              value={end}
              onChange={setEnd}
            />

            <div>
              <div className="flex items-baseline justify-between mb-2">
                <Label>
                  Mood{" "}
                  <span className="text-[10px] font-normal text-muted-foreground">(optional)</span>
                </Label>
                {moods.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setMoods([])}
                    className="text-[10px] font-medium text-primary hover:underline"
                  >
                    Clear
                  </button>
                ) : (
                  <span className="text-[10px] text-muted-foreground">any</span>
                )}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-between font-normal text-xs"
                  >
                    <span className="truncate">
                      {moods.length
                        ? `${moods.length} mood${moods.length === 1 ? "" : "s"} selected`
                        : "Select moods (default: any)"}
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  className="max-h-[250px] w-[min(300px,calc(100vw-2rem))] overflow-y-auto"
                  align="start"
                >
                  {MOODS.map((m) => {
                    const active = moods.includes(m);
                    const locked = !isPremium && !FREE_MOODS.has(m);
                    return (
                      <DropdownMenuCheckboxItem
                        key={m}
                        checked={active}
                        disabled={locked}
                        onCheckedChange={() => {
                          if (locked) return;
                          toggle(moods, setMoods, m);
                        }}
                        onSelect={(e) => e.preventDefault()}
                      >
                        <span className="flex-1">{m}</span>
                        {locked && (
                          <Lock className="ml-2 h-3 w-3 shrink-0 text-muted-foreground" />
                        )}
                      </DropdownMenuCheckboxItem>
                    );
                  })}
                  {!isPremium && (
                    <button
                      type="button"
                      onClick={() => navigate({ to: "/pricing" })}
                      className="mt-1 w-full rounded-sm px-2 py-2 text-left text-[11px] font-medium text-primary hover:bg-primary/10"
                    >
                      Unlock all {MOODS.length} moods with Premium
                    </button>
                  )}

                </DropdownMenuContent>
              </DropdownMenu>
              {moods.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {moods.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => toggle(moods, setMoods, m)}
                      className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/20"
                      title={`Remove ${m}`}
                    >
                      {m} <X className="h-3 w-3" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="flex items-baseline justify-between mb-2">
                <Label>
                  Theme{" "}
                  <span className="text-[10px] font-normal text-muted-foreground">(optional)</span>
                </Label>
                {themes.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setThemes([])}
                    className="text-[10px] font-medium text-primary hover:underline"
                  >
                    Clear
                  </button>
                ) : (
                  <span className="text-[10px] text-muted-foreground">any</span>
                )}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-between font-normal text-xs"
                    disabled={!recoKey || recoQuery.isLoading}
                  >
                    <span className="truncate">
                      {!recoKey
                        ? "Enter start & destination first"
                        : recoQuery.isLoading
                          ? "Reading the map…"
                          : themes.length
                            ? `${themes.length} theme${themes.length === 1 ? "" : "s"} selected`
                            : "Select themes (default: any)"}
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  className="max-h-[250px] w-[min(300px,calc(100vw-2rem))] overflow-y-auto"
                  align="start"
                >
                  {(() => {
                    const recommended = new Set(recoQuery.data?.themes ?? []);
                    // Show every theme by default; only hide geo-restricted ones
                    // that the recommender didn't confirm along this corridor.
                    const available = THEMES.filter(
                      (t) => !GEO_RESTRICTED_THEMES.has(t) || recommended.has(t),
                    );
                    if (available.length === 0) {
                      return (
                        <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                          No themes suit this drive.
                        </div>
                      );
                    }
                    return (
                      <>
                        {available.map((t) => {
                          const active = themes.includes(t);
                          const isRec = recommended.has(t);
                          const locked = !isPremium && !FREE_THEMES.has(t);
                          return (
                            <DropdownMenuCheckboxItem
                              key={t}
                              checked={active}
                              disabled={locked}
                              onCheckedChange={() => {
                                if (locked) return;
                                toggle(themes, setThemes, t);
                              }}
                              onSelect={(e) => e.preventDefault()}
                            >
                              <span className="flex-1">{t}</span>
                              {locked ? (
                                <Lock className="ml-2 h-3 w-3 shrink-0 text-muted-foreground" />
                              ) : (
                                isRec && (
                                  <span className="ml-2 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-widest text-primary">
                                    Rec
                                  </span>
                                )
                              )}
                            </DropdownMenuCheckboxItem>
                          );
                        })}
                        {!isPremium && (
                          <button
                            type="button"
                            onClick={() => navigate({ to: "/pricing" })}
                            className="mt-1 w-full rounded-sm px-2 py-2 text-left text-[11px] font-medium text-primary hover:bg-primary/10"
                          >
                            Unlock every theme — including Dog Friendly — with Premium
                          </button>
                        )}
                      </>
                    );
                  })()}

                </DropdownMenuContent>
              </DropdownMenu>
              {themes.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {themes.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggle(themes, setThemes, t)}
                      className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/20"
                      title={`Remove ${t}`}
                    >
                      {t} <X className="h-3 w-3" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="flex items-baseline justify-between">
                <Label>Extra time you'll spare</Label>
                <span className="font-serif text-lg font-semibold text-primary">{extra} min</span>
              </div>
              <Slider
                value={[extra]}
                min={0}
                max={180}
                step={5}
                onValueChange={(v) => setExtra(v[0])}
                className="mt-3"
              />
            </div>

            <Button type="submit" className="w-full shadow-stamp" disabled={plan.isPending}>
              {plan.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Charting the long way…
                </>
              ) : moods.length === 0 && themes.length === 0 ? (
                <>
                  <Navigation className="mr-2 h-4 w-4" /> Get fastest route
                </>
              ) : (
                <>Plan my drive</>
              )}
            </Button>

            {planError && (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm leading-snug text-destructive"
              >
                {planError}
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={plan.isPending}
              onClick={surpriseMe}
            >
              Surprise me
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full text-xs"
              disabled={!start.trim() || !end.trim() || saveSearchMut.isPending}
              onClick={() => saveSearchMut.mutate()}
            >
              <Bookmark className="mr-2 h-3.5 w-3.5" />{" "}
              {saveSearchMut.isPending ? "Saving search…" : "Save this search"}
            </Button>
            <p className="text-center text-[11px] text-muted-foreground">
              Mood and theme are both optional — pick one, both, or skip them for the fastest route.
            </p>
          </form>

          {/* Saved searches */}
          <div className="mt-6 border-t border-border pt-5">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 font-serif text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                <History className="h-3.5 w-3.5" /> Recent searches
              </h2>
              {(searchesQuery.data?.length ?? 0) > 0 && (
                <AlertDialog open={clearSearchesOpen} onOpenChange={setClearSearchesOpen}>
                  <AlertDialogTrigger asChild>
                    <button
                      type="button"
                      disabled={clearAllSearchesMut.isPending}
                      className="text-[11px] text-muted-foreground underline-offset-2 hover:text-destructive hover:underline disabled:opacity-50"
                    >
                      Clear all
                    </button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Clear all recent searches?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will permanently remove all {searchesQuery.data?.length} saved
                        searches. This cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={clearAllSearchesMut.isPending}>
                        Cancel
                      </AlertDialogCancel>
                      <AlertDialogAction
                        onClick={(e) => {
                          e.preventDefault();
                          clearAllSearchesMut.mutate();
                        }}
                        disabled={clearAllSearchesMut.isPending}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        {clearAllSearchesMut.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="mr-2 h-4 w-4" />
                        )}
                        Clear all
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
            {searchesQuery.isLoading ? (
              <p className="mt-3 text-xs text-muted-foreground">Loading…</p>
            ) : (searchesQuery.data?.length ?? 0) === 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                No saved searches yet. Save one to reuse it later.
              </p>
            ) : (
              <ul className="mt-3 space-y-2 max-h-72 overflow-y-auto pr-1">
                {searchesQuery.data!.map((s) => (
                  <li
                    key={s.id}
                    className="group flex items-start gap-2 rounded-lg border border-border bg-background p-2.5 text-xs"
                  >
                    <button
                      type="button"
                      onClick={() => applySavedSearch(s)}
                      className="min-w-0 flex-1 text-left"
                      title="Load this search"
                    >
                      <div className="truncate font-medium text-ink">
                        {s.start_address} → {s.end_address}
                      </div>
                      <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                        {[s.mood, s.theme].filter(Boolean).join(" · ") || "Fastest"} · +
                        {s.extra_minutes}m
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteSearchMut.mutate(s.id)}
                      disabled={deleteSearchMut.isPending}
                      title="Remove from history"
                      className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        {/* Result */}
          <div ref={resultRef} className="min-w-0 space-y-6 scroll-mt-24">
          {result && (
            <Card className="min-w-0 border-border bg-card p-4 shadow-paper sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3 sm:gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                    {result.mood} · {result.theme} · +{result.extra_minutes} min
                  </div>
                  <h2 className="mt-1 break-words font-serif text-2xl font-semibold text-ink sm:text-3xl">
                    {result.title}
                  </h2>
                </div>
                <div className="shrink-0 rounded-2xl border border-border bg-background px-3 py-2 text-center shadow-paper sm:px-4 sm:py-3">
                  <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                    Scenic
                  </div>
                  <div className="font-serif text-2xl font-semibold text-primary sm:text-3xl">
                    {result.scenic_score}
                    <span className="text-sm text-muted-foreground sm:text-base">/100</span>
                  </div>
                </div>
              </div>

              {(() => {
                const full = result.narrative ?? "";
                const SHORT = 160;
                const isLong = full.length > SHORT;
                const shown = !isLong || descExpanded ? full : `${full.slice(0, SHORT).trimEnd()}…`;
                return (
                  <>
                    <p className="mt-4 font-serif text-base italic leading-relaxed text-ink/85 sm:text-lg">
                      "{shown}"
                    </p>

                    {descExpanded && result.score_breakdown && (
                      <div className="mt-5 rounded-xl border border-border bg-background p-4">
                        <h3 className="font-serif text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                          Why this score
                        </h3>
                        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-3">
                          {[
                            {
                              label: "Natural beauty",
                              val: result.score_breakdown.natural_beauty,
                              max: 25,
                            },
                            {
                              label: "Road character",
                              val: result.score_breakdown.road_character,
                              max: 20,
                            },
                            {
                              label: "Points of interest",
                              val: result.score_breakdown.points_of_interest,
                              max: 20,
                            },
                            {
                              label: "Theme match",
                              val: result.score_breakdown.theme_match,
                              max: 15,
                            },
                            {
                              label: "Mood match",
                              val: result.score_breakdown.mood_match,
                              max: 10,
                            },
                            { label: "Diversity", val: result.score_breakdown.diversity, max: 10 },
                          ].map((s) => (
                            <div key={s.label}>
                              <div className="flex items-baseline justify-between text-xs">
                                <span className="text-muted-foreground">{s.label}</span>
                                <span className="font-serif font-semibold text-ink">
                                  {s.val}
                                  <span className="text-muted-foreground">/{s.max}</span>
                                </span>
                              </div>
                              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                                <div
                                  className="h-full bg-primary"
                                  style={{ width: `${(s.val / s.max) * 100}%` }}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                        {result.score_breakdown.rationale && (
                          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                            {result.score_breakdown.rationale}
                          </p>
                        )}
                      </div>
                    )}

                    {(isLong || result.score_breakdown) && (
                      <button
                        type="button"
                        onClick={() => setDescExpanded((v) => !v)}
                        className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                      >
                        {descExpanded ? (
                          <>
                            <ChevronUp className="h-3.5 w-3.5" /> Read less
                          </>
                        ) : (
                          <>
                            <ChevronDown className="h-3.5 w-3.5" /> Read more &amp; analytics
                          </>
                        )}
                      </button>
                    )}
                  </>
                );
              })()}
            </Card>
          )}

          <div className="relative aspect-[5/4] overflow-hidden rounded-2xl border border-border bg-muted shadow-paper sm:aspect-[16/10]">
            {plan.isPending ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
                <Loader2 className="h-10 w-10 animate-spin opacity-60" strokeWidth={1.5} />
                <p className="max-w-xs text-sm">Charting the long way home…</p>
              </div>
            ) : plan.isError ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
                <AlertTriangle
                  className="h-10 w-10 text-destructive opacity-80"
                  strokeWidth={1.5}
                />
                <p className="max-w-sm text-sm text-ink">
                  {friendlyError((plan.error as Error)?.message ?? "")}
                </p>
                <Button size="sm" variant="outline" onClick={() => plan.mutate(undefined)}>
                  <RefreshCw className="mr-2 h-3.5 w-3.5" /> Try again
                </Button>
              </div>
            ) : points.length > 0 ? (
              <>
                <ScenicMap
                  points={points}
                  encodedPolyline={result?.directions?.encodedPolyline}
                  routeDistanceMeters={result?.directions?.distanceMeters}
                  routeDurationSeconds={result?.directions?.durationSeconds}
                  onProgress={setProgress}
                  className="h-full w-full"
                  onError={(m) => setMapError(m)}
                  showUserLocation={locEnabled}
                  initialUserLocation={currentUserLocation}
                  onUserLocationChange={setCurrentUserLocation}
                  onLocationStatus={(s, msg) => {
                    setLocStatus(s);
                    setLocMessage(msg ?? null);
                  }}
                  showTraffic={showTraffic}
                  locationRetryKey={locRetryKey}
                  offline={offlineActive}
                  reports={reports}
                  onMapClick={(p) => setReportTarget(p)}
                  onReportDelete={(id) => deleteReportMut.mutate(id)}
                />

                {mapError && (
                  <div className="absolute left-2 right-2 top-2 z-10 flex items-start gap-2 rounded-md border border-destructive/40 bg-background/95 px-3 py-2 text-xs text-destructive shadow-paper sm:left-4 sm:right-auto sm:top-4 sm:max-w-sm">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="break-words leading-snug">{mapError}</span>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => {
                    if (locEnabled) {
                      setLocEnabled(false);
                    } else {
                      promptLocation(null);

                    }
                  }}
                  title={locEnabled ? "Hide my location" : "Show my location"}
                  className="absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-full border border-border bg-background/95 px-2.5 py-1.5 text-xs font-medium text-ink shadow-paper transition hover:border-primary/50 sm:right-4 sm:top-4 sm:px-3"
                >
                  {locEnabled && locStatus === "granted" ? (
                    <>
                      <LocateFixed className="h-3.5 w-3.5 text-primary" /> My location
                    </>
                  ) : (
                    <>
                      <LocateOff className="h-3.5 w-3.5" />{" "}
                      {locStatus === "denied" ? "Location unavailable" : "Show me"}
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setShowTraffic((v) => !v)}
                  title={showTraffic ? "Hide traffic" : "Show traffic"}
                  className={`absolute left-2 top-2 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-medium shadow-paper transition sm:left-auto sm:right-4 sm:top-14 sm:px-3 ${
                    showTraffic
                      ? "border-red-900 bg-red-900 text-white"
                      : "border-border bg-background/95 text-ink hover:border-red-900/50"
                  }`}
                >
                  <TrafficCone className="h-3.5 w-3.5" />
                  <span className="hidden xs:inline sm:inline">Traffic</span>
                </button>

                <div className="absolute left-2 top-2 hidden max-w-[55%] rounded-md border border-border bg-background/95 px-3 py-1.5 text-[10px] text-muted-foreground shadow-paper sm:block">
                  Tap the map to report a camera, closure, works, or hazard.
                </div>
                {locEnabled &&
                  locMessage &&
                  (locStatus === "denied" ||
                    locStatus === "unsupported" ||
                    locStatus === "error") && (
                    <div className="absolute bottom-20 left-4 right-4 flex flex-col gap-2 rounded-md border border-border bg-background/95 px-3 py-2 text-xs text-muted-foreground shadow-paper sm:right-auto sm:max-w-xs">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />{" "}
                        <span>{locMessage}</span>
                      </div>
                      {locStatus !== "unsupported" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 self-start px-3 text-xs"
                          onClick={retryLocation}
                        >
                          <RefreshCw className="mr-1.5 h-3 w-3" /> Try again
                        </Button>
                      )}
                    </div>
                  )}
                {result && (
                  <button
                    type="button"
                    onClick={openNav}
                    className="absolute bottom-4 right-4 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-stamp transition hover:opacity-90"
                  >
                    <Navigation className="h-4 w-4" /> Start route
                  </button>
                )}
                {result && locEnabled && locStatus === "granted" && progress && (
                  <div className="absolute bottom-4 left-4 max-w-[52%] rounded-xl border border-border bg-background/95 px-3 py-2 text-xs shadow-paper sm:max-w-[60%]">
                    {progress.onRoute ? (
                      <>
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="font-serif text-sm font-semibold text-ink">
                            {Math.round(progress.percent)}%
                          </span>
                          <span className="text-muted-foreground">
                            {formatKm(progress.remainingMeters)} left
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full bg-primary transition-all"
                            style={{ width: `${progress.percent}%` }}
                          />
                        </div>
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          ETA {formatEta(progress.remainingSeconds)}
                        </div>
                      </>
                    ) : (
                      <div className="flex items-center gap-1.5 text-amber-700">
                        <AlertTriangle className="h-3.5 w-3.5" /> Off route (
                        {formatKm(progress.distanceFromRouteMeters)} away)
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
                <MapPin className="h-10 w-10 opacity-40" strokeWidth={1.25} />
                <p className="max-w-xs text-sm">
                  Your scenic route will appear here once Scenik has charted it.
                </p>
              </div>
            )}
          </div>

          {result && (
            <Dialog open={navOpen} onOpenChange={setNavOpen}>
              <DialogContent className="!max-w-none !w-screen !h-[100dvh] !left-0 !top-0 !translate-x-0 !translate-y-0 !rounded-none !p-0 !border-0 !gap-0 flex flex-col overflow-hidden">
                <DialogHeader className="shrink-0 px-4 pt-4 pb-2 sm:px-6">
                  <DialogTitle className="break-words pr-10 font-serif text-base sm:text-xl">
                    Navigate: {result.title}
                  </DialogTitle>
                </DialogHeader>
                <div className="flex min-h-0 flex-1 flex-col px-3 pb-3 sm:px-4 sm:pb-4">
                  {/* Maneuver banner */}
                  {stepProgress && (
                    <div className="mb-2 flex shrink-0 items-start gap-3 rounded-xl border border-border bg-primary/5 px-4 py-3">
                      <Navigation className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                          In {formatKm(stepProgress.distanceToManeuverMeters)}
                          {stepProgress.step.maneuver
                            ? ` · ${stepProgress.step.maneuver.replace(/_/g, " ").toLowerCase()}`
                            : ""}
                        </div>
                        <div
                          className="mt-0.5 break-words font-serif text-base font-semibold text-ink sm:text-lg"
                          dangerouslySetInnerHTML={{
                            __html: stepProgress.step.instruction ?? "Continue",
                          }}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setVoiceOn((v) => !v)}
                        title={voiceOn ? "Mute voice" : "Unmute voice"}
                        className="shrink-0 rounded-full border border-border bg-background p-2 text-ink hover:border-primary/50"
                      >
                        {voiceOn ? (
                          <Volume2 className="h-4 w-4" />
                        ) : (
                          <VolumeX className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  )}
                  {rerouting && (
                    <div className="mb-2 flex shrink-0 items-center gap-2 rounded-md border border-border bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Rerouting from your current
                      position…
                    </div>
                  )}
                  {waypointFact && (
                    <div className="mb-2 flex shrink-0 items-start gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3">
                      <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                          You're arriving at
                        </div>
                        <div className="mt-0.5 break-words font-serif text-sm font-semibold text-ink sm:text-base">
                          {waypointFact.name}
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-ink/85">
                          {waypointFact.text}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setWaypointFact(null)}
                        title="Dismiss"
                        className="shrink-0 rounded-full border border-border bg-background p-1.5 text-muted-foreground hover:border-primary/50 hover:text-ink"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}

                  <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-muted">
                    {navError ? (
                      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center sm:px-6">
                        <AlertTriangle className="h-8 w-8 text-destructive" strokeWidth={1.5} />
                        <p className="text-sm text-ink">
                          Unable to launch navigation. Please try again.
                        </p>
                        <Button size="sm" variant="outline" onClick={() => setNavError(null)}>
                          <RefreshCw className="mr-2 h-3.5 w-3.5" /> Retry
                        </Button>
                      </div>
                    ) : (
                      <ScenicMap
                        points={points}
                        encodedPolyline={result?.directions?.encodedPolyline}
                        routeDistanceMeters={result?.directions?.distanceMeters}
                        routeDurationSeconds={result?.directions?.durationSeconds}
                        onProgress={setProgress}
                        className="h-full w-full"
                        onError={() =>
                          setNavError("Unable to launch navigation. Please try again.")
                        }
                        showUserLocation
                        initialUserLocation={currentUserLocation}
                        onUserLocationChange={setCurrentUserLocation}
                        navMode
                        steps={result?.directions?.steps}
                        onStepChange={setStepProgress}
                        onReroute={handleReroute}
                        showTraffic={showTraffic}
                        locationRetryKey={locRetryKey}
                        offline={offlineActive}
                        reports={reports}
                        onMapClick={(p) => setReportTarget(p)}
                        onReportDelete={(id) => deleteReportMut.mutate(id)}
                        onLocationTick={onLocationTick}
                        alternateRoutes={
                          altOffer
                            ? [{ id: "faster", encodedPolyline: altOffer.encodedPolyline }]
                            : []
                        }
                        onAlternateClick={() => acceptAlternate()}
                      />
                    )}
                    {/* Location permission gate */}
                    {locStatus === "denied" && !navLocGateDismissed && (
                      <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/90 p-4 backdrop-blur-sm">
                        <div className="w-full max-w-sm rounded-2xl border border-border bg-background p-6 text-center shadow-stamp">
                          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                            <LocateOff className="h-6 w-6 text-primary" />
                          </div>
                          <h3 className="mt-4 font-serif text-lg font-semibold text-ink">
                            Scenik needs your location to provide navigation
                          </h3>
                          <p className="mt-2 text-sm text-muted-foreground">
                            Turn-by-turn guidance, live progress, and automatic rerouting all rely
                            on your GPS. You can still view the route on the map if you prefer not
                            to share it.
                          </p>
                          <div className="mt-5 flex flex-col gap-2">
                            <Button
                              size="sm"
                              onClick={() => {
                                getFastLocation()
                                  .then((c) => {
                                    setCurrentUserLocation(c);
                                    setLocStatus("granted");
                                    setLocMessage(null);
                                    setLocRetryKey((k) => k + 1);
                                    setNavLocGateDismissed(true);
                                  })
                                  .catch(() => {
                                    setLocRetryKey((k) => k + 1);
                                    toast.error(
                                      "Location permission is still blocked. Enable it in Settings and try again.",
                                    );
                                  });
                              }}
                            >
                              <LocateFixed className="mr-2 h-4 w-4" /> Try again
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setNavLocGateDismissed(true)}
                            >
                              Continue without location
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setNavOpen(false)}>
                              Go back
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                    {/* Traffic alternate banner */}
                    {altOffer && (
                      <div
                        style={{ top: "calc(max(1rem, env(safe-area-inset-top)) + 3rem)" }}
                        className="absolute left-4 right-4 sm:right-auto sm:max-w-sm rounded-xl border border-amber-300 bg-amber-50/95 p-3 shadow-paper z-10">

                        <div className="flex items-start gap-2">
                          <RouteIcon className="mt-0.5 h-4 w-4 text-amber-700" />
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-semibold text-amber-900">
                              No traffic route — saves {Math.round(altOffer.savedSeconds / 60)} min
                            </div>
                            <div className="mt-0.5 text-[11px] text-amber-800">
                              New ETA {formatEta(altOffer.durationSeconds)} ·{" "}
                              {formatKm(altOffer.distanceMeters)} · avoids traffic
                            </div>
                            <div className="mt-2 flex gap-2">
                              <Button
                                size="sm"
                                className="h-7 px-3 text-xs"
                                onClick={acceptAlternate}
                              >
                                Switch route
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-3 text-xs"
                                onClick={dismissAlternate}
                              >
                                Keep current
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                    {/* Live ETA pill */}
                    {progress && progress.onRoute && (
                      <div className="absolute bottom-4 left-4 rounded-xl border border-border bg-background/95 px-3 py-2 text-xs shadow-paper">
                        <div className="flex items-baseline gap-2">
                          <span className="font-serif text-sm font-semibold text-ink">
                            {Math.round(progress.percent)}%
                          </span>
                          <span className="text-muted-foreground">·</span>
                          <span className="text-muted-foreground">
                            {formatKm(progress.remainingMeters)} left
                          </span>
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                          ETA {formatEta(progress.remainingSeconds)}
                        </div>
                      </div>
                    )}
                    {/* Speed limit badge */}
                    {speedKmh != null &&
                      (() => {
                        const s = formatSpeed(speedKmh, units);
                        return (
                          <div className="absolute bottom-4 right-4 flex items-center gap-2 rounded-xl border-2 border-red-600 bg-white px-3 py-1.5 shadow-paper">
                            <Gauge className="h-3.5 w-3.5 text-red-600" />
                            <div className="text-center leading-none">
                              <div className="font-serif text-lg font-bold text-ink">{s.value}</div>
                              <div className="text-[8px] uppercase tracking-wider text-muted-foreground">
                                {s.unit}
                              </div>
                            </div>
                          </div>
                        );
                      })()}

                    <button
                      type="button"
                      onClick={() => setNavOpen(false)}
                      style={{ top: "max(1rem, env(safe-area-inset-top))" }}
                      className="absolute right-4 inline-flex items-center gap-1.5 rounded-full bg-background/95 px-3 py-1.5 text-xs font-medium text-ink shadow-paper hover:border-destructive/50 border border-border"
                    >
                      <X className="h-3.5 w-3.5" /> End
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowTraffic((v) => !v)}
                      style={{ top: "max(1rem, env(safe-area-inset-top))" }}
                      className={`absolute left-4 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium shadow-paper ${
                        showTraffic
                          ? "border-red-900 bg-red-900 text-white"
                          : "border-border bg-background/95 text-ink"
                      }`}
                    >
                      <TrafficCone className="h-3.5 w-3.5" /> Traffic
                    </button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          )}

          {result && (
            <Card className="border-border bg-card p-5 shadow-paper sm:p-6">
              <div className="grid gap-6 md:grid-cols-2">
                <div>
                  <h3 className="font-serif text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                    Highlights
                  </h3>
                  <ul className="mt-3 space-y-2">
                    {result.highlights.map((h, i) => (
                      <li key={i} className="flex gap-2 text-sm">
                        <span className="font-serif text-primary">·</span>
                        <span>{h}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="font-serif text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                    Waypoints
                  </h3>
                  <ol className="mt-3 space-y-3">
                    {result.waypoints.map((w, i) => (
                      <li key={i} className="rounded-xl border border-border bg-background p-3">
                        <div className="flex items-center gap-2">
                          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                            {i + 1}
                          </span>
                          <span className="font-serif text-base font-semibold text-ink">
                            {w.name}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{w.description}</p>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>

              {routeCompleted && (
                <RouteFeedback
                  routeKey={`${result.title}-${result.start.address}-${result.end.address}`}
                />
              )}

              <div className="mt-6 flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  onClick={() => {
                    if (save.isPending || save.isSuccess) return;
                    save.mutate();
                  }}
                  disabled={save.isPending || save.isSuccess}
                  className="w-full shadow-stamp sm:w-auto"
                >
                  <Bookmark className="mr-2 h-4 w-4" />
                  {save.isPending ? "Saving…" : save.isSuccess ? "Saved" : "Save route"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setResult(null)}
                  disabled={save.isPending}
                  className="w-full sm:w-auto"
                >
                  Start over
                </Button>
              </div>

            </Card>
          )}
        </div>

        {/* Report dialog */}
        <ReportDialog
          target={reportTarget}
          onCancel={() => setReportTarget(null)}
          onSubmit={(kind, note) => {
            if (!reportTarget) return;
            createReportMut.mutate({ kind, note, lat: reportTarget.lat, lng: reportTarget.lng });
          }}
          submitting={createReportMut.isPending}
        />

        <LocationDisclosure
          open={locationDisclosureOpen}
          onOpenChange={(open) => {
            setLocationDisclosureOpen(open);
            if (!open && pendingLocationActionRef.current) {
              const cancelledAction = pendingLocationActionRef.current;
              pendingLocationActionRef.current = null;
              if (cancelledAction === "start") {
                startLocationActiveRef.current = false;
                setLocating(false);
                console.info("[Location] loading cleared");
              }
            }
          }}
          onAllow={allowLocation}
        />
      </div>
    </div>
  );
}
