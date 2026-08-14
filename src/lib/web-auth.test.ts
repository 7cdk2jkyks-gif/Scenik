import { describe, expect, mock, test } from "bun:test";
import {
  classifyOAuthReturnError,
  safeAuthReturnPath,
  safeWebAuthOrigin,
  selectOAuthPlatformFlow,
  startWebOAuth,
  restoreWebOAuthSession,
  webOAuthErrorMessage,
  webOAuthRedirectUrl,
  webSessionOutcome,
} from "./web-auth";

describe("web OAuth", () => {
  test("keeps native and web OAuth as separate platform branches", () => {
    expect(selectOAuthPlatformFlow(true)).toBe("native");
    expect(selectOAuthPlatformFlow(false)).toBe("web");
  });

  test("starts Apple through Supabase with an existing application return route", async () => {
    const signInWithOAuth = mock(async () => ({ error: null }));

    await startWebOAuth({
      auth: { signInWithOAuth },
      provider: "apple",
      origin: "https://www.goscenik.com",
    });

    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "apple",
      options: { redirectTo: "https://www.goscenik.com/plan" },
    });
    expect(JSON.stringify(signInWithOAuth.mock.calls)).not.toContain("~oauth/initiate");
    expect(JSON.stringify(signInWithOAuth.mock.calls)).not.toContain("lovable");
  });

  test("keeps the working Google web flow on Supabase", async () => {
    const signInWithOAuth = mock(async () => ({ error: null }));

    await startWebOAuth({
      auth: { signInWithOAuth },
      provider: "google",
      origin: "https://goscenik.com",
    });

    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: "https://goscenik.com/plan" },
    });
  });

  test("accepts configured origins and rejects obsolete or untrusted deployment origins", () => {
    expect(safeWebAuthOrigin("https://www.goscenik.com")).toBe("https://www.goscenik.com");
    expect(safeWebAuthOrigin("https://scenik-weld.vercel.app")).toBe(
      "https://scenik-weld.vercel.app",
    );
    expect(safeWebAuthOrigin("http://localhost:8080")).toBe("http://localhost:8080");
    expect(safeWebAuthOrigin("https://obsolete-deployment.vercel.app")).toBe(
      "https://goscenik.com",
    );
    expect(safeWebAuthOrigin("https://attacker.example")).toBe("https://goscenik.com");
  });

  test("preserves only known internal return paths and prevents open redirects", () => {
    expect(safeAuthReturnPath("/routes")).toBe("/routes");
    expect(safeAuthReturnPath("/settings")).toBe("/settings");
    expect(safeAuthReturnPath("https://attacker.example/steal")).toBe("/plan");
    expect(safeAuthReturnPath("//attacker.example/steal")).toBe("/plan");
    expect(safeAuthReturnPath("/missing-route")).toBe("/plan");
    expect(safeAuthReturnPath("/plan?next=https://attacker.example")).toBe("/plan");
    expect(webOAuthRedirectUrl("https://attacker.example", "//attacker.example")).toBe(
      "https://goscenik.com/plan",
    );
  });

  test("returns Supabase startup errors to the caller", async () => {
    const providerError = new Error("Provider unavailable");
    const result = await startWebOAuth({
      auth: { signInWithOAuth: async () => ({ error: providerError }) },
      provider: "apple",
      origin: "https://goscenik.com",
    });

    expect(result.error).toBe(providerError);
  });

  test("classifies provider cancellation and errors without reflecting sensitive details", () => {
    expect(classifyOAuthReturnError("?error=access_denied&code=secret-code")).toBe("cancelled");
    expect(classifyOAuthReturnError("?error=server_error&error_description=private-detail")).toBe(
      "failed",
    );
    expect(classifyOAuthReturnError("?code=secret-code")).toBeNull();
    expect(webOAuthErrorMessage("cancelled")).toBe(
      "Sign-in was cancelled. You can try again when you're ready.",
    );
    expect(webOAuthErrorMessage("failed")).toBe("We couldn't complete sign-in. Please try again.");
    expect(webOAuthErrorMessage("failed")).not.toContain("private-detail");
    expect(webOAuthErrorMessage("failed")).not.toContain("secret-code");
  });

  test("restores an existing or asynchronously established session", async () => {
    const existingSession = { user: { id: "verified-user" } };
    expect(
      await restoreWebOAuthSession(
        {
          getSession: async () => ({ data: { session: existingSession }, error: null }),
          onAuthStateChange: () => {
            throw new Error("subscription should not start");
          },
        },
        5,
      ),
    ).toEqual({ data: { session: existingSession }, error: null });

    let callback: ((event: unknown, session: unknown | null) => void) | undefined;
    let unsubscribed = false;
    const pending = restoreWebOAuthSession(
      {
        getSession: async () => ({ data: { session: null }, error: null }),
        onAuthStateChange: (next) => {
          callback = next;
          return { data: { subscription: { unsubscribe: () => (unsubscribed = true) } } };
        },
      },
      50,
    );
    await Promise.resolve();
    callback?.("SIGNED_IN", existingSession);
    expect(await pending).toEqual({ data: { session: existingSession }, error: null });
    expect(unsubscribed).toBe(true);
  });

  test("returns missing and failed restoration states without exposing raw errors", async () => {
    const missing = await restoreWebOAuthSession(
      {
        getSession: async () => ({ data: { session: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      },
      1,
    );
    expect(missing).toEqual({ data: { session: null }, error: null });

    const failed = await restoreWebOAuthSession(
      {
        getSession: async () => ({
          data: { session: null },
          error: "access_token=secret provider-private-message",
        }),
        onAuthStateChange: () => {
          throw new Error("subscription should not start");
        },
      },
      1,
    );
    expect(failed.error).toBeTruthy();
    expect(webOAuthErrorMessage("failed")).not.toContain("secret");
    expect(webSessionOutcome({ data: { session: { user: {} } }, error: null })).toBe(
      "authenticated",
    );
    expect(webSessionOutcome(missing)).toBe("missing");
    expect(webSessionOutcome(failed)).toBe("failed");
  });
});
