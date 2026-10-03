import type { ApiErrorCode } from "@koko/contract";

export type CookieAuthEnv = {
  KOKO_WEB_ORIGIN?: string;
  KOKO_CSRF_SECRET?: string;
};

type CookieAuthentication = {
  mode: "cookie";
  token: string;
  origin: string;
  secret: string;
};
type Authentication = { mode: "bearer"; token: string } | CookieAuthentication;
type AuthResult =
  | { ok: true; authentication: Authentication }
  | { ok: false; code: ApiErrorCode };

const cookieName = "__Host-koko_session";
const tokenPattern = /^[A-Za-z0-9._~-]{1,8192}$/;

/** Transport checks only. The token must still be verified with Supabase Auth. */
export function readAccountAuthentication(
  request: Request,
  env: CookieAuthEnv,
): AuthResult {
  const cookie = request.headers.get("Cookie") ?? "";
  const candidates = cookie
    .split(";")
    .map((part) => part.trim())
    .filter(
      (part) =>
        part === cookieName ||
        part.startsWith(`${cookieName}=`) ||
        part.startsWith(`${cookieName}.`),
    );
  const authorization = request.headers.get("Authorization");
  if (authorization !== null) {
    // Do not pick a credential silently, or fall back from a bad Bearer to Cookie.
    if (candidates.length) return { ok: false, code: "AUTH_REQUIRED" };
    const match = /^Bearer ([A-Za-z0-9._~-]{1,8192})$/.exec(authorization);
    return match?.[1]
      ? { ok: true, authentication: { mode: "bearer", token: match[1] } }
      : { ok: false, code: "AUTH_REQUIRED" };
  }
  if (cookie.length > 16384) return { ok: false, code: "AUTH_REQUIRED" };
  if (candidates.length !== 1 || !candidates[0]?.startsWith(`${cookieName}=`))
    return { ok: false, code: "AUTH_REQUIRED" };
  const token = candidates[0].slice(cookieName.length + 1);
  if (!tokenPattern.test(token)) return { ok: false, code: "AUTH_REQUIRED" };

  // No runtime values are added to Wrangler by this implementation.
  if (env.KOKO_WEB_ORIGIN === undefined && env.KOKO_CSRF_SECRET === undefined)
    return { ok: false, code: "AUTH_REQUIRED" };
  let origin: string;
  try {
    const url = new URL(env.KOKO_WEB_ORIGIN ?? "");
    if (
      url.protocol !== "https:" ||
      url.origin !== env.KOKO_WEB_ORIGIN ||
      !/^[0-9a-f]{64}$/i.test(env.KOKO_CSRF_SECRET ?? "")
    )
      return { ok: false, code: "INTERNAL_ERROR" };
    origin = url.origin;
  } catch {
    return { ok: false, code: "INTERNAL_ERROR" };
  }
  if (new URL(request.url).protocol !== "https:")
    return { ok: false, code: "FORBIDDEN" };
  const suppliedOrigin = request.headers.get("Origin");
  const write = request.method !== "GET" && request.method !== "HEAD";
  if ((write || suppliedOrigin !== null) && suppliedOrigin !== origin)
    return { ok: false, code: "FORBIDDEN" };
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin" && !(site === "none" && !write))
    return { ok: false, code: "FORBIDDEN" };
  return {
    ok: true,
    authentication: {
      mode: "cookie",
      token,
      origin,
      secret: env.KOKO_CSRF_SECRET!,
    },
  };
}

function message(auth: CookieAuthentication, eventId: string, nonce: string) {
  return new TextEncoder().encode(
    JSON.stringify(["koko.csrf.v1", auth.origin, eventId, auth.token, nonce]),
  );
}

function importKey(secret: string) {
  const bytes = Uint8Array.from(secret.match(/../g)!, (pair) =>
    parseInt(pair, 16),
  );
  return crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Only call after Google identity and event membership have been verified. */
export async function createCsrfToken(
  auth: CookieAuthentication,
  eventId: string,
): Promise<string> {
  const nonce = Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
  const mac = await crypto.subtle.sign(
    "HMAC",
    await importKey(auth.secret),
    message(auth, eventId, nonce),
  );
  return `v1.${nonce}.${base64url(new Uint8Array(mac))}`;
}

export async function verifyCsrfToken(
  auth: CookieAuthentication,
  eventId: string,
  value: string | null,
): Promise<boolean> {
  const match = /^v1\.([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/.exec(value ?? "");
  if (!match?.[1] || !match[2]) return false;
  const signature = Uint8Array.from(
    atob(match[2].replace(/-/g, "+").replace(/_/g, "/") + "="),
    (char) => char.charCodeAt(0),
  );
  if (base64url(signature) !== match[2]) return false;
  // Web Crypto verifies the MAC; do not compare secret-derived strings manually.
  return crypto.subtle.verify(
    "HMAC",
    await importKey(auth.secret),
    signature,
    message(auth, eventId, match[1]),
  );
}
