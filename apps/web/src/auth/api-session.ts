import { isGoogleOnlySession } from "./google-session";
import { createServerAuthClient } from "./server";
import {
  apiCookieName,
  apiCookieOptions,
  apiGeneration,
  generationFingerprint,
  clearApiCookie as clear,
} from "./api-session-cookies";
import {
  sessionReply as reply,
  validateSessionRequest,
} from "./api-session-request";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Internal Web session bridge, not an event API or a Supabase sign-out route. */
export async function handleApiSession(request: Request): Promise<Response> {
  if (!["POST", "DELETE"].includes(request.method)) {
    const response = reply(405, "METHOD_NOT_ALLOWED");
    response.headers.set("Allow", "POST, DELETE");
    return response;
  }
  const rejected = await validateSessionRequest(request, "/auth/api-session");
  if (rejected) return rejected;

  // Only expires the API cookie; never claims to revoke the Supabase session.
  if (request.method === "DELETE") return clear(reply(200));

  const generation = apiGeneration(request.headers);
  if (!generation) return clear(reply(401, "AUTH_REQUIRED"));

  try {
    const supabase = await createServerAuthClient({
      requireCookieWrites: true,
    });
    if (!supabase) return clear(reply(503, "API_SESSION_UNAVAILABLE"));
    const { data, error } = await supabase.auth.getSession();
    // Storage-derived session.user / expires_at are not authorization evidence.
    const token = data?.session?.access_token;
    if (
      error ||
      typeof token !== "string" ||
      token.length > 3500 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    )
      return clear(reply(401, "AUTH_REQUIRED"));

    const identity = await supabase.auth.getUser(token);
    if (identity.error || !identity.data?.user)
      return clear(reply(401, "AUTH_REQUIRED"));
    if (!isGoogleOnlySession(identity.data.user))
      return clear(reply(403, "FORBIDDEN"));

    const proof = await supabase.auth.getClaims(token);
    const claims = proof.data?.claims;
    const now = Math.floor(Date.now() / 1000);
    if (
      proof.error ||
      !claims ||
      typeof claims.sub !== "string" ||
      !uuid.test(claims.sub) ||
      claims.sub !== identity.data.user.id ||
      typeof claims.exp !== "number" ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= now
    )
      return clear(reply(401, "AUTH_REQUIRED"));
    if (!isGoogleOnlySession(claims)) return clear(reply(403, "FORBIDDEN"));
    const fingerprint = await generationFingerprint(claims);
    if (!fingerprint || !generation.endsWith(`.${fingerprint}`))
      return clear(reply(401, "AUTH_REQUIRED"));

    const maxAge = Math.min(claims.exp - now, 300);
    const response = reply(200);
    response.cookies.set(apiCookieName, `v1.${generation}.${token}`, {
      ...apiCookieOptions,
      maxAge,
      expires: new Date((now + maxAge) * 1000),
    });
    return response;
  } catch {
    // Do not echo Auth errors, cookie values, claims, or profile data.
    return clear(reply(500, "INTERNAL_ERROR"));
  }
}
