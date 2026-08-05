import type { CapacitorConfig } from "@capacitor/cli";

// Native shell configuration for iOS + Android builds. Scenik remains a hosted
// TanStack Start application because its SSR routes and server functions need
// the published origin.
const config: CapacitorConfig = {
  appId: "com.GoScenik",
  appName: "Scenik",
  webDir: "dist",
  server: {
    url: "https://scenik-weld.vercel.app",
  },

  ios: {
    contentInset: "always",
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: "#ffffff",
      showSpinner: false,
    },
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
    Geolocation: {
      // iOS uses NSLocationWhenInUseUsageDescription from Info.plist.
      // Android uses ACCESS_FINE_LOCATION + ACCESS_COARSE_LOCATION (foreground only).
    },
  },
};

export default config;
