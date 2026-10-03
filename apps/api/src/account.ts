import { errors, type ApiErrorCode } from "@koko/contract";

export type AccountEnv = {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_SECRET_KEY?: string;
};

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const headers = {
  "cache-control": "private, no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reply(body: object, status: number): Response {
  return Response.json(body, { status, headers });
}

function failure(code: ApiErrorCode): Response {
  return reply({ code, request_id: crypto.randomUUID() }, errors[code].status);
}

async function limitedBody(request: Request): Promise<string | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1024) {
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

function config(env: AccountEnv) {
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
    ) {
      return null;
    }
    return {
      url,
      publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
      secretKey: env.SUPABASE_SECRET_KEY,
    };
  } catch {
    return null;
  }
}

async function rows(
  fetcher: typeof fetch,
  url: URL,
  key: string,
  init?: RequestInit,
): Promise<Record<string, unknown>[] | null> {
  const response = await fetcher(url, {
    ...init,
    headers: {
      apikey: key,
      accept: "application/json",
      ...init?.headers,
    },
    // workerd rejects "error"; do not follow redirects carrying the secret key.
    redirect: "manual",
    cache: "no-store",
  });
  if (!response.ok) return null;
  const value: unknown = await response.json();
  return Array.isArray(value) && value.every(object) ? value : null;
}

function restUrl(
  base: URL,
  table: string,
  filters: Record<string, string>,
): URL {
  const url = new URL(`/rest/v1/${table}`, base);
  for (const [key, value] of Object.entries(filters))
    url.searchParams.set(key, value);
  url.searchParams.set("limit", "1");
  return url;
}

/** Only Bearer is supported here. Supabase SSR cookies must not become an implicit auth path. */
export async function handleAccount(
  request: Request,
  env: AccountEnv,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "PATCH") {
    return Response.json(
      { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } },
      { status: 405, headers: { ...headers, allow: "GET, PATCH" } },
    );
  }

  const eventId = request.headers.get("X-Event-ID");
  if (!eventId || !uuid.test(eventId)) return failure("INVALID_INPUT");
  const authorization = request.headers.get("Authorization");
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization ?? "");
  if (!match || !match[1] || match[1].length > 8192)
    return failure("AUTH_REQUIRED");
  const settings = config(env);
  if (!settings) return failure("INTERNAL_ERROR");

  try {
    const authResponse = await fetcher(new URL("/auth/v1/user", settings.url), {
      headers: {
        apikey: settings.publishableKey,
        Authorization: `Bearer ${match[1]}`,
      },
      // Redirects remain non-OK below and must never forward the bearer token.
      redirect: "manual",
      cache: "no-store",
    });
    if ([400, 401, 403].includes(authResponse.status)) {
      return failure("AUTH_REQUIRED");
    }
    if (!authResponse.ok) return failure("INTERNAL_ERROR");
    const user: unknown = await authResponse.json();
    if (!object(user) || typeof user.id !== "string" || !uuid.test(user.id)) {
      return failure("AUTH_REQUIRED");
    }
    const metadata = user.app_metadata;
    if (
      !object(metadata) ||
      metadata.provider !== "google" ||
      !Array.isArray(metadata.providers) ||
      metadata.providers.length !== 1 ||
      metadata.providers[0] !== "google"
    ) {
      return failure("FORBIDDEN");
    }

    const memberUrl = restUrl(settings.url, "event_members", {
      select: "display_name,role,is_banned,crown",
      event_id: `eq.${eventId}`,
      user_id: `eq.${user.id}`,
    });
    const members = await rows(fetcher, memberUrl, settings.secretKey);
    if (!members) return failure("INTERNAL_ERROR");
    const member = members[0];
    if (!member) return failure("FORBIDDEN");

    if (request.method === "PATCH") {
      if (
        request.headers
          .get("Content-Type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      ) {
        return failure("INVALID_INPUT");
      }
      if (Number(request.headers.get("Content-Length")) > 1024) {
        return failure("INVALID_INPUT");
      }
      const raw = await limitedBody(request);
      if (raw === null) return failure("INVALID_INPUT");
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return failure("INVALID_INPUT");
      }
      if (
        !object(body) ||
        Object.keys(body).length !== 1 ||
        typeof body.display_name !== "string" ||
        body.display_name.trim().length === 0 ||
        Array.from(body.display_name).length > 50 ||
        /[\p{Cc}\p{Cf}]/u.test(body.display_name)
      ) {
        return failure("INVALID_INPUT");
      }
      const updated = await rows(fetcher, memberUrl, settings.secretKey, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          prefer: "return=representation",
        },
        body: JSON.stringify({ display_name: body.display_name }),
      });
      if (!updated) return failure("INTERNAL_ERROR");
      if (updated.length !== 1) return failure("FORBIDDEN");
      return reply({ request_id: crypto.randomUUID() }, 200);
    }

    const eventRows = await rows(
      fetcher,
      restUrl(settings.url, "events", {
        select: "terms_version",
        event_id: `eq.${eventId}`,
      }),
      settings.secretKey,
    );
    if (!eventRows || eventRows.length !== 1) return failure("INTERNAL_ERROR");
    const termsVersion = eventRows[0]?.terms_version;
    if (
      typeof termsVersion !== "string" ||
      typeof member.display_name !== "string" ||
      Array.from(member.display_name).length < 1 ||
      Array.from(member.display_name).length > 50 ||
      !["user", "moderator", "admin"].includes(String(member.role)) ||
      typeof member.is_banned !== "boolean" ||
      !["none", "white", "gold"].includes(String(member.crown))
    ) {
      return failure("INTERNAL_ERROR");
    }
    const consents = await rows(
      fetcher,
      restUrl(settings.url, "consents", {
        select: "terms_version",
        event_id: `eq.${eventId}`,
        user_id: `eq.${user.id}`,
        terms_version: `eq.${termsVersion}`,
      }),
      settings.secretKey,
    );
    if (!consents) return failure("INTERNAL_ERROR");
    return reply(
      {
        user_id: user.id,
        event_id: eventId,
        display_name: member.display_name,
        role: member.role,
        is_banned: member.is_banned,
        terms_version: termsVersion,
        consent_required: consents.length === 0,
        crown: member.crown,
      },
      200,
    );
  } catch {
    // Never include upstream responses, tokens, profile data, or keys in API errors.
    return failure("INTERNAL_ERROR");
  }
}
