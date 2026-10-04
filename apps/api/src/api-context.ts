import { errors, type ApiErrorCode } from "@koko/contract";
import {
  readAccountAuthentication,
  verifyCsrfToken,
  type CookieAuthEnv,
} from "./account-auth";

export type AccountEnv = CookieAuthEnv & {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_SECRET_KEY?: string;
};
export const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const privateHeaders = {
  "cache-control": "private, no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;
export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function reply(body: object, status: number): Response {
  return Response.json(body, { status, headers: privateHeaders });
}
export function failure(code: ApiErrorCode, retryAfter?: number): Response {
  return reply(
    {
      code,
      request_id: crypto.randomUUID(),
      ...(retryAfter === undefined ? {} : { retry_after_seconds: retryAfter }),
    },
    errors[code].status,
  );
}
export async function limitedBody(
  request: Request,
  limit = 1024,
): Promise<string | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    return null;
  }
}
export function readApiSettings(env: AccountEnv) {
  try {
    const url = new URL(env.SUPABASE_URL ?? "");
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !env.SUPABASE_PUBLISHABLE_KEY?.startsWith("sb_publishable_") ||
      !env.SUPABASE_SECRET_KEY?.startsWith("sb_secret_")
    )
      return null;
    return {
      url,
      publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
      secretKey: env.SUPABASE_SECRET_KEY,
    };
  } catch {
    return null;
  }
}

/** Transport/CSRF and verified Google identity only. Each route still needs DB authorization. */
export async function authenticateApiRequest(
  request: Request,
  env: AccountEnv,
  fetcher: typeof fetch,
) {
  const eventId = request.headers.get("X-Event-ID");
  if (!eventId || !uuid.test(eventId))
    return { ok: false, code: "INVALID_INPUT" } as const;
  const credentials = readAccountAuthentication(request, env);
  if (!credentials.ok) return credentials;
  const auth = credentials.authentication;
  const settings = readApiSettings(env);
  if (!settings) return { ok: false, code: "INTERNAL_ERROR" } as const;
  if (
    auth.mode === "cookie" &&
    request.method !== "GET" &&
    !(await verifyCsrfToken(auth, eventId, request.headers.get("X-CSRF-Token")))
  )
    return { ok: false, code: "FORBIDDEN" } as const;
  const response = await fetcher(new URL("/auth/v1/user", settings.url), {
    headers: {
      apikey: settings.publishableKey,
      Authorization: `Bearer ${auth.token}`,
    },
    redirect: "manual",
    cache: "no-store",
  });
  if ([400, 401, 403].includes(response.status))
    return { ok: false, code: "AUTH_REQUIRED" } as const;
  if (!response.ok) return { ok: false, code: "INTERNAL_ERROR" } as const;
  const user: unknown = await response.json();
  if (!object(user) || typeof user.id !== "string" || !uuid.test(user.id))
    return { ok: false, code: "AUTH_REQUIRED" } as const;
  const metadata = user.app_metadata;
  if (
    !object(metadata) ||
    metadata.provider !== "google" ||
    !Array.isArray(metadata.providers) ||
    metadata.providers.length !== 1 ||
    metadata.providers[0] !== "google"
  )
    return { ok: false, code: "FORBIDDEN" } as const;
  return { ok: true, eventId, userId: user.id, auth, settings } as const;
}
