export type AuthProvider = "apple" | "google";

export type AuthFailureCode =
  | "AUTH_CANCELLED"
  | "AUTH_START_FAILED"
  | "AUTH_PROVIDER_FAILED"
  | "AUTH_SESSION_FAILED"
  | "AUTH_EMAIL_FAILED"
  | "AUTH_UNEXPECTED_FAILURE";

export type AuthFailureStage = "start" | "provider" | "session" | "email";

type ErrorWithCode = { code?: unknown };

export function classifyAuthFailure(input: {
  error: unknown;
  stage: AuthFailureStage;
  nativeProvider?: AuthProvider;
}): AuthFailureCode {
  if (
    input.nativeProvider &&
    typeof input.error === "object" &&
    input.error !== null &&
    (input.error as ErrorWithCode).code === "USER_CANCELLED"
  ) {
    return "AUTH_CANCELLED";
  }
  if (input.stage === "start") return "AUTH_START_FAILED";
  if (input.stage === "provider") return "AUTH_PROVIDER_FAILED";
  if (input.stage === "session") return "AUTH_SESSION_FAILED";
  if (input.stage === "email") return "AUTH_EMAIL_FAILED";
  return "AUTH_UNEXPECTED_FAILURE";
}

export function authFailureMessage(code: AuthFailureCode): string {
  if (code === "AUTH_CANCELLED") return "Sign-in was cancelled.";
  if (code === "AUTH_SESSION_FAILED") {
    return "We couldn’t finish signing you in. Please try again.";
  }
  if (code === "AUTH_EMAIL_FAILED") {
    return "We couldn’t complete email sign-in. Please try again.";
  }
  return "We couldn’t start sign-in. Please try again.";
}

export function safeEmailAuthMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && typeof (error as ErrorWithCode).code === "string"
      ? (error as ErrorWithCode).code
      : "";
  if (code === "invalid_credentials") return "Email or password is incorrect.";
  if (code === "email_not_confirmed") return "Please confirm your email before signing in.";
  if (code === "user_already_exists" || code === "user_already_registered") {
    return "An account already exists for this email.";
  }
  if (code === "weak_password") return "Please choose a stronger password.";
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit") {
    return "Please wait a moment before trying again.";
  }
  return authFailureMessage("AUTH_EMAIL_FAILED");
}
