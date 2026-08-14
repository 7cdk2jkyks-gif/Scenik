import { describe, expect, test } from "bun:test";
import {
  FREE_ROUTE_GENERATION_LIMIT,
  RouteGenerationMeteringError,
  currentCalendarMonthStart,
  enforceRouteGenerationAllowance,
  readRouteGenerationUsage,
  recordRouteGeneration,
} from "./route-generation-metering.server";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

function meteringClient(input?: {
  count?: number | null;
  readError?: boolean;
  insertError?: boolean;
}) {
  const observations = {
    table: "",
    readUserId: "",
    insertedRow: undefined as { user_id: string } | undefined,
    monthStart: "",
  };
  const client = {
    from(table: "route_generations") {
      observations.table = table;
      return {
        select() {
          return {
            eq(_column: "user_id", userId: string) {
              observations.readUserId = userId;
              return {
                async gte(_createdAt: "created_at", monthStart: string) {
                  observations.monthStart = monthStart;
                  return {
                    count: input?.count ?? 0,
                    error: input?.readError ? { code: "42501" } : null,
                  };
                },
              };
            },
          };
        },
        async insert(row: { user_id: string }) {
          observations.insertedRow = row;
          return { error: input?.insertError ? { code: "42501" } : null };
        },
      };
    },
  };
  return { client, observations };
}

describe("route generation metering", () => {
  test("preserves the three-route calendar-month allowance", () => {
    expect(FREE_ROUTE_GENERATION_LIMIT).toBe(3);
    expect(currentCalendarMonthStart(new Date("2026-08-13T12:34:56Z")).toISOString()).toBe(
      "2026-08-01T00:00:00.000Z",
    );
  });

  test("allows free users below the limit and rejects them at the limit", () => {
    expect(() =>
      enforceRouteGenerationAllowance({
        usedThisMonth: 2,
        isPremium: false,
        internalTester: false,
      }),
    ).not.toThrow();
    expect(() =>
      enforceRouteGenerationAllowance({
        usedThisMonth: 3,
        isPremium: false,
        internalTester: false,
      }),
    ).toThrow("FREE_LIMIT_REACHED:3");
  });

  test("preserves premium and authorised internal-tester bypasses", () => {
    expect(() =>
      enforceRouteGenerationAllowance({
        usedThisMonth: 99,
        isPremium: true,
        internalTester: false,
      }),
    ).not.toThrow();
    expect(() =>
      enforceRouteGenerationAllowance({
        usedThisMonth: 99,
        isPremium: false,
        internalTester: true,
      }),
    ).not.toThrow();
  });

  test("reads and meters an authenticated guest or registered user by verified ID", async () => {
    for (const verifiedUserId of [USER_A, USER_B]) {
      const { client, observations } = meteringClient({ count: 2 });
      expect(await readRouteGenerationUsage({ client, verifiedUserId })).toBe(2);
      await recordRouteGeneration({ client, verifiedUserId });
      expect(observations.table).toBe("route_generations");
      expect(observations.readUserId).toBe(verifiedUserId);
      expect(observations.insertedRow).toEqual({ user_id: verifiedUserId });
      expect(Object.keys(observations.insertedRow ?? {})).toEqual(["user_id"]);
    }
  });

  test("keeps each user's read and insert isolated", async () => {
    const { client, observations } = meteringClient({ count: 1 });
    await readRouteGenerationUsage({ client, verifiedUserId: USER_A });
    await recordRouteGeneration({ client, verifiedUserId: USER_A });
    expect(observations.readUserId).not.toBe(USER_B);
    expect(observations.insertedRow?.user_id).not.toBe(USER_B);
  });

  test("rejects unverified or client-shaped user IDs before database access", async () => {
    const { client, observations } = meteringClient();
    await expect(
      readRouteGenerationUsage({ client, verifiedUserId: "client-supplied-user" }),
    ).rejects.toMatchObject({ code: "ROUTE_GENERATION_METERING_READ_FAILED" });
    expect(observations.table).toBe("");
  });

  test("fails closed on metering reads", async () => {
    const { client } = meteringClient({ readError: true });
    await expect(readRouteGenerationUsage({ client, verifiedUserId: USER_A })).rejects.toEqual(
      new RouteGenerationMeteringError("ROUTE_GENERATION_METERING_READ_FAILED"),
    );
  });

  test("fails closed on metering inserts without exposing raw RLS details", async () => {
    const { client } = meteringClient({ insertError: true });
    await expect(recordRouteGeneration({ client, verifiedUserId: USER_A })).rejects.toEqual(
      new RouteGenerationMeteringError("ROUTE_GENERATION_METERING_INSERT_FAILED"),
    );
  });

  test("contains no service-role credential or generic table capability", () => {
    expect(readRouteGenerationUsage.toString()).not.toContain("SERVICE_ROLE_KEY");
    expect(recordRouteGeneration.toString()).not.toContain("SERVICE_ROLE_KEY");
  });
});
