import { createClient } from "@supabase/supabase-js";
import { canonicalVerifiedUserId } from "@/lib/verified-user-id.server";
import type { Database } from "./types";

type VerifiedClaims = { sub?: unknown; [key: string]: unknown };

type ClaimsClient = {
  auth: {
    getClaims(token: string): Promise<{
      data: { claims?: VerifiedClaims } | null;
      error: unknown | null;
    }>;
  };
};

export type VerifiedSupabaseRequest<TClient extends ClaimsClient = ClaimsClient> = {
  supabase: TClient;
  userId: string;
  claims: VerifiedClaims;
};

export async function authenticateSupabaseRequest<TClient extends ClaimsClient>(input: {
  request: Pick<Request, "headers"> | null | undefined;
  createClaimsClient: (token: string) => TClient;
}): Promise<VerifiedSupabaseRequest<TClient>> {
  if (!input.request?.headers) throw new Error("Unauthorized: No request headers available");
  const authHeader = input.request.headers.get("authorization");
  if (!authHeader) throw new Error("Unauthorized: No authorization header provided");
  if (!authHeader.startsWith("Bearer ")) {
    throw new Error("Unauthorized: Only Bearer tokens are supported");
  }
  const token = authHeader.slice("Bearer ".length);
  if (!token || !token.trim()) throw new Error("Unauthorized: No token provided");

  const supabase = input.createClaimsClient(token);
  const { data, error } = await supabase.auth.getClaims(token);
  if (error || !data?.claims) throw new Error("Unauthorized: Invalid token");
  const userId = canonicalVerifiedUserId(data.claims.sub);
  if (!userId) throw new Error("Unauthorized: Invalid authenticated identity");
  return { supabase, userId, claims: data.claims };
}

export async function executeSupabaseAuthMiddleware<TClient extends ClaimsClient, TResult>(input: {
  request: Pick<Request, "headers"> | null | undefined;
  createClaimsClient: (token: string) => TClient;
  next(context: VerifiedSupabaseRequest<TClient>): Promise<TResult> | TResult;
}): Promise<TResult> {
  const verified = await authenticateSupabaseRequest({
    request: input.request,
    createClaimsClient: input.createClaimsClient,
  });
  return input.next(verified);
}

function productionClaimsClientFactory() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) {
    throw new Error("Supabase authentication is unavailable");
  }
  return (token: string) =>
    createClient<Database>(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    });
}

export async function authenticateProductionSupabaseRequest(
  request: Pick<Request, "headers"> | null | undefined,
) {
  return authenticateSupabaseRequest({
    request,
    createClaimsClient: productionClaimsClientFactory(),
  });
}

export async function executeProductionSupabaseAuthMiddleware<TResult>(input: {
  request: Pick<Request, "headers"> | null | undefined;
  next(
    context: Awaited<ReturnType<typeof authenticateProductionSupabaseRequest>>,
  ): Promise<TResult> | TResult;
}): Promise<TResult> {
  return executeSupabaseAuthMiddleware({
    request: input.request,
    createClaimsClient: productionClaimsClientFactory(),
    next: input.next,
  });
}
