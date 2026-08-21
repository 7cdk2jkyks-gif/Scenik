import assert from "node:assert/strict";
import { afterAll, beforeAll, beforeEach, describe, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, Fragment, useState, type ReactNode } from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import type { RouteProgress } from "../components/ScenicMap";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

type ServerFunctionName =
  | "planScenicRoute"
  | "recomputeDirections"
  | "saveRoute"
  | "fetchSpeedLimit"
  | "reverseGeocode"
  | "recommendThemesFn"
  | "saveSearch"
  | "listSavedSearches"
  | "deleteSavedSearch"
  | "clearAllSavedSearches"
  | "createRoadReport"
  | "listRoadReports"
  | "deleteRoadReport";

type ServerFunctionToken = { testName: ServerFunctionName };
type TransportCall = { name: ServerFunctionName; payload: unknown };

const planSource = readFileSync(
  fileURLToPath(new URL("./_authenticated/plan.tsx", import.meta.url)),
  "utf8",
);
const transportCalls: TransportCall[] = [];
const geolocationWatches: Array<{
  id: number;
  success(position: GeolocationPosition): void;
}> = [];
const clearedWatchIds: number[] = [];
const trafficLayerMaps: unknown[] = [];
let fakeNow = 1_000_000;
const originalDateNow = Date.now;

const serverFunctions = Object.fromEntries(
  [
    "planScenicRoute",
    "recomputeDirections",
    "saveRoute",
    "fetchSpeedLimit",
    "reverseGeocode",
    "recommendThemesFn",
    "saveSearch",
    "listSavedSearches",
    "deleteSavedSearch",
    "clearAllSavedSearches",
    "createRoadReport",
    "listRoadReports",
    "deleteRoadReport",
  ].map((testName) => [testName, { testName }]),
) as Record<ServerFunctionName, ServerFunctionToken>;

const journeyBPayload = {
  title: "Journey B",
  scenic_score: 72,
  selectedRouteDurationSeconds: 4_800,
  measuredExtraTimeSeconds: 1_200,
  directions: {
    encodedPolyline: "geometry-b",
    distance: "75 km",
    duration: "1 hr 20 min",
    distanceMeters: 75_000,
    durationSeconds: 4_800,
    steps: [{ instruction: "Turn right", distanceMeters: 700, durationSeconds: 80 }],
  },
};

const journeyAResult = {
  title: "Journey A",
  mood: "Peaceful",
  theme: "Countryside",
  extra_minutes: 30,
  scenic_score: 64,
  narrative: "A connected test journey.",
  highlights: [],
  badges: [],
  start: { address: "Start A", lat: 51.5, lng: -0.1 },
  end: { address: "End A", lat: 51.65, lng: -0.1 },
  waypoints: [
    { name: "First", lat: 51.55, lng: -0.1 },
    { name: "Second", lat: 51.6, lng: -0.1 },
  ],
  directions: {
    encodedPolyline: "geometry-a",
    distance: "70 km",
    duration: "1 hr",
    distanceMeters: 70_000,
    durationSeconds: 3_600,
    steps: [{ instruction: "Continue", distanceMeters: 500, durationSeconds: 60 }],
  },
  selectedRouteDurationSeconds: 3_600,
  fastestRouteDurationSeconds: 2_400,
  measuredExtraTimeSeconds: 1_200,
  fullAllowanceSearchCompleted: true,
  timeTargetOutcome: "TARGET_MET",
  journeyTimeline: [],
  narrationEvents: [],
  routeUpgradeCandidate: {
    available: true,
    additionalMinutesBeyondSelectedRoute: 20,
    currentScenicScore: 64,
    upgradeScenicScore: 72,
    verifiedReasons: ["More verified natural evidence"],
    payload: journeyBPayload,
  },
};

function responseFor(name: ServerFunctionName) {
  if (name === "planScenicRoute") return journeyAResult;
  if (name === "recomputeDirections") return journeyBPayload.directions;
  if (name === "fetchSpeedLimit") return { kmh: 50 };
  if (name === "listSavedSearches" || name === "listRoadReports") return [];
  if (name === "recommendThemesFn") return { themes: [] };
  if (name === "reverseGeocode") return { address: "Test address" };
  return { ok: true };
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Date.now = () => fakeNow;
  class MapPrimitive {
    fitBounds() {}
    panTo() {}
    setCenter() {}
    setZoom() {}
    setOptions() {}
    addListener() {
      return { remove() {} };
    }
  }
  class OverlayPrimitive {
    setMap() {}
    setPosition() {}
    setCenter() {}
    setRadius() {}
    setPath() {}
    addListener() {}
  }
  class TrafficLayerPrimitive {
    setMap(map: unknown) {
      trafficLayerMaps.push(map);
    }
  }
  Object.assign(globalThis, {
    window: Object.assign(globalThis, {
      matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        queueMicrotask(() => {
          fakeNow += 1_000;
          callback(fakeNow);
        });
        return 1;
      },
      cancelAnimationFrame() {},
      __scenicMapReady: true,
      google: {
        maps: {
          Map: MapPrimitive,
          Marker: OverlayPrimitive,
          Polyline: OverlayPrimitive,
          Circle: OverlayPrimitive,
          TrafficLayer: TrafficLayerPrimitive,
          LatLngBounds: class {
            extend() {}
          },
          InfoWindow: class {
            open() {}
            close() {}
            setContent() {}
          },
          Point: class {},
          Size: class {},
          SymbolPath: { CIRCLE: 0 },
          event: { removeListener() {} },
          geometry: {
            encoding: {
              decodePath: (encoded: string) => {
                const coordinates =
                  encoded === "geometry-b"
                    ? [
                        { lat: 51.5, lng: -0.1 },
                        { lat: 51.575, lng: -0.095 },
                        { lat: 51.65, lng: -0.1 },
                      ]
                    : [
                        { lat: 51.5, lng: -0.1 },
                        { lat: 51.55, lng: -0.1 },
                        { lat: 51.6, lng: -0.1 },
                        { lat: 51.65, lng: -0.1 },
                      ];
                return coordinates.map((coordinate) => ({
                  lat: () => coordinate.lat,
                  lng: () => coordinate.lng,
                }));
              },
            },
          },
        },
      },
    }),
    localStorage: {
      getItem: (key: string) => (key === "scenik.locationDisclosed" ? "1" : null),
      setItem() {},
      removeItem() {},
    },
    navigator: {
      permissions: { query: async () => ({ state: "prompt" }) },
      geolocation: {
        watchPosition: (success: (position: GeolocationPosition) => void) => {
          const id = geolocationWatches.length + 41;
          geolocationWatches.push({ id, success });
          return id;
        },
        clearWatch: (id: number) => clearedWatchIds.push(id),
        getCurrentPosition: (success: (position: GeolocationPosition) => void) =>
          success(position(51.5, -0.1)),
      },
      share: undefined,
      clipboard: { writeText: async () => undefined },
    },
  });
  const documentHead = { appendChild() {} };
  Object.assign(globalThis, {
    document: {
      head: documentHead,
      visibilityState: "visible",
      addEventListener() {},
      removeEventListener() {},
      getElementById: () => null,
      getElementsByTagName: (tagName: string) => (tagName === "head" ? [documentHead] : []),
      createElement: () => ({ setAttribute() {}, appendChild() {} }),
      createTextNode: () => ({}),
    },
  });

  mock.module("@tanstack/react-router", () => ({
    createFileRoute: () => (config: unknown) => config,
    RouterProvider: () => null,
    useNavigate: () => () => undefined,
    Link: ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children),
  }));
  mock.module("@tanstack/react-start", () => ({
    createMiddleware: () => ({ server: () => ({}) }),
    createServerFn: () => {
      const definition = {
        middleware: () => definition,
        inputValidator: () => definition,
        handler: () => definition,
      };
      return definition;
    },
    useServerFn: (token: ServerFunctionToken) => async (payload?: unknown) => {
      transportCalls.push({ name: token.testName, payload });
      return responseFor(token.testName);
    },
  }));
  mock.module("@tanstack/react-query", () => ({
    useQueryClient: () => ({ invalidateQueries: () => undefined }),
    useQuery: ({ queryKey }: { queryKey: string[] }) => ({
      data: queryKey[0] === "theme-reco" ? { themes: [] } : [],
      isLoading: false,
    }),
    useMutation: (options: Record<string, (...args: unknown[]) => unknown>) => {
      const [isPending, setPending] = useState(false);
      const [isSuccess, setSuccess] = useState(false);
      const mutate = (variables?: unknown) => {
        if (isPending) return;
        setPending(true);
        Promise.resolve(options.mutationFn?.(variables))
          .then((value) => {
            options.onSuccess?.(value, variables);
            setSuccess(true);
            options.onSettled?.(value, null, variables);
          })
          .catch((error) => {
            options.onError?.(error, variables);
            options.onSettled?.(undefined, error, variables);
          })
          .finally(() => setPending(false));
      };
      return {
        mutate,
        mutateAsync: async (value?: unknown) => options.mutationFn?.(value),
        isPending,
        isSuccess,
      };
    },
  }));
  mock.module("@/lib/routes.functions", () => serverFunctions);
  mock.module("@/lib/searches.functions", () => ({
    saveSearch: serverFunctions.saveSearch,
    listSavedSearches: serverFunctions.listSavedSearches,
    deleteSavedSearch: serverFunctions.deleteSavedSearch,
    clearAllSavedSearches: serverFunctions.clearAllSavedSearches,
  }));
  mock.module("@/lib/reports.functions", () => ({
    createRoadReport: serverFunctions.createRoadReport,
    listRoadReports: serverFunctions.listRoadReports,
    deleteRoadReport: serverFunctions.deleteRoadReport,
  }));
  mock.module("@/components/AddressAutocomplete", () => ({
    AddressAutocomplete: (props: Record<string, unknown>) =>
      createElement("address-autocomplete", props),
  }));
  mock.module("@/components/ui/dialog", () => ({
    Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? createElement(Fragment, null, children) : null,
    DialogContent: ({ children }: { children?: ReactNode }) =>
      createElement("dialog-content", null, children),
    DialogHeader: ({ children }: { children?: ReactNode }) =>
      createElement(Fragment, null, children),
    DialogTitle: ({ children }: { children?: ReactNode }) => createElement("h2", null, children),
    DialogFooter: ({ children }: { children?: ReactNode }) =>
      createElement(Fragment, null, children),
    DialogDescription: ({ children }: { children?: ReactNode }) =>
      createElement("p", null, children),
  }));
  mock.module("@/components/ui/alert-dialog", () => ({
    AlertDialog: ({ children }: { children?: ReactNode }) =>
      createElement(Fragment, null, children),
    AlertDialogAction: ({ children }: { children?: ReactNode }) =>
      createElement("button", null, children),
    AlertDialogCancel: ({ children }: { children?: ReactNode }) =>
      createElement("button", null, children),
    AlertDialogContent: ({ children }: { children?: ReactNode }) =>
      createElement(Fragment, null, children),
    AlertDialogDescription: ({ children }: { children?: ReactNode }) =>
      createElement(Fragment, null, children),
    AlertDialogFooter: ({ children }: { children?: ReactNode }) =>
      createElement(Fragment, null, children),
    AlertDialogHeader: ({ children }: { children?: ReactNode }) =>
      createElement(Fragment, null, children),
    AlertDialogTitle: ({ children }: { children?: ReactNode }) =>
      createElement(Fragment, null, children),
    AlertDialogTrigger: ({ children }: { children?: ReactNode }) =>
      createElement(Fragment, null, children),
  }));
  mock.module("@/components/ui/dropdown-menu", () => ({
    DropdownMenu: ({ children }: { children?: ReactNode }) =>
      createElement(Fragment, null, children),
    DropdownMenuTrigger: ({ children }: { children?: ReactNode }) =>
      createElement(Fragment, null, children),
    DropdownMenuContent: ({ children }: { children?: ReactNode }) =>
      createElement(Fragment, null, children),
    DropdownMenuCheckboxItem: ({ children }: { children?: ReactNode }) =>
      createElement(Fragment, null, children),
  }));
  mock.module("@/components/ui/slider", () => ({ Slider: () => null }));
  mock.module("@/lib/units", () => ({
    useUnits: () => "km",
    formatDistance: (metres: number) => `${metres} m`,
    formatSpeed: (speed: number) => ({ value: String(speed), unit: "km/h" }),
  }));
  mock.module("@/integrations/supabase/client", () => ({
    supabase: {
      auth: {
        getUser: async () => ({ data: { user: { id: "test-user" } } }),
        getSession: async () => ({ data: { session: {} } }),
        refreshSession: async () => ({ data: { session: {} } }),
      },
    },
  }));
  mock.module("@/hooks/useSubscription", () => ({
    useSubscription: () => ({ data: { isPremium: false } }),
  }));
  mock.module("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => true }));
  mock.module("@/lib/analytics/client", () => ({ capture: () => undefined }));
  mock.module("@/lib/geolocation", () => ({
    getFastLocation: async () => ({ lat: 51.5, lng: -0.1 }),
  }));
  mock.module("@/lib/native", () => ({ getPlatform: () => "web", isNativePlatform: () => false }));
  mock.module("@/lib/haptics", () => ({ playHaptic: async () => undefined }));
  mock.module("@/lib/offline-cache", () => ({
    saveLastPlan: () => undefined,
    loadLastPlan: () => null,
  }));
  mock.module("@/components/InternalRouteDiagnostics", () => ({
    InternalRouteDiagnostics: () => null,
  }));
  mock.module("@/components/OfflineBanner", () => ({ OfflineBanner: () => null }));
  mock.module("@/components/OfflineUpgradeBanner", () => ({ OfflineUpgradeBanner: () => null }));
  mock.module("@/components/LocationDisclosure", () => ({ LocationDisclosure: () => null }));
});

beforeEach(() => {
  transportCalls.length = 0;
  geolocationWatches.length = 0;
  clearedWatchIds.length = 0;
  trafficLayerMaps.length = 0;
  fakeNow = 1_000_000;
});

afterAll(() => {
  Date.now = originalDateNow;
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  mock.restore();
});

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
}

function button(root: ReactTestInstance, label: RegExp) {
  return root.find((node) => node.type === "button" && label.test(textOf(node)));
}

function position(lat: number, lng: number, accuracy = 5): GeolocationPosition {
  return {
    coords: {
      latitude: lat,
      longitude: lng,
      accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      toJSON: () => ({}),
    },
    timestamp: fakeNow,
    toJSON: () => ({}),
  };
}

function routeReplacementCalls() {
  return transportCalls.filter(
    (call) => call.name === "planScenicRoute" || call.name === "recomputeDirections",
  );
}

describe("mounted Production PlanPage navigation safety", () => {
  it("keeps navigation observational through the connected useServerFn transport", async () => {
    const { PlanPage } = await import("./_authenticated/plan");
    const { ScenicMap } = await import("../components/ScenicMap");
    const { ActiveNavigationMap } = await import("../components/ActiveNavigationMap");
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<PlanPage />, {
        createNodeMock: () => ({ scrollIntoView() {} }),
      });
    });

    const addresses = renderer.root.findAll(
      (node) => (node.type as unknown) === "address-autocomplete",
    );
    await act(async () => {
      addresses.find((node) => node.props.id === "start")!.props.onChange("Start A");
      addresses.find((node) => node.props.id === "end")!.props.onChange("End A");
    });
    await act(async () => {
      renderer.root.findByType("form").props.onSubmit({ preventDefault() {} });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(
      transportCalls.map((call) => call.name),
      ["planScenicRoute"],
    );

    await act(async () => button(renderer.root, /Begin journey/).props.onClick());
    const journeyA = renderer.root
      .findAllByType(ScenicMap)
      .find((node) => node.props.navMode)!.props;
    const journeyAIdentity = renderer.root.findByType(ActiveNavigationMap).props.journeyIdentity;
    assert.equal(journeyA.encodedPolyline, "geometry-a");
    assert.equal(journeyA.routeDurationSeconds, 3_600);
    assert.deepEqual(journeyA.steps, journeyAResult.directions.steps);
    assert.deepEqual(journeyA.points, [
      { lat: 51.5, lng: -0.1, label: "Start A", kind: "start" },
      { lat: 51.55, lng: -0.1, label: "First", kind: "waypoint" },
      { lat: 51.6, lng: -0.1, label: "Second", kind: "waypoint" },
      { lat: 51.65, lng: -0.1, label: "End A", kind: "end" },
    ]);
    assert.equal("onReroute" in journeyA, false);
    assert.ok(geolocationWatches.length >= 1);
    const journeyAWatch = geolocationWatches.at(-1)!;

    transportCalls.length = 0;
    const gpsObservations = [
      position(51.51, -0.1),
      position(51.52, -0.12),
      position(51.52, -0.12),
      position(51.57, -0.12),
      position(51.62, -0.12),
      position(51.58, -0.12),
    ];
    for (const observation of gpsObservations) {
      fakeNow += 120_000;
      await act(async () => journeyAWatch.success(observation));
    }
    assert.equal(routeReplacementCalls().length, 0);
    assert.ok(transportCalls.every((call) => call.name === "fetchSpeedLimit"));
    assert.ok(transportCalls.length >= 1);
    for (const call of transportCalls) {
      const payload = call.payload as { data?: { lat?: unknown; lng?: unknown } };
      assert.equal(Number.isFinite(payload.data?.lat), true);
      assert.equal(Number.isFinite(payload.data?.lng), true);
    }
    const postGpsJourneyA = renderer.root
      .findAllByType(ScenicMap)
      .find((node) => node.props.navMode)!.props;
    assert.equal(postGpsJourneyA.encodedPolyline, "geometry-a");
    assert.equal(postGpsJourneyA.routeDurationSeconds, 3_600);
    assert.deepEqual(postGpsJourneyA.steps, journeyAResult.directions.steps);
    assert.deepEqual(postGpsJourneyA.points, journeyA.points);
    assert.equal(
      renderer.root.findByType(ActiveNavigationMap).props.journeyIdentity,
      journeyAIdentity,
    );
    assert.match(textOf(renderer.root), /Navigate: Journey A/);
    assert.ok(trafficLayerMaps.some((map) => map !== null));
    transportCalls.length = 0;

    await act(async () => button(renderer.root, /^Traffic map$/).props.onClick());
    assert.equal(
      renderer.root.findAllByType(ScenicMap).find((node) => node.props.navMode)!.props.showTraffic,
      false,
    );
    assert.equal(trafficLayerMaps.at(-1), null);
    assert.equal(transportCalls.length, 0);

    await act(async () => button(renderer.root, /Take the better route/).props.onClick());
    const journeyB = renderer.root
      .findAllByType(ScenicMap)
      .find((node) => node.props.navMode)!.props;
    assert.equal(journeyB.encodedPolyline, "geometry-b");
    assert.equal(journeyB.routeDurationSeconds, 4_800);
    assert.deepEqual(journeyB.steps, journeyBPayload.directions.steps);
    assert.deepEqual(journeyB.points, journeyA.points);
    assert.notEqual(
      renderer.root.findByType(ActiveNavigationMap).props.journeyIdentity,
      journeyAIdentity,
    );
    assert.equal(clearedWatchIds.includes(journeyAWatch.id), true);
    const journeyBWatch = geolocationWatches.at(-1)!;
    assert.notEqual(journeyBWatch.id, journeyAWatch.id);
    fakeNow += 120_000;
    await act(async () => journeyAWatch.success(position(51.54, -0.13)));
    const journeyBAfterStale = renderer.root
      .findAllByType(ScenicMap)
      .find((node) => node.props.navMode)!.props;
    assert.equal(journeyBAfterStale.encodedPolyline, "geometry-b");
    assert.equal(journeyBAfterStale.routeDurationSeconds, 4_800);
    assert.deepEqual(journeyBAfterStale.steps, journeyBPayload.directions.steps);
    assert.deepEqual(journeyBAfterStale.points, journeyA.points);
    fakeNow += 120_000;
    await act(async () => journeyBWatch.success(position(51.53, -0.1)));
    assert.match(textOf(renderer.root), /Navigate: Journey B/);
    assert.match(textOf(renderer.root), /In \d/);
    assert.equal(routeReplacementCalls().length, 0);
    assert.ok(transportCalls.every((call) => call.name === "fetchSpeedLimit"));

    await act(async () => renderer.unmount());
    assert.equal(clearedWatchIds.includes(journeyBWatch.id), true);
    for (const watch of geolocationWatches) {
      assert.equal(clearedWatchIds.includes(watch.id), true);
    }
    transportCalls.length = 0;
    fakeNow += 120_000;
    await act(async () => journeyBWatch.success(position(51.54, -0.1)));
    assert.equal(routeReplacementCalls().length, 0);
  });

  it("keeps the ActiveNavigationMap identity and unmount guard independently covered", async () => {
    const { ActiveNavigationMap } = await import("../components/ActiveNavigationMap");
    const { ScenicMap } = await import("../components/ScenicMap");
    const journeyAEvents: RouteProgress[] = [];
    const journeyBEvents: RouteProgress[] = [];
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ActiveNavigationMap
          journeyIdentity="a"
          points={[]}
          encodedPolyline="a"
          onProgress={(event) => event && journeyAEvents.push(event)}
        />,
        { createNodeMock: () => ({}) },
      );
    });
    const stale = renderer.root.findByType(ScenicMap).props.onProgress;
    await act(async () => {
      renderer.update(
        <ActiveNavigationMap
          journeyIdentity="b"
          points={[]}
          encodedPolyline="b"
          onProgress={(event) => event && journeyBEvents.push(event)}
        />,
      );
    });
    const current = renderer.root.findByType(ScenicMap).props.onProgress;
    const progress = {
      onRoute: true,
      percent: 1,
      remainingMeters: 1,
      remainingSeconds: 1,
      distanceFromRouteMeters: 1,
    };
    await act(async () => {
      stale(progress);
      current(progress);
    });
    assert.deepEqual(journeyAEvents, []);
    assert.deepEqual(journeyBEvents, [progress]);
    await act(async () => renderer.unmount());
    await act(async () => current(progress));
    assert.deepEqual(journeyBEvents, [progress]);
  });

  it("retains a repository-wide forbidden-symbol backstop", () => {
    assert.doesNotMatch(planSource, /recomputeDirections|handleReroute|onReroute|onOffRoute/);
    assert.doesNotMatch(planSource, /alternateRoutes|onAlternateClick|savedSeconds/);
    assert.doesNotMatch(planSource, /Switch route|saves \d+ min|avoids traffic/);
    assert.match(planSource, /planScenicRoute/);
    assert.match(planSource, /<ActiveNavigationMap/);
  });
});
