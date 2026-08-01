const ACCEPTED_AUDIENCES = new Set([
  "73348351531-l5er4eus0q5m1t4ec7tkqv7qfeipdeul.apps.googleusercontent.com",
  "73348351531-qj6e64trsm9cedvsfftkdum71qbp63bh.apps.googleusercontent.com",
]);

type GoogleTokenInfo = {
  aud?: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
  picture?: string;
  iss?: string;
  exp?: string;
};

export async function exchangeVerifiedNativeGoogleToken(idToken: string) {
  console.log("[Auth] bridge request reached server: true");
  let verificationSucceeded = false;
  let magicLinkReturned = false;

  try {
    const response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
    );
    if (!response.ok) throw new Error("Google rejected the identity token");

    const info = (await response.json()) as GoogleTokenInfo;
    const issuer = info.iss ?? "";
    if (issuer !== "accounts.google.com" && issuer !== "https://accounts.google.com") {
      throw new Error("Unexpected identity token issuer");
    }
    if (!info.aud || !ACCEPTED_AUDIENCES.has(info.aud)) {
      throw new Error(`Unacceptable audience in id_token: ${info.aud ?? "none"}`);
    }
    if (info.exp && Number(info.exp) * 1000 < Date.now()) {
      throw new Error("Identity token has expired");
    }

    const email = info.email;
    const verifiedEmail = info.email_verified === true || info.email_verified === "true";
    if (!email || !verifiedEmail) throw new Error("Google account has no verified email");

    verificationSucceeded = true;
    console.log("[Auth] Google token verification succeeded: true");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let link = await supabaseAdmin.auth.admin.generateLink({ type: "magiclink", email });

    if (link.error || !link.data?.properties?.hashed_token) {
      if (!link.error || !/not found|does not exist/i.test(link.error.message)) {
        throw link.error ?? new Error("Could not start session");
      }

      const { error: createError } = await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: {
          full_name: info.name,
          avatar_url: info.picture,
          provider: "google",
        },
      });
      if (createError) throw createError;
      link = await supabaseAdmin.auth.admin.generateLink({ type: "magiclink", email });
    }

    const tokenHash = link.data?.properties?.hashed_token;
    if (link.error || !tokenHash) throw link.error ?? new Error("Could not start session");

    magicLinkReturned = true;
    console.log("[Auth] magic-link token returned: true");
    return { tokenHash, verificationSucceeded, magicLinkReturned };
  } catch (error) {
    console.log("[Auth] Google token verification succeeded:", verificationSucceeded);
    console.log("[Auth] magic-link token returned:", magicLinkReturned);
    console.log("[Auth] final error:", error instanceof Error ? error.message : "Native Google bridge failed");
    throw error;
  }
}