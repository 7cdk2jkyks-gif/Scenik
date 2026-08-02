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

async function loadPurchases() {
  const mod = await import("@revenuecat/purchases-capacitor");
  return mod.Purchases;
}

export async function initRevenueCat(appUserId?: string): Promise<void> {
  if (!isNativePlatform() || configured) return;
  const apiKey = getRevenueCatApiKey();
  try {
    const Purchases = await loadPurchases();
    await Purchases.configure({ apiKey, appUserID: appUserId });
    configured = true;
    currentAppUserId = appUserId ?? null;
  } catch (err) {
    console.warn("[revenuecat] configure failed", err);
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
    console.warn("[revenuecat] logIn failed", err);
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
    console.warn("[revenuecat] logOut warn", err);
  }
}

function normalisePackage(raw: any): RCPackage | null {
  if (!raw) return null;
  const product = raw.product ?? {};
  const packageType: string = raw.packageType ?? raw.identifier ?? "";
  const billing: RCPackage["billing"] =
    packageType === "MONTHLY" || raw.identifier === "$rc_monthly"
      ? "monthly"
      : packageType === "ANNUAL" || raw.identifier === "$rc_annual"
      ? "annual"
      : "other";
  return {
    identifier: raw.identifier,
    packageType,
    billing,
    productIdentifier: product.identifier ?? "",
    title: product.title ?? "",
    description: product.description ?? "",
    priceString: product.priceString ?? "",
    price: typeof product.price === "number" ? product.price : 0,
    currencyCode: product.currencyCode ?? "",
    raw,
  };
}

export async function getCurrentOffering(): Promise<RCOffering | null> {
  if (!isNativePlatform()) return null;
  if (!configured) await initRevenueCat();
  try {
    const Purchases = await loadPurchases();
    const res = await Purchases.getOfferings();
    // Prefer explicitly-named "default" offering, fall back to `.current`.
    const chosen =
      (res.all && res.all[RC_OFFERING_ID]) || res.current || null;
    if (!chosen) return null;
    const monthly = normalisePackage((chosen as any).monthly);
    const annual = normalisePackage((chosen as any).annual);
    const all = ((chosen as any).availablePackages ?? [])
      .map(normalisePackage)
      .filter((p: RCPackage | null): p is RCPackage => !!p);
    return { identifier: (chosen as any).identifier ?? RC_OFFERING_ID, monthly, annual, all };
  } catch (err) {
    console.warn("[revenuecat] getOfferings failed", err);
    return null;
  }
}

function customerInfoIsPremium(info: any): boolean {
  return !!info?.entitlements?.active?.[RC_ENTITLEMENT_ID];
}

export type RCPremiumState = {
  isPremium: boolean;
  willRenew: boolean;
  expirationDate: string | null;
  productIdentifier: string | null;
  managementURL: string | null;
};

function toPremiumState(info: any): RCPremiumState {
  const ent = info?.entitlements?.active?.[RC_ENTITLEMENT_ID];
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
  if (!configured) await initRevenueCat();
  try {
    const Purchases = await loadPurchases();
    const res = await Purchases.getCustomerInfo();
    return toPremiumState((res as any).customerInfo ?? res);
  } catch (err) {
    console.warn("[revenuecat] getCustomerInfo failed", err);
    return empty;
  }
}

export type PurchaseOutcome =
  | { status: "success"; state: RCPremiumState }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export async function purchaseRCPackage(pkg: RCPackage): Promise<PurchaseOutcome> {
  if (!isNativePlatform()) return { status: "error", message: "Native platform required" };
  try {
    const Purchases = await loadPurchases();
    const result: any = await Purchases.purchasePackage({ aPackage: pkg.raw as any });
    const state = toPremiumState(result.customerInfo);
    if (state.isPremium) return { status: "success", state };
    return { status: "error", message: "Purchase completed but entitlement not active yet." };
  } catch (e: any) {
    if (e?.userCancelled || e?.code === "1" || /cancel/i.test(e?.message ?? "")) {
      return { status: "cancelled" };
    }
    return { status: "error", message: e?.message ?? "Purchase failed" };
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
    const Purchases = await loadPurchases();
    const res: any = await Purchases.restorePurchases();
    return toPremiumState(res.customerInfo ?? res);
  } catch (err) {
    console.warn("[revenuecat] restore failed", err);
    throw err;
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
