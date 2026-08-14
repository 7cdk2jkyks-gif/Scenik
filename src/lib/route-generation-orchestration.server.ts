import {
  enforceRouteGenerationAllowance,
  readServerRouteGenerationUsage,
  recordServerRouteGeneration,
} from "./route-generation-metering.server";

export type RouteGenerationOrchestrationDependencies = {
  readUsage(verifiedUserId: string): Promise<number>;
  generateRoute(input: { isPremium: boolean }): Promise<unknown>;
  recordUsage(verifiedUserId: string): Promise<void>;
};

export async function executeRouteGenerationOrchestration<T>(input: {
  verifiedUserId: string;
  internalTester: boolean;
  readPremium(): Promise<boolean>;
  dependencies: Omit<RouteGenerationOrchestrationDependencies, "generateRoute"> & {
    generateRoute(input: { isPremium: boolean }): Promise<T>;
  };
}): Promise<T> {
  const [usedThisMonth, isPremium] = await Promise.all([
    input.dependencies.readUsage(input.verifiedUserId),
    input.readPremium(),
  ]);
  enforceRouteGenerationAllowance({
    usedThisMonth,
    isPremium,
    internalTester: input.internalTester,
  });
  const completedRoute = await input.dependencies.generateRoute({ isPremium });
  await input.dependencies.recordUsage(input.verifiedUserId);
  return completedRoute;
}

export function executeProductionRouteGeneration<T>(input: {
  verifiedUserId: string;
  internalTester: boolean;
  readPremium(): Promise<boolean>;
  generateRoute(input: { isPremium: boolean }): Promise<T>;
}): Promise<T> {
  return executeRouteGenerationOrchestration({
    ...input,
    dependencies: {
      readUsage: readServerRouteGenerationUsage,
      generateRoute: input.generateRoute,
      recordUsage: recordServerRouteGeneration,
    },
  });
}
