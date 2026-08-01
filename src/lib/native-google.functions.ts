import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { exchangeVerifiedNativeGoogleToken } from "./native-google.server";

/**
 * Verifies a native Google ID token whose audience is the iOS client, then returns
 * a one-time magic-link token the client exchanges for a real session.
 */
export const exchangeNativeGoogleToken = createServerFn({ method: "POST" })
  .inputValidator((data) => z.object({ idToken: z.string().min(20) }).parse(data))
  .handler(async ({ data }) => exchangeVerifiedNativeGoogleToken(data.idToken));
