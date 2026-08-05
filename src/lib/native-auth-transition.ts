import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

let nativeAuthJustCompleted = false;

export type NativeAuthResult = {
  requestId: string;
  session: Session;
};

export function markNativeAuthCompleted(): void {
  nativeAuthJustCompleted = true;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("scenik:native-auth-completed"));
  }
}

export function consumeNativeAuthCompleted(): boolean {
  const completed = nativeAuthJustCompleted;
  nativeAuthJustCompleted = false;
  return completed;
}

/**
 * Capacitor can resume before Supabase has finished restoring persisted auth.
 * Check immediately, listen for a short restoration window, then perform one
 * final authoritative check. This always resolves within a bounded time.
 */
export async function restoreNativeSession(label: string, waitMs = 2_000): Promise<Session | null> {
  const boundedGetSession = async (): Promise<Session | null> => {
    try {
      const result = await Promise.race([
        supabase.auth.getSession().then(({ data }) => data.session),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), waitMs)),
      ]);
      return result;
    } catch {
      return null;
    }
  };

  console.log(`[Auth] ${label}: initial session check started`);
  const initial = await boundedGetSession();
  if (initial) {
    console.log(`[Auth] ${label}: session restored on initial check`);
    return initial;
  }

  const restoredFromEvent = await new Promise<Session | null>((resolve) => {
    let finished = false;
    const finish = (session: Session | null) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      subscription.subscription.unsubscribe();
      resolve(session);
    };
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) queueMicrotask(() => finish(session));
    });
    const timer = window.setTimeout(() => finish(null), waitMs);
  });
  if (restoredFromEvent) {
    console.log(`[Auth] ${label}: session restored from auth event`);
    return restoredFromEvent;
  }

  const final = await boundedGetSession();
  console.log(`[Auth] ${label}: bounded restore completed (session: ${final ? "yes" : "no"})`);
  return final;
}
