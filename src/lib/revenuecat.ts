// Client-only wrapper for the RevenueCat Capacitor SDK.
//
// The RC SDK is a native plugin — it must not be imported on the web or during
// SSR. All calls are gated behind `isNativePlatform()` and use dynamic import
// so the module is only pulled in on device.
//
// Public SDK keys are safe to ship in the app binary (that is their intended
// use). They are NOT secret; do not confuse them with the RevenueCat REST API
// secret key, which must never appear in client code.

import { getPlatform, isNativePlatform } from "@/lib/native";

// Public, app-specific SDK keys are injected into the browser/native bundle by
// Vite. Development may deliberately use RevenueCat Test Store keys. Production
// must always provide the relevant platform's live key and never falls back to
// a Test Store key.
const RC_IOS_KEY = import.meta.env.VITE_REVENUECAT_IOS_PUBLIC_SDK_KEY as string | undefined;
const RC_ANDROID_KEY = import.meta.env.VITE_REVENUECAT_ANDROID_PUBLIC_SDK_KEY as string | undefined;

function getRevenueCatApiKey(): string {
  const platform = getPlatform();
  const variableName =
    platform === "ios"
      ? "VITE_REVENUECAT_IOS_PUBLIC_SDK_KEY"
      : "VITE_REVENUECAT_ANDROID_PUBLIC_SDK_KEY";
  const apiKey = platform === "ios" ? RC_IOS_KEY : RC_ANDROID_KEY;

  if (!apiKey) {
    throw new Error(`[revenuecat] Missing ${variableName} for ${platform}`);
  }

  if (import.meta.env.PROD && apiKey.startsWith("test_")) {
    throw new Error(
      `[revenuecat] ${variableName} must be a production public SDK key; Test Store keys are not allowed in production`,
    );
  }

  return apiKey;
}

export const RC_ENTITLEMENT_ID = "premium";
export const RC_OFFERING_ID = "default";
export const RC_PRODUCT_MONTHLY = "com.GoScenik.premium.monthly";
export const RC_PRODUCT_ANNUAL = "com.GoScenik.premium.annual";

// Apple's stable deep link into a user's subscriptions in the App Store app.
export const APPLE_MANAGE_SUBSCRIPTIONS_URL = "https://apps.apple.com/account/subscriptions";

// Minimal shape we care about from a RevenueCat Package.
export type RCPackage = {
  identifier: string;
  packageType: string; // MONTHLY / ANNUAL / CUSTOM ...
  billing: "monthly" | "annual" | "other";
  productIdentifier: string;
  title: string;
  description: string;
  priceString: string; // localised
  price: number;
  currencyCode: string;
  raw: unknown; // pass back to Purchases.purchasePackage
};

export type RCOffering = {
  identifier: string;
  monthly: RCPackage | null;
  annual: RCPackage | null;
  all: RCPackage[];
};

let configured = false;
let currentAppUserId: string | null = null;
const RC_TIMEOUT_MS = 12_000;
const SUBSCRIPTIONS_UNAVAILABLE = "Subscriptions aren’t available in this test build yet.";

function diagnostic(
  failureStage: string,
  errorCode: string,
  offeringExists = false,
  monthlyPackageExists = false,
  annualPackageExists = false,
) {
  console.info("[revenuecat]", {
    platform: getPlatform(),
    configured,
    offeringExists,
    monthlyPackageExists,
    annualPackageExists,
    failureStage,
    errorCode,
  });
}

function stableErrorCode(error: unknown, fallback: string): string {
  return error instanceof Error && /^RC_[A-Z_]+$/.test(error.message) ? error.message : fallback;
}

function withTimeout<T>(promise: Promise<T>, code: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error(code)), RC_TIMEOUT_MS)),
  ]);
}

async function loadPurchases() {
  const mod = await import("@revenuecat/purchases-capacitor");
  return mod.Purchases;
}

export async function initRevenueCat(appUserId?: string): Promise<void> {
  if (!isNativePlatform() || configured) return;
  const apiKey = getRevenueCatApiKey();
  try {
    const Purchases = await loadPurchases();
    await withTimeout(Purchases.configure({ apiKey, appUserID: appUserId }), "RC_CONFIG_TIMEOUT");
    configured = true;
    currentAppUserId = appUserId ?? null;
  } catch (err) {
    configured = false;
    diagnostic("configure", stableErrorCode(err, "RC_CONFIG_FAILED"));
    throw new Error("RC_CONFIG_FAILED");
  }
}

export async function rcLogIn(appUserId: string): Promise<void> {
  if (!isNativePlatform()) return;
  if (!configured) {
    await initRevenueCat(appUserId);
    return;
  }
  if (currentAppUserId === appUserId) return;
  try {
    const Purchases = await loadPurchases();
    await Purchases.logIn({ appUserID: appUserId });
    currentAppUserId = appUserId;
  } catch (err) {
    diagnostic("login", "RC_LOGIN_FAILED");
  }
}

export async function rcLogOut(): Promise<void> {
  if (!isNativePlatform() || !configured) return;
  try {
    const Purchases = await loadPurchases();
    await Purchases.logOut();
    currentAppUserId = null;
  } catch (err) {
    // logOut throws if already anonymous — harmless.
    diagnostic("logout", "RC_LOGOUT_FAILED");
  }
}

type RevenueCatProductShape = {
  identifier?: string;
  title?: string;
  description?: string;
  priceString?: string;
  price?: number;
  currencyCode?: string;
};

type RevenueCatPackageShape = {
  identifier?: string;
  packageType?: string;
  product?: RevenueCatProductShape;
};

type RevenueCatOfferingShape = {
  identifier?: string;
  monthly?: unknown;
  annual?: unknown;
  availablePackages?: unknown[];
};

type CustomerInfoShape = {
  entitlements?: { active?: Record<string, RevenueCatEntitlementShape> };
  managementURL?: string | null;
};

type RevenueCatEntitlementShape = {
  willRenew?: boolean;
  expirationDate?: string | null;
  productIdentifier?: string | null;
};

function normalisePackage(value: unknown): RCPackage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as RevenueCatPackageShape;
  const product = raw.product ?? {};
  const packageType: string = raw.packageType ?? raw.identifier ?? "";
  const billing: RCPackage["billing"] =
    packageType === "MONTHLY" || raw.identifier === "$rc_monthly"
      ? "monthly"
      : packageType === "ANNUAL" || raw.identifier === "$rc_annual"
        ? "annual"
        : "other";
  return {
    identifier: raw.identifier ?? "",
    packageType,
    billing,
    productIdentifier: product.identifier ?? "",
    title: product.title ?? "",
    description: product.description ?? "",
    priceString: product.priceString ?? "",
    price: typeof product.price === "number" ? product.price : 0,
    currencyCode: product.currencyCode ?? "",
    raw: value,
  };
}

export async function getCurrentOffering(): Promise<RCOffering | null> {
  if (!isNativePlatform()) return null;
  try {
    if (!configured) await initRevenueCat();
    const Purchases = await loadPurchases();
    const res = await withTimeout(Purchases.getOfferings(), "RC_OFFERING_TIMEOUT");
    // Prefer explicitly-named "default" offering, fall back to `.current`.
    const chosen = (res.all && res.all[RC_OFFERING_ID]) || res.current || null;
    if (!chosen) {
      diagnostic("offering", "RC_OFFERING_MISSING");
      return null;
    }
    const selected = chosen as unknown as RevenueCatOfferingShape;
    const all = (selected.availablePackages ?? [])
      .map(normalisePackage)
      .filter((p: RCPackage | null): p is RCPackage => !!p);
    const monthly =
      normalisePackage(selected.monthly) ??
      all.find(
        (pkg) => pkg.billing === "monthly" || pkg.productIdentifier === RC_PRODUCT_MONTHLY,
      ) ??
      null;
    const annual =
      normalisePackage(selected.annual) ??
      all.find((pkg) => pkg.billing === "annual" || pkg.productIdentifier === RC_PRODUCT_ANNUAL) ??
      null;
    diagnostic("none", "OK", true, !!monthly, !!annual);
    return { identifier: selected.identifier ?? RC_OFFERING_ID, monthly, annual, all };
  } catch (err) {
    diagnostic("offering", stableErrorCode(err, "RC_OFFERING_FAILED"));
    return null;
  }
}

function customerInfoIsPremium(info: unknown): boolean {
  return !!(info as CustomerInfoShape | null)?.entitlements?.active?.[RC_ENTITLEMENT_ID];
}

export type RCPremiumState = {
  isPremium: boolean;
  willRenew: boolean;
  expirationDate: string | null;
  productIdentifier: string | null;
  managementURL: string | null;
};

function toPremiumState(value: unknown): RCPremiumState {
  const info = (value ?? {}) as CustomerInfoShape;
  const ent = info.entitlements?.active?.[RC_ENTITLEMENT_ID];
  return {
    isPremium: !!ent,
    willRenew: !!ent?.willRenew,
    expirationDate: ent?.expirationDate ?? null,
    productIdentifier: ent?.productIdentifier ?? null,
    managementURL: info?.managementURL ?? null,
  };
}

export async function getPremiumState(): Promise<RCPremiumState> {
  const empty: RCPremiumState = {
    isPremium: false,
    willRenew: false,
    expirationDate: null,
    productIdentifier: null,
    managementURL: null,
  };
  if (!isNativePlatform()) return empty;
  try {
    if (!configured) await initRevenueCat();
    const Purchases = await loadPurchases();
    const res = await withTimeout(Purchases.getCustomerInfo(), "RC_CUSTOMER_INFO_TIMEOUT");
    const response = res as unknown as { customerInfo?: unknown };
    return toPremiumState(response.customerInfo ?? res);
  } catch (err) {
    diagnostic("customer_info", "RC_CUSTOMER_INFO_FAILED");
    return empty;
  }
}

export type PurchaseOutcome =
  | { status: "success"; state: RCPremiumState }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export async function purchaseRCPackage(pkg: RCPackage): Promise<PurchaseOutcome> {
  if (!isNativePlatform()) return { status: "error", message: SUBSCRIPTIONS_UNAVAILABLE };
  try {
    if (!configured) await initRevenueCat();
    const Purchases = await loadPurchases();
    const purchaseArgs = { aPackage: pkg.raw } as Parameters<typeof Purchases.purchasePackage>[0];
    const result = await withTimeout(
      Purchases.purchasePackage(purchaseArgs),
      "RC_PURCHASE_TIMEOUT",
    );
    const state = toPremiumState(result.customerInfo);
    if (state.isPremium) return { status: "success", state };
    diagnostic(
      "entitlement",
      "RC_ENTITLEMENT_INACTIVE",
      true,
      pkg.billing === "monthly",
      pkg.billing === "annual",
    );
    return { status: "error", message: SUBSCRIPTIONS_UNAVAILABLE };
  } catch (e: unknown) {
    const purchaseError = e as { userCancelled?: boolean; code?: string; message?: string };
    if (
      purchaseError.userCancelled ||
      purchaseError.code === "1" ||
      /cancel/i.test(purchaseError.message ?? "")
    ) {
      diagnostic(
        "purchase",
        "RC_PURCHASE_CANCELLED",
        true,
        pkg.billing === "monthly",
        pkg.billing === "annual",
      );
      return { status: "cancelled" };
    }
    diagnostic(
      "purchase",
      stableErrorCode(e, "RC_PURCHASE_FAILED"),
      true,
      pkg.billing === "monthly",
      pkg.billing === "annual",
    );
    return { status: "error", message: SUBSCRIPTIONS_UNAVAILABLE };
  }
}

export async function restoreRC(): Promise<RCPremiumState> {
  if (!isNativePlatform()) {
    return {
      isPremium: false,
      willRenew: false,
      expirationDate: null,
      productIdentifier: null,
      managementURL: null,
    };
  }
  try {
    if (!configured) await initRevenueCat();
    const Purchases = await loadPurchases();
    const res = await withTimeout(Purchases.restorePurchases(), "RC_RESTORE_TIMEOUT");
    const response = res as unknown as { customerInfo?: unknown };
    return toPremiumState(response.customerInfo ?? res);
  } catch (err) {
    diagnostic("restore", "RC_RESTORE_FAILED");
    throw new Error("RC_RESTORE_FAILED");
  }
}

// Back-compat aliases (older call sites).
export async function configureRevenueCat(appUserId: string) {
  await initRevenueCat(appUserId);
  if (appUserId) await rcLogIn(appUserId);
}

export async function purchasePremium(
  billing: "monthly" | "annual",
): Promise<{ isPremium: boolean }> {
  const offering = await getCurrentOffering();
  const pkg = billing === "monthly" ? offering?.monthly : offering?.annual;
  if (!pkg) throw new Error(`No ${billing} package available`);
  const out = await purchaseRCPackage(pkg);
  if (out.status === "cancelled") return { isPremium: false };
  if (out.status === "error") throw new Error(out.message);
  return { isPremium: out.state.isPremium };
}

export async function restoreRevenueCat(): Promise<{ isPremium: boolean }> {
  const s = await restoreRC();
  return { isPremium: s.isPremium };
}
