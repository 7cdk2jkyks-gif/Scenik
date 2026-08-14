export type WebOAuthProvider = "google" | "apple";

export type WebOAuthErrorKind = "cancelled" | "failed";
export type OAuthPlatformFlow = "native" | "web";

export const DEFAULT_AUTH_RETURN_PATH = "/plan";

const ALLOWED_AUTH_RETURN_PATHS = new Set(["/plan", "/routes", "/settings", "/pricing"]);
const ALLOWED_PRODUCTION_HOSTS = new Set([
  "goscenik.com",
  "www.goscenik.com",
  "scenik-weld.vercel.app",
]);

type WebOAuthClient = {
  signInWithOAuth(input: {
    provider: WebOAuthProvider;
    options: { redirectTo: string };
  }): PromiseLike<{ error: Error | null }>;
};

type WebSessionResult = {
  data: { session: unknown | null };
  error: unknown | null;
};

export function webSessionOutcome(
  result: WebSessionResult,
): "authenticated" | "missing" | "failed" {
  if (result.error) return "failed";
  return result.data.session ? "authenticated" : "missing";
}

type WebSessionClient = {
  getSession(): Promise<WebSessionResult>;
  onAuthStateChange(callback: (event: unknown, session: unknown | null) => void): {
    data: { subscription: { unsubscribe(): void } };
  };
};

export function selectOAuthPlatformFlow(nativeAvailable: boolean): OAuthPlatformFlow {
  return nativeAvailable ? "native" : "web";
}

export function safeAuthReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return DEFAULT_AUTH_RETURN_PATH;
  }
  try {
    const url = new URL(value, "https://goscenik.com");
    if (url.origin !== "https://goscenik.com" || url.search || url.hash) {
      return DEFAULT_AUTH_RETURN_PATH;
    }
    return ALLOWED_AUTH_RETURN_PATHS.has(url.pathname) ? url.pathname : DEFAULT_AUTH_RETURN_PATH;
  } catch {
    return DEFAULT_AUTH_RETURN_PATH;
  }
}

export function safeWebAuthOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && ALLOWED_PRODUCTION_HOSTS.has(url.hostname)) {
      return url.origin;
    }
    if (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.port === "8080"
    ) {
      return url.origin;
    }
  } catch {
    // Fall through to the canonical public origin.
  }
  return "https://goscenik.com";
}

export function webOAuthRedirectUrl(origin: string, intendedReturnPath?: unknown): string {
  return `${safeWebAuthOrigin(origin)}${safeAuthReturnPath(intendedReturnPath)}`;
}

export async function startWebOAuth(input: {
  auth: WebOAuthClient;
  provider: WebOAuthProvider;
  origin: string;
  intendedReturnPath?: unknown;
}): Promise<{ error: Error | null }> {
  return input.auth.signInWithOAuth({
    provider: input.provider,
    options: {
      redirectTo: webOAuthRedirectUrl(input.origin, input.intendedReturnPath),
    },
  });
}

export function classifyOAuthReturnError(search: string): WebOAuthErrorKind | null {
  const params = new URLSearchParams(search);
  const error = params.get("error");
  if (!error) return null;
  const description = params.get("error_description") ?? "";
  return error === "access_denied" || /cancel(?:led|ed)|denied/i.test(description)
    ? "cancelled"
    : "failed";
}

export function webOAuthErrorMessage(kind: WebOAuthErrorKind | undefined): string | null {
  if (kind === "cancelled") {
    return "Sign-in was cancelled. You can try again when you're ready.";
  }
  if (kind === "failed") return "We couldn't complete sign-in. Please try again.";
  return null;
}

export async function restoreWebOAuthSession(
  auth: WebSessionClient,
  timeoutMs: number,
): Promise<WebSessionResult> {
  const initial = await auth.getSession();
  if (initial.error || initial.data.session) return initial;

  return new Promise<WebSessionResult>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined = undefined;
    const finish = (result: WebSessionResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      subscription.unsubscribe();
      resolve(result);
    };
    const {
      data: { subscription },
    } = auth.onAuthStateChange((_event, session) => {
      if (session) finish({ data: { session }, error: null });
    });
    timeout = setTimeout(() => {
      void auth
        .getSession()
        .then(finish, () => finish({ data: { session: null }, error: "AUTH_SESSION_FAILED" }));
    }, timeoutMs);
  });
}
