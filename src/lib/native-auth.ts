// Native (in-app) social sign-in for Capacitor iOS/Android.
// Uses @capgo/capacitor-social-login to keep users inside the app —
// Apple shows the native sheet, Google uses the native flow. On web we
// fall back to the Lovable OAuth broker.
import { isNativePlatform, isIOS } from "./native";
import { supabase } from "@/integrations/supabase/client";
import type { NativeAuthResult } from "@/lib/native-auth-transition";

let initialized = false;

const RAW_IOS_CLIENT_ID = import.meta.env.VITE_GOOGLE_IOS_CLIENT_ID as string | undefined;
const RAW_WEB_CLIENT_ID = import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID as string | undefined;

const GOOGLE_CLIENT_ID_PATTERN = /\d+-[a-z0-9]+\.apps\.googleusercontent\.com/gi;

function selectGoogleClientId(raw: string | undefined, exclude?: string): string | undefined {
  const candidates = raw?.match(GOOGLE_CLIENT_ID_PATTERN) ?? [];
  return candidates.find((candidate) => candidate !== exclude) ?? candidates[0];
}

const IOS_CLIENT_ID = selectGoogleClientId(RAW_IOS_CLIENT_ID);
const WEB_CLIENT_ID = selectGoogleClientId(RAW_WEB_CLIENT_ID, IOS_CLIENT_ID);

function logClientIdMetadata(
  variableName: string,
  raw: string | undefined,
  selected: string | undefined,
) {
  console.log("[Auth] Google client configuration", {
    variableName,
    exists: Boolean(selected),
    finalSix: selected?.slice(-6) ?? "none",
    containsQuotes: /["']/.test(raw ?? ""),
    containsSpaces: / /.test(raw ?? ""),
    containsCommas: /,/.test(raw ?? ""),
    containsNewlines: /[\r\n]/.test(raw ?? ""),
  });
}

async function ensureInit() {
  if (initialized) return;
  const platform = isNativePlatform() ? (isIOS() ? "ios" : "android") : "web";
  console.log("[Auth] SocialLogin.initialize selected platform:", platform);
  logClientIdMetadata("VITE_GOOGLE_IOS_CLIENT_ID", RAW_IOS_CLIENT_ID, IOS_CLIENT_ID);
  logClientIdMetadata("VITE_GOOGLE_WEB_CLIENT_ID", RAW_WEB_CLIENT_ID, WEB_CLIENT_ID);
  if (!IOS_CLIENT_ID || !WEB_CLIENT_ID) {
    throw new Error("Native Google sign-in client configuration is missing or invalid");
  }
  const { SocialLogin } = await import("@capgo/capacitor-social-login");
  await SocialLogin.initialize({
    google: {
      // Web client ID from Google Cloud. Reused by Capgo on iOS to mint ID tokens.
      iOSClientId: IOS_CLIENT_ID,
      iOSServerClientId: WEB_CLIENT_ID,
      webClientId: WEB_CLIENT_ID,
    },
    apple: {},
  });
  initialized = true;
}

export function canUseNativeAuth(provider: "google" | "apple"): boolean {
  if (!isNativePlatform()) return false;
  // Apple native sheet only on iOS. Google native on both.
  if (provider === "apple") return isIOS();
  return true;
}

// Cryptographically secure random raw nonce (URL-safe base64).
function generateRawNonce(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
    const json = atob(pad);
    // Handle UTF-8
    const decoded = decodeURIComponent(
      Array.from(json)
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(""),
    );
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

async function doGoogleLoginOnce(reqId: string): Promise<{
  idToken: string;
  payload: Record<string, unknown> | null;
  rawNonce: string;
  hashedNonce: string;
}> {
  const { SocialLogin } = await import("@capgo/capacitor-social-login");
  const rawNonce = generateRawNonce();
  const hashedNonce = await sha256Hex(rawNonce);

  const res = await withTimeout(
    SocialLogin.login({
      provider: "google",
      options: {
        nonce: hashedNonce,
        scopes: ["email", "profile"],
      } as unknown as { scopes: string[] },
    }),
    60_000,
    "Google sign-in",
  );
  const idToken = (res.result as { idToken?: string })?.idToken;
  if (!idToken) throw new Error("Google sign-in didn't return an identity token");
  alog(reqId, "native token received");
  const payload = decodeJwtPayload(idToken);
  return { idToken, payload, rawNonce, hashedNonce };
}

// Timeouts are ONLY applied to native UI bridge calls (which can genuinely
// hang on a dismissed sheet). Session-creating calls are never raced against a
// timer: a timer that fires while the request is still in flight produces two
// terminal states (a "timed out" failure plus a later real session).
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// Unique id per sign-in attempt so every log line is attributable.
function newRequestId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function alog(reqId: string, ...args: unknown[]) {
  console.log(`[Auth][${reqId}]`, ...args);
}

function logAudienceMetadata(reqId: string, audience: unknown) {
  const value = typeof audience === "string" ? audience : undefined;
  alog(reqId, "token audience metadata:", {
    exists: Boolean(value),
    finalSix: value?.slice(-6) ?? "none",
  });
}

type NativeGoogleBridge = (input: { data: { idToken: string } }) => Promise<{
  tokenHash: string;
  verificationSucceeded: boolean;
  magicLinkReturned: boolean;
}>;

export async function nativeSignIn(
  provider: "google" | "apple",
  googleBridge?: NativeGoogleBridge,
): Promise<NativeAuthResult> {
  const reqId = newRequestId();
  alog(reqId, "platform:", isNativePlatform() ? (isIOS() ? "ios" : "android") : "web");
  alog(reqId, "provider and selected flow:", provider, "native");
  await withTimeout(ensureInit(), 15_000, "Native sign-in setup");
  const { SocialLogin } = await import("@capgo/capacitor-social-login");

  // Single terminal state guard: once the attempt has resolved (success or
  // failure) nothing else from the same attempt may change the outcome.
  let settled = false;
  const settle = (outcome: "success" | "failure", detail?: string) => {
    if (settled) {
      alog(reqId, "ignored late outcome after terminal state:", outcome, detail ?? "");
      return false;
    }
    settled = true;
    alog(reqId, "terminal state:", outcome, detail ?? "");
    return true;
  };

  if (provider === "apple") {
    const rawNonce = generateRawNonce();
    const hashedNonce = await sha256Hex(rawNonce);
    alog(reqId, "apple: starting native sheet (nonce generated)");

    const res = await withTimeout(
      SocialLogin.login({
        provider: "apple",
        options: { scopes: ["email", "name"], nonce: hashedNonce },
      }),
      60_000,
      "Apple sign-in",
    );
    alog(reqId, "apple: native result returned");

    const idToken = (res.result as { idToken?: string })?.idToken;
    alog(reqId, "apple: identityToken present?", Boolean(idToken));
    if (!idToken) {
      settle("failure", "no identity token");
      throw new Error("Apple sign-in didn't return an identity token");
    }

    const payload = decodeJwtPayload(idToken);
    const tokenNonce = payload?.["nonce"] as string | undefined;
    const aud = payload?.["aud"];
    logAudienceMetadata(reqId, aud);
    alog(reqId, "apple: nonce claim matches hash?", tokenNonce === hashedNonce);

    const credentials: { provider: "apple"; token: string; nonce?: string } = {
      provider: "apple",
      token: idToken,
    };
    if (tokenNonce !== undefined && tokenNonce === hashedNonce) {
      credentials.nonce = rawNonce;
    }

    alog(
      reqId,
      "apple: signInWithIdToken started (nonce sent?",
      credentials.nonce !== undefined,
      ")",
    );
    // No timeout: this call creates the session. Racing it against a timer
    // produced a "timed out" failure followed by a later real session.
    const { data, error } = await supabase.auth.signInWithIdToken(credentials);
    alog(reqId, "apple: Supabase response received");
    if (error) {
      alog(reqId, "token exchange error:", error.message);
      settle("failure", error.message);
      if (/audience/i.test(error.message)) {
        throw new Error(
          `Apple sign-in isn't authorised for this app yet. Add the native bundle identifier (${typeof aud === "string" ? aud : "com.GoScenik"}) to the accepted Apple client IDs in the app's auth settings.`,
        );
      }
      throw error;
    }
    alog(reqId, "apple: session returned?", Boolean(data?.session));
    if (!data?.session) {
      settle("failure", "no session returned");
      throw new Error("Apple sign-in completed but no session was returned");
    }

    alog(reqId, "apple: session confirmed");
    settle("success", "apple session created");
    return { requestId: reqId, session: data.session };
  }

  // Google flow with nonce, retry once on stale/cached token mismatch.
  let attempt = await doGoogleLoginOnce(reqId);
  let tokenNonce = attempt.payload?.["nonce"] as string | undefined;
  const nonceMismatch = tokenNonce !== undefined && tokenNonce !== attempt.hashedNonce;
  const nonceMissingButExpected = tokenNonce === undefined; // we always request one

  alog(reqId, "google: token has nonce claim?", tokenNonce !== undefined);

  if (nonceMismatch || nonceMissingButExpected) {
    alog(reqId, "google: nonce mismatch/missing — clearing cached session and retrying once");
    try {
      await SocialLogin.logout({ provider: "google" });
    } catch (e) {
      alog(reqId, "google: logout before retry failed (continuing):", e);
    }
    attempt = await doGoogleLoginOnce(reqId);
    tokenNonce = attempt.payload?.["nonce"] as string | undefined;
    alog(reqId, "google: retry token has nonce claim?", tokenNonce !== undefined);
  }

  const aud = attempt.payload?.["aud"];
  logAudienceMetadata(reqId, aud);

  const credentials: {
    provider: "google";
    token: string;
    nonce?: string;
  } = {
    provider: "google",
    token: attempt.idToken,
  };

  if (tokenNonce !== undefined && tokenNonce === attempt.hashedNonce) {
    credentials.nonce = attempt.rawNonce;
  }

  alog(reqId, "signInWithIdToken started");
  // No timeout: session-creating call.
  const { data: primaryData, error } = await supabase.auth.signInWithIdToken(credentials);
  const primaryCode =
    error?.code ?? error?.status ?? (primaryData.session ? "session_returned" : "no_session");
  alog(reqId, "primary exchange status:", primaryCode);
  if (error) {
    alog(reqId, "primary exchange error:", error.message);
    const errorCode = typeof error.code === "string" ? error.code.toLowerCase() : "";
    const audienceMessage = /audience|unacceptable audience in id_token|invalid.*client/i.test(
      error.message,
    );
    const audienceCode = /identity|id_token|oauth|provider|bad_jwt/.test(errorCode);
    const acceptedIOSAudience = typeof aud === "string" && aud === IOS_CLIENT_ID;

    if (acceptedIOSAudience || audienceMessage || (error.status === 400 && audienceCode)) {
      alog(reqId, "fallback started");
      if (!googleBridge) {
        settle("failure", "bridge unavailable");
        throw new Error("Native Google bridge is unavailable");
      }
      let bridgeReached = false;
      try {
        alog(reqId, "bridge called");
        // Bridge call is a plain HTTP RPC that creates no session, so a
        // timeout here is safe and cannot produce a second terminal state.
        const bridge = await withTimeout(
          googleBridge({ data: { idToken: attempt.idToken } }),
          30_000,
          "Native Google bridge",
        );
        bridgeReached = true;
        alog(
          reqId,
          "bridge returned; verification:",
          bridge.verificationSucceeded,
          "magic link:",
          bridge.magicLinkReturned,
        );
        alog(reqId, "verifyOtp started");
        // No timeout: this is the call that actually creates the session. The
        // previous 30s race is exactly what produced "timed out" followed by a
        // successful session moments later (magic-link verification on a cold
        // native connection regularly exceeds 30s).
        const { data: otpData, error: otpError } = await supabase.auth.verifyOtp({
          type: "magiclink",
          token_hash: bridge.tokenHash,
        });
        alog(reqId, "verifyOtp returned; session:", Boolean(otpData?.session));
        if (otpError) throw new Error(`verifyOtp failed: ${otpError.message}`);
        if (!otpData.session) throw new Error("verifyOtp completed without returning a session");
        settle("success", "google session created via bridge");
        return { requestId: reqId, session: otpData.session };
      } catch (fallbackError) {
        alog(reqId, "bridge request reached server:", bridgeReached);
        // Last check before declaring failure: if a session exists anyway,
        // this attempt succeeded and must not report an error.
        const { data: check } = await supabase.auth.getSession();
        if (check.session) {
          settle("success", "session present despite fallback error");
          return { requestId: reqId, session: check.session };
        }
        const message =
          fallbackError instanceof Error ? fallbackError.message : "Native Google fallback failed";
        settle("failure", message);
        throw new Error(`Native Google fallback failed: ${message}`);
      }
    }
    settle("failure", error.message);
    throw error;
  }
  alog(reqId, "session returned:", Boolean(primaryData.session));
  if (!primaryData.session) {
    settle("failure", "no session returned");
    throw new Error("Google sign-in completed without returning a session");
  }
  settle("success", "google session created");
  return { requestId: reqId, session: primaryData.session };
}
