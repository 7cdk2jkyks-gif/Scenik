import { describe, expect, test } from "bun:test";
import { RouteGenerationMeteringError } from "./route-generation-metering.server";
import { executeRouteGenerationOrchestration } from "./route-generation-orchestration.server";

const GUEST = "11111111-1111-4111-8111-111111111111";
const REGISTERED = "22222222-2222-4222-8222-222222222222";

function scenario(input?: {
  used?: number;
  premium?: boolean;
  internalTester?: boolean;
  readFailure?: boolean;
  insertFailure?: boolean;
}) {
  const calls: string[] = [];
  const route = {
    title: "Completed route",
    directions: { encodedPolyline: "private-route-geometry" },
    providerResponse: "private-provider-response",
  };
  return {
    calls,
    route,
    execute: (verifiedUserId: string) =>
      executeRouteGenerationOrchestration({
        verifiedUserId,
        internalTester: input?.internalTester ?? false,
        readPremium: async () => {
          calls.push("premium");
          return input?.premium ?? false;
        },
        dependencies: {
          readUsage: async (userId) => {
            calls.push(`read:${userId}`);
            if (input?.readFailure) {
              throw new RouteGenerationMeteringError("ROUTE_GENERATION_METERING_READ_FAILED");
            }
            return input?.used ?? 0;
          },
          generateRoute: async () => {
            calls.push("provider");
            return route;
          },
          recordUsage: async (userId) => {
            calls.push(`insert:${userId}`);
            if (input?.insertFailure) {
              throw new RouteGenerationMeteringError("ROUTE_GENERATION_METERING_INSERT_FAILED");
            }
          },
        },
      }),
  };
}

describe("executable route-generation metering orchestration", () => {
  test("passes guest and registered verified identities unchanged", async () => {
    for (const verifiedUserId of [GUEST, REGISTERED]) {
      const run = scenario();
      expect(await run.execute(verifiedUserId)).toBe(run.route);
      expect(run.calls).toEqual([
        `read:${verifiedUserId}`,
        "premium",
        "provider",
        `insert:${verifiedUserId}`,
      ]);
    }
  });

  test("ignores top-level and nested request-supplied identity fields", async () => {
    const run = scenario();
    const attacker = "99999999-9999-4999-8999-999999999999";
    const result = await executeRouteGenerationOrchestration({
      verifiedUserId: GUEST,
      internalTester: false,
      user_id: attacker,
      request: { user_id: attacker },
      readPremium: async () => false,
      dependencies: {
        readUsage: async (userId) => {
          run.calls.push(`read:${userId}`);
          return 0;
        },
        generateRoute: async () => run.route,
        recordUsage: async (userId) => {
          run.calls.push(`insert:${userId}`);
        },
      },
    } as Parameters<typeof executeRouteGenerationOrchestration<typeof run.route>>[0] & {
      user_id: string;
      request: { user_id: string };
    });
    expect(result).toBe(run.route);
    expect(run.calls).toEqual([`read:${GUEST}`, `insert:${GUEST}`]);
    expect(run.calls.join(" ")).not.toContain(attacker);
  });

  test("prevents provider work after read failure or allowance exhaustion", async () => {
    const readFailure = scenario({ readFailure: true });
    await expect(readFailure.execute(GUEST)).rejects.toMatchObject({
      code: "ROUTE_GENERATION_METERING_READ_FAILED",
    });
    expect(readFailure.calls).toEqual([`read:${GUEST}`, "premium"]);

    const exhausted = scenario({ used: 3 });
    await expect(exhausted.execute(GUEST)).rejects.toThrow("FREE_LIMIT_REACHED:3");
    expect(exhausted.calls).toEqual([`read:${GUEST}`, "premium"]);
  });

  test("withholds the actual completed response when final insertion fails", async () => {
    const run = scenario({ insertFailure: true });
    let response: unknown;
    try {
      response = await run.execute(GUEST);
    } catch (error) {
      expect(error).toEqual(
        new RouteGenerationMeteringError("ROUTE_GENERATION_METERING_INSERT_FAILED"),
      );
      expect(JSON.stringify(error)).not.toContain("private-route-geometry");
      expect(JSON.stringify(error)).not.toContain("private-provider-response");
      expect(JSON.stringify(error)).not.toContain("database");
    }
    expect(response).toBeUndefined();
    expect(run.calls).toEqual([`read:${GUEST}`, "premium", "provider", `insert:${GUEST}`]);
  });

  test("preserves premium and internal-tester allowance bypasses", async () => {
    for (const config of [{ premium: true }, { internalTester: true }]) {
      const run = scenario({ used: 99, ...config });
      expect(await run.execute(REGISTERED)).toBe(run.route);
      expect(run.calls).toContain("provider");
      expect(run.calls.at(-1)).toBe(`insert:${REGISTERED}`);
    }
  });
});
