import { NextResponse } from "next/server";
import { isGoogleOnlySession } from "./google-session";
import { createServerAuthClient } from "./server";

const cookieName = "__Host-koko_session";
const cookieOptions = {
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  path: "/",
} as const;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function reply(status: number, code?: string) {
  return NextResponse.json(code ? { code } : { ok: true }, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function clear(response: NextResponse) {
  response.cookies.set(cookieName, "", {
    ...cookieOptions,
    maxAge: 0,
    expires: new Date(0),
  });
  return response;
}

function configuredOrigin(): string | null {
  if (process.env.KOKO_API_COOKIE_ENABLED !== "true") return null;
  try {
    const origin = process.env.KOKO_WEB_ORIGIN;
    const url = new URL(origin ?? "");
    return url.protocol === "https:" && url.origin === origin ? origin : null;
  } catch {
    return null;
  }
}

async function hasEmptyBody(request: Request): Promise<boolean> {
  if (request.signal.aborted || request.bodyUsed) return false;
  if (!request.body) return true;
  if (request.body.locked) return false;
  const reader = request.body.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Next.js wraps even empty Node POST/DELETE bodies in a stream. Require EOF
    // without buffering a supplied payload or waiting indefinitely for a sender.
    const first = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), 1000);
      }),
    ]);
    return first?.done === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Internal Web session bridge, not an event API or a Supabase sign-out route. */
export async function handleApiSession(request: Request): Promise<Response> {
  if (!["POST", "DELETE"].includes(request.method)) {
    const response = reply(405, "METHOD_NOT_ALLOWED");
    response.headers.set("Allow", "POST, DELETE");
    return response;
  }
  const origin = configuredOrigin();
  if (!origin) return reply(503, "API_SESSION_UNAVAILABLE");
  const url = new URL(request.url);
  const site = request.headers.get("Sec-Fetch-Site");
  if (
    url.origin !== origin ||
    request.headers.get("Origin") !== origin ||
    request.headers.get("X-KOKO-Session-Request") !== "1" ||
    (site !== null && site !== "same-origin")
  )
    return reply(403, "FORBIDDEN");
  // No caller-supplied identity, token, redirect target, or alternate credential.
  if (
    url.search ||
    request.headers.has("Authorization") ||
    !(await hasEmptyBody(request))
  )
    return reply(400, "INVALID_INPUT");

  // Only expires the API cookie; never claims to revoke the Supabase session.
  if (request.method === "DELETE") return clear(reply(200));

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

    const maxAge = Math.min(claims.exp - now, 300);
    const response = reply(200);
    response.cookies.set(cookieName, token, {
      ...cookieOptions,
      maxAge,
      expires: new Date((now + maxAge) * 1000),
    });
    return response;
  } catch {
    // Do not echo Auth errors, cookie values, claims, or profile data.
    return clear(reply(500, "INTERNAL_ERROR"));
  }
}
