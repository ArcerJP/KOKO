import type { NextResponse } from "next/server";

export const apiCookieName = "__Host-koko_session";
export const generationCookieName = "__Host-koko_generation";
export const apiCookieOptions = {
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  path: "/",
} as const;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const generationFormat =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{64}$/;

/** 必ずSDKで検証したclaimsを渡す。これ自体はJWTを検証しない。 */
export async function generationFingerprint(
  claims: Record<string, unknown>,
): Promise<string | null> {
  if (
    typeof claims.sub !== "string" ||
    !uuid.test(claims.sub) ||
    typeof claims.session_id !== "string" ||
    !uuid.test(claims.session_id)
  )
    return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${claims.sub.toLowerCase()}:${claims.session_id.toLowerCase()}`,
    ),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function createApiGeneration(
  claims: Record<string, unknown>,
): Promise<string | null> {
  const fingerprint = await generationFingerprint(claims);
  return fingerprint ? `${crypto.randomUUID()}.${fingerprint}` : null;
}

function singleCookie(headers: Headers, name: string): string | null {
  const header = headers.get("cookie") ?? "";
  if (new TextEncoder().encode(header).byteLength > 16 * 1024) return null;
  let value: string | null = null;
  for (const part of header.split(";")) {
    const item = part.trim();
    const index = item.indexOf("=");
    const key = index < 0 ? item : item.slice(0, index);
    if (key.startsWith(`${name}.`)) return null;
    if (key !== name) continue;
    if (index < 0 || value !== null) return null;
    value = item.slice(index + 1);
  }
  return value;
}

export function apiGeneration(headers: Headers): string | null {
  const value = singleCookie(headers, generationCookieName);
  return value && generationFormat.test(value) ? value : null;
}

/** 世代は応答の並び替わり対策。認証・認可の証拠としては使わない。 */
export function apiTokenForProxy(headers: Headers): string | null {
  if (headers.has("authorization")) return null;
  const generation = apiGeneration(headers);
  const value = singleCookie(headers, apiCookieName);
  const prefix = `v1.${generation}.`;
  if (!generation || !value?.startsWith(prefix)) return null;
  const token = value.slice(prefix.length);
  return token.length <= 3500 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)
    ? token
    : null;
}

export function clearApiCookie(response: NextResponse) {
  response.cookies.set(apiCookieName, "", {
    ...apiCookieOptions,
    maxAge: 0,
    expires: new Date(0),
  });
  return response;
}

export function setApiGeneration(response: NextResponse, value: string) {
  if (value !== "ended" && !generationFormat.test(value))
    throw new TypeError("Invalid generation");
  response.cookies.set(generationCookieName, value, {
    ...apiCookieOptions,
    // 長期識別子だけ。認証/JWT/API Cookieの有効期間を延長しない。
    maxAge: 31_536_000,
  });
  return clearApiCookie(response);
}
