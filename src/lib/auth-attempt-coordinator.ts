export type AuthenticationMethod = "apple" | "google" | "email" | "guest";

export type AuthenticationAttemptResult<T> =
  | { status: "blocked" }
  | { status: "succeeded"; value: T }
  | { status: "failed"; error: unknown };

export function createAuthenticationAttemptCoordinator(input: {
  isMounted(): boolean;
  setLoading(loading: boolean): void;
}) {
  let inFlight = false;
  return {
    active: () => inFlight,
    release: () => {
      inFlight = false;
    },
    async run<T>(attempt: {
      method: AuthenticationMethod;
      execute(): Promise<T>;
      onSuccess?(value: T): void | Promise<void>;
      onFailure?(error: unknown): void | Promise<void>;
      retainLockOnSuccess?: boolean;
    }): Promise<AuthenticationAttemptResult<T>> {
      if (inFlight) return { status: "blocked" };
      inFlight = true;
      if (input.isMounted()) input.setLoading(true);
      let succeeded = false;
      try {
        const value = await attempt.execute();
        succeeded = true;
        if (input.isMounted()) await attempt.onSuccess?.(value);
        return { status: "succeeded", value };
      } catch (error) {
        if (input.isMounted()) await attempt.onFailure?.(error);
        return { status: "failed", error };
      } finally {
        if (!succeeded || !attempt.retainLockOnSuccess) inFlight = false;
        if (input.isMounted() && (!succeeded || !attempt.retainLockOnSuccess)) {
          input.setLoading(false);
        }
      }
    },
  };
}

export async function executeSocialAuthentication<TNative>(input: {
  provider: "apple" | "google";
  nativeAvailable: boolean;
  nativeSignIn(provider: "apple" | "google"): Promise<TNative>;
  startWebOAuth(provider: "apple" | "google"): Promise<{ error: Error | null }>;
}): Promise<{ flow: "native"; result: TNative } | { flow: "web" }> {
  if (input.nativeAvailable) {
    return { flow: "native", result: await input.nativeSignIn(input.provider) };
  }
  const { error } = await input.startWebOAuth(input.provider);
  if (error) throw error;
  return { flow: "web" };
}

type EmailAuthClient = {
  signInWithPassword(credentials: { email: string; password: string }): Promise<{
    error: unknown | null;
  }>;
  signUp(credentials: {
    email: string;
    password: string;
    options: { emailRedirectTo: string };
  }): Promise<{ error: unknown | null }>;
};

export async function executeEmailAuthentication(input: {
  auth: EmailAuthClient;
  mode: "signin" | "signup";
  email: string;
  password: string;
  emailRedirectTo: string;
}): Promise<"signin" | "signup"> {
  const { error } =
    input.mode === "signup"
      ? await input.auth.signUp({
          email: input.email,
          password: input.password,
          options: { emailRedirectTo: input.emailRedirectTo },
        })
      : await input.auth.signInWithPassword({ email: input.email, password: input.password });
  if (error) throw error;
  return input.mode;
}

export async function executeGuestAuthentication(auth: {
  signInAnonymously(): Promise<{ error: unknown | null }>;
}): Promise<void> {
  const { error } = await auth.signInAnonymously();
  if (error) throw error;
}
