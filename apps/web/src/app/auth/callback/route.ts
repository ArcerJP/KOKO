import { NextResponse } from "next/server";
import { isGoogleOnlySession } from "../../../auth/google-session";
import { createServerAuthClient } from "../../../auth/server";
import { apiSessionOrigin } from "../../../auth/api-session-request";
import {
  createApiGeneration,
  setApiGeneration,
} from "../../../auth/api-session-cookies";

function noStoreRedirect(path: string, request: Request) {
  const response = NextResponse.redirect(new URL(path, request.url), 303);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code");
  if (!code) return noStoreRedirect("/login?error=auth", request);
  const apiEnabled = process.env.KOKO_API_COOKIE_ENABLED === "true";
  if (apiEnabled && apiSessionOrigin() !== new URL(request.url).origin)
    return noStoreRedirect("/login?error=auth", request);

  try {
    const supabase = await createServerAuthClient(
      apiEnabled ? { requireCookieWrites: true } : {},
    );
    if (!supabase) return noStoreRedirect("/login?error=auth", request);

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return noStoreRedirect("/login?error=auth", request);

    const { data, error: claimsError } = await supabase.auth.getClaims();
    if (claimsError || !data?.claims || !isGoogleOnlySession(data.claims)) {
      await supabase.auth.signOut({ scope: "local" });
      return noStoreRedirect("/login?error=auth", request);
    }
    const response = noStoreRedirect("/account", request);
    if (!apiEnabled) return response;
    const generation = await createApiGeneration(data.claims);
    return generation
      ? setApiGeneration(response, generation)
      : noStoreRedirect("/login?error=auth", request);
  } catch {
    return noStoreRedirect("/login?error=auth", request);
  }
}
