import { describe, expect, mock, test } from "bun:test";
import { canonicalVerifiedUserId } from "@/lib/verified-user-id.server";
import { authenticateSupabaseRequest, executeSupabaseAuthMiddleware } from "./auth-boundary.server";

const VERIFIED_USER = "11111111-1111-4111-8111-111111111111";

function request(token?: string): Pick<Request, "headers"> {
  return { headers: new Headers(token === undefined ? {} : { authorization: `Bearer ${token}` }) };
}

function requestWithAuthorization(authorization?: string): Pick<Request, "headers"> {
  return { headers: new Headers(authorization === undefined ? {} : { authorization }) };
}

describe("Supabase bearer authentication boundary", () => {
  test("rejects missing bearer authentication before constructing a claims client", async () => {
    let clientsCreated = 0;
    await expect(
      authenticateSupabaseRequest({
        request: request(),
        createClaimsClient: () => {
          clientsCreated += 1;
          throw new Error("must not execute");
        },
      }),
    ).rejects.toThrow("Unauthorized: No authorization header provided");
    expect(clientsCreated).toBe(0);
  });

  test("rejects invalid tokens before returning verified context", async () => {
    let claimsChecks = 0;
    await expect(
      authenticateSupabaseRequest({
        request: request("invalid-token"),
        createClaimsClient: () => ({
          auth: {
            getClaims: async () => {
              claimsChecks += 1;
              return { data: null, error: { code: "invalid_token" } };
            },
          },
        }),
      }),
    ).rejects.toThrow("Unauthorized: Invalid token");
    expect(claimsChecks).toBe(1);
  });

  test("returns only the cryptographically verified claims identity", async () => {
    const verified = await authenticateSupabaseRequest({
      request: request("verified-token"),
      createClaimsClient: () => ({
        auth: {
          getClaims: async () => ({
            data: { claims: { sub: VERIFIED_USER, is_anonymous: true } },
            error: null,
          }),
        },
      }),
    });
    expect(verified.userId).toBe(VERIFIED_USER);
    expect(verified.claims).toEqual({ sub: VERIFIED_USER, is_anonymous: true });
  });

  test("rejects every malformed verified subject with one stable failure", async () => {
    const malformedSubjects: Array<{ label: string; claims: Record<string, unknown> }> = [
      { label: "missing", claims: {} },
      { label: "null", claims: { sub: null } },
      { label: "undefined", claims: { sub: undefined } },
      { label: "empty", claims: { sub: "" } },
      { label: "whitespace", claims: { sub: "   " } },
      { label: "text", claims: { sub: "not-a-uuid" } },
      { label: "missing characters", claims: { sub: "11111111-1111-4111-8111-11111111111" } },
      { label: "prefix", claims: { sub: `x${VERIFIED_USER}` } },
      { label: "suffix", claims: { sub: `${VERIFIED_USER}x` } },
      { label: "braces", claims: { sub: `{${VERIFIED_USER}}` } },
      { label: "non-hex", claims: { sub: "11111111-1111-4111-8111-11111111111g" } },
    ];
    const logged: unknown[] = [];
    const originalError = console.error;
    console.error = mock((...values: unknown[]) => logged.push(values));
    try {
      for (const fixture of malformedSubjects) {
        await expect(
          authenticateSupabaseRequest({
            request: request("verified-token"),
            createClaimsClient: () => ({
              auth: {
                getClaims: async () => ({ data: { claims: fixture.claims }, error: null }),
              },
            }),
          }),
        ).rejects.toThrow("Unauthorized: Invalid authenticated identity");
      }
    } finally {
      console.error = originalError;
    }
    expect(logged).toEqual([]);
  });

  test("accepts canonical UUID syntax and returns lowercase canonical identity", () => {
    const uppercase = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
    expect(canonicalVerifiedUserId(VERIFIED_USER)).toBe(VERIFIED_USER);
    expect(canonicalVerifiedUserId(uppercase)).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(canonicalVerifiedUserId("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });
});

describe("executable Supabase authentication middleware seam", () => {
  function harness(input: {
    authorization?: string;
    claimsResult?: {
      data: { claims?: Record<string, unknown> } | null;
      error: unknown | null;
    };
  }) {
    const calls = {
      clients: 0,
      claims: 0,
      handler: 0,
      meteringRead: 0,
      provider: 0,
      meteringInsert: 0,
    };
    const rawProviderError = { message: "private Supabase token detail" };
    const execute = () =>
      executeSupabaseAuthMiddleware({
        request: requestWithAuthorization(input.authorization),
        createClaimsClient: () => {
          calls.clients += 1;
          return {
            auth: {
              getClaims: async () => {
                calls.claims += 1;
                return (
                  input.claimsResult ?? {
                    data: null,
                    error: rawProviderError,
                  }
                );
              },
            },
          };
        },
        next: async ({ userId }) => {
          calls.handler += 1;
          calls.meteringRead += 1;
          calls.provider += 1;
          calls.meteringInsert += 1;
          return { userId };
        },
      });
    return { calls, execute, rawProviderError };
  }

  test("missing authorization rejects before claims or protected work", async () => {
    const run = harness({});
    await expect(run.execute()).rejects.toThrow("Unauthorized: No authorization header provided");
    expect(run.calls).toEqual({
      clients: 0,
      claims: 0,
      handler: 0,
      meteringRead: 0,
      provider: 0,
      meteringInsert: 0,
    });
  });

  test("malformed authorization schemes and empty tokens reject before protected work", async () => {
    for (const authorization of ["Bearer ", "Bearer    ", "Basic private", "Token private"]) {
      const run = harness({ authorization });
      await expect(run.execute()).rejects.toThrow(/^Unauthorized:/);
      expect(run.calls.handler).toBe(0);
      expect(run.calls.meteringRead).toBe(0);
      expect(run.calls.provider).toBe(0);
      expect(run.calls.meteringInsert).toBe(0);
    }
  });

  test("invalid bearer reaches getClaims but never protected work or raw errors", async () => {
    const run = harness({ authorization: "Bearer invalid-token" });
    let caught: unknown;
    try {
      await run.execute();
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(new Error("Unauthorized: Invalid token"));
    expect(JSON.stringify(caught)).not.toContain(run.rawProviderError.message);
    expect(run.calls).toEqual({
      clients: 1,
      claims: 1,
      handler: 0,
      meteringRead: 0,
      provider: 0,
      meteringInsert: 0,
    });
  });

  test("malformed verified subject never reaches protected work", async () => {
    const run = harness({
      authorization: "Bearer verified-token",
      claimsResult: { data: { claims: { sub: "not-a-uuid" } }, error: null },
    });
    await expect(run.execute()).rejects.toThrow("Unauthorized: Invalid authenticated identity");
    expect(run.calls).toEqual({
      clients: 1,
      claims: 1,
      handler: 0,
      meteringRead: 0,
      provider: 0,
      meteringInsert: 0,
    });
  });

  test("valid bearer invokes the protected handler once with canonical identity", async () => {
    const run = harness({
      authorization: "Bearer verified-token",
      claimsResult: {
        data: { claims: { sub: VERIFIED_USER.toUpperCase() } },
        error: null,
      },
    });
    expect(await run.execute()).toEqual({ userId: VERIFIED_USER });
    expect(run.calls).toEqual({
      clients: 1,
      claims: 1,
      handler: 1,
      meteringRead: 1,
      provider: 1,
      meteringInsert: 1,
    });
  });
});
