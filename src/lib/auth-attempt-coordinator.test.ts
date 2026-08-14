import { describe, expect, test } from "bun:test";
import {
  createAuthenticationAttemptCoordinator,
  executeEmailAuthentication,
  executeGuestAuthentication,
  executeSocialAuthentication,
  type AuthenticationMethod,
} from "./auth-attempt-coordinator";
import { authFailureMessage, classifyAuthFailure } from "./auth-hardening";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("authentication attempt coordinator", () => {
  test("executes the actual native Apple and Google branch instead of web OAuth", async () => {
    for (const provider of ["apple", "google"] as const) {
      const calls: string[] = [];
      const result = await executeSocialAuthentication({
        provider,
        nativeAvailable: true,
        nativeSignIn: async (selected) => {
          calls.push(`native:${selected}`);
          return { session: "verified" };
        },
        startWebOAuth: async () => {
          calls.push("web");
          return { error: null };
        },
      });
      expect(result).toEqual({ flow: "native", result: { session: "verified" } });
      expect(calls).toEqual([`native:${provider}`]);
    }
  });

  test("coordinates native success, cancellation and unknown failure without raw output", async () => {
    for (const provider of ["apple", "google"] as const) {
      const navigation: string[] = [];
      const safeOutput: unknown[] = [];
      const coordinator = createAuthenticationAttemptCoordinator({
        isMounted: () => true,
        setLoading: () => {},
      });
      const success = await coordinator.run({
        method: provider,
        execute: () =>
          executeSocialAuthentication({
            provider,
            nativeAvailable: true,
            nativeSignIn: async () => ({ session: "verified" }),
            startWebOAuth: async () => {
              throw new Error("web must not execute");
            },
          }),
        onSuccess: async () => {
          navigation.push("/plan");
        },
      });
      expect(success.status).toBe("succeeded");
      expect(navigation).toEqual(["/plan"]);

      for (const error of [
        { code: "USER_CANCELLED", message: "identityToken=private" },
        { code: "UNKNOWN", message: "nonce=private sdkPayload=private" },
      ]) {
        const result = await coordinator.run({
          method: provider,
          execute: () =>
            executeSocialAuthentication({
              provider,
              nativeAvailable: true,
              nativeSignIn: async () => Promise.reject(error),
              startWebOAuth: async () => {
                throw new Error("web must not execute");
              },
            }),
          onFailure: (caught) => {
            const classification = classifyAuthFailure({
              error: caught,
              stage: "provider",
              nativeProvider: provider,
            });
            safeOutput.push({ classification, message: authFailureMessage(classification) });
          },
        });
        expect(result.status).toBe("failed");
        expect(coordinator.active()).toBe(false);
      }
      expect(navigation).toEqual(["/plan"]);
      expect(safeOutput).toEqual([
        { classification: "AUTH_CANCELLED", message: "Sign-in was cancelled." },
        {
          classification: "AUTH_PROVIDER_FAILED",
          message: "We couldn’t start sign-in. Please try again.",
        },
      ]);
      expect(JSON.stringify(safeOutput)).not.toContain("private");
    }
  });

  test("blocks every same-frame cross-method combination through the real coordinator", async () => {
    const combinations: [AuthenticationMethod, AuthenticationMethod][] = [
      ["apple", "apple"],
      ["google", "google"],
      ["apple", "google"],
      ["apple", "email"],
      ["apple", "guest"],
      ["email", "apple"],
      ["guest", "apple"],
      ["email", "guest"],
    ];
    for (const [first, second] of combinations) {
      const pending = deferred<void>();
      const calls: string[] = [];
      const coordinator = createAuthenticationAttemptCoordinator({
        isMounted: () => true,
        setLoading: () => {},
      });
      const firstAttempt = coordinator.run({
        method: first,
        execute: async () => {
          calls.push(first);
          return pending.promise;
        },
      });
      const secondResult = await coordinator.run({
        method: second,
        execute: async () => {
          calls.push(second);
        },
      });
      expect(secondResult).toEqual({ status: "blocked" });
      expect(calls).toEqual([first]);
      pending.resolve();
      await firstAttempt;
    }
  });

  test("releases after cancellation or failure and retains successful web handoff", async () => {
    const loading: boolean[] = [];
    const coordinator = createAuthenticationAttemptCoordinator({
      isMounted: () => true,
      setLoading: (value) => loading.push(value),
    });
    const cancellation = { code: "USER_CANCELLED", message: "private" };
    expect(
      await coordinator.run({ method: "apple", execute: async () => Promise.reject(cancellation) }),
    ).toEqual({ status: "failed", error: cancellation });
    expect(coordinator.active()).toBe(false);
    expect(await coordinator.run({ method: "google", execute: async () => "retry" })).toEqual({
      status: "succeeded",
      value: "retry",
    });

    await coordinator.run({
      method: "apple",
      execute: async () => "redirected",
      retainLockOnSuccess: true,
    });
    expect(coordinator.active()).toBe(true);
    expect(await coordinator.run({ method: "email", execute: async () => "blocked" })).toEqual({
      status: "blocked",
    });
    expect(loading).toEqual([true, false, true, false, true]);
  });

  test("never updates React state when provider, email or guest settles after unmount", async () => {
    for (const method of ["apple", "email", "guest"] as const) {
      let mounted = true;
      const updates: boolean[] = [];
      const pending = deferred<void>();
      const coordinator = createAuthenticationAttemptCoordinator({
        isMounted: () => mounted,
        setLoading: (value) => updates.push(value),
      });
      const attempt = coordinator.run({ method, execute: () => pending.promise });
      mounted = false;
      pending.reject(new Error("private failure"));
      await attempt;
      expect(updates).toEqual([true]);
      expect(coordinator.active()).toBe(false);
    }
  });

  test("executes the email sign-in, sign-up and guest boundaries used by AuthPage", async () => {
    const calls: unknown[] = [];
    const auth = {
      signInWithPassword: async (credentials: { email: string; password: string }) => {
        calls.push(["signin", credentials]);
        return { error: null };
      },
      signUp: async (credentials: {
        email: string;
        password: string;
        options: { emailRedirectTo: string };
      }) => {
        calls.push(["signup", credentials]);
        return { error: null };
      },
      signInAnonymously: async () => {
        calls.push(["guest"]);
        return { error: null };
      },
    };
    expect(
      await executeEmailAuthentication({
        auth,
        mode: "signin",
        email: "person@example.test",
        password: "private-password",
        emailRedirectTo: "https://www.goscenik.com/auth",
      }),
    ).toBe("signin");
    expect(
      await executeEmailAuthentication({
        auth,
        mode: "signup",
        email: "person@example.test",
        password: "private-password",
        emailRedirectTo: "https://www.goscenik.com/auth",
      }),
    ).toBe("signup");
    await executeGuestAuthentication(auth);
    expect(calls.map((call) => (call as unknown[])[0])).toEqual(["signin", "signup", "guest"]);
  });

  test("propagates email and guest failures only to the coordinator's sanitized boundary", async () => {
    const privateError = { code: "unknown", message: "token=private email=private" };
    await expect(
      executeEmailAuthentication({
        auth: {
          signInWithPassword: async () => ({ error: privateError }),
          signUp: async () => ({ error: null }),
        },
        mode: "signin",
        email: "person@example.test",
        password: "private-password",
        emailRedirectTo: "https://www.goscenik.com/auth",
      }),
    ).rejects.toBe(privateError);
    await expect(
      executeGuestAuthentication({ signInAnonymously: async () => ({ error: privateError }) }),
    ).rejects.toBe(privateError);
  });
});
