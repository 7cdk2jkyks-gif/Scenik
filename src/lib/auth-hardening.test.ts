import { describe, expect, test } from "bun:test";
import { authFailureMessage, classifyAuthFailure, safeEmailAuthMessage } from "./auth-hardening";

describe("authentication hardening", () => {
  test("classifies only the native plugin's stable cancellation code", () => {
    for (const nativeProvider of ["apple", "google"] as const) {
      expect(
        classifyAuthFailure({
          error: { code: "USER_CANCELLED" },
          stage: "provider",
          nativeProvider,
        }),
      ).toBe("AUTH_CANCELLED");
      expect(
        classifyAuthFailure({
          error: new Error("cancel this request and expose token=secret"),
          stage: "provider",
          nativeProvider,
        }),
      ).toBe("AUTH_PROVIDER_FAILED");
    }
  });

  test("uses fixed messages that never reflect provider data", () => {
    expect(authFailureMessage("AUTH_CANCELLED")).toBe("Sign-in was cancelled.");
    expect(authFailureMessage("AUTH_START_FAILED")).toBe(
      "We couldn’t start sign-in. Please try again.",
    );
    expect(authFailureMessage("AUTH_SESSION_FAILED")).toBe(
      "We couldn’t finish signing you in. Please try again.",
    );
    expect(authFailureMessage("AUTH_PROVIDER_FAILED")).not.toContain("secret");
  });

  test("preserves a closed set of useful email messages and sanitizes unknown errors", () => {
    expect(safeEmailAuthMessage({ code: "invalid_credentials", message: "private" })).toBe(
      "Email or password is incorrect.",
    );
    expect(safeEmailAuthMessage({ code: "email_not_confirmed" })).toBe(
      "Please confirm your email before signing in.",
    );
    expect(safeEmailAuthMessage(new Error("email@example.com password=secret"))).toBe(
      "We couldn’t complete email sign-in. Please try again.",
    );
  });
});
