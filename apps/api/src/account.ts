import { errors, type ApiErrorCode } from "@koko/contract";
import {
  createCsrfToken,
  readAccountAuthentication,
  verifyCsrfToken,
  type CookieAuthEnv,
} from "./account-auth";

export type AccountEnv = CookieAuthEnv & {
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

/** Cookie is opt-in. Supabase SSR cookies must not become an implicit auth path. */
export async function handleAccount(
  request: Request,
  env: AccountEnv,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  return handleAccountRequest(request, env, fetcher, false);
}

export async function handleConsent(
  request: Request,
  env: AccountEnv,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  return handleAccountRequest(request, env, fetcher, true);
}

async function handleAccountRequest(
  request: Request,
  env: AccountEnv,
  fetcher: typeof fetch,
  consent: boolean,
): Promise<Response> {
  const allowed = consent ? ["POST"] : ["GET", "PATCH"];
  if (!allowed.includes(request.method)) {
    return Response.json(
      { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } },
      { status: 405, headers: { ...headers, allow: allowed.join(", ") } },
    );
  }

  const eventId = request.headers.get("X-Event-ID");
  if (!eventId || !uuid.test(eventId)) return failure("INVALID_INPUT");
  const credentials = readAccountAuthentication(request, env);
  if (!credentials.ok) return failure(credentials.code);
  const auth = credentials.authentication;
  const settings = config(env);
  if (!settings) return failure("INTERNAL_ERROR");

  try {
    if (
      auth.mode === "cookie" &&
      request.method !== "GET" &&
      !(await verifyCsrfToken(
        auth,
        eventId,
        request.headers.get("X-CSRF-Token"),
      ))
    )
      return failure("FORBIDDEN");
    const authResponse = await fetcher(new URL("/auth/v1/user", settings.url), {
      headers: {
        apikey: settings.publishableKey,
        Authorization: `Bearer ${auth.token}`,
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

    if (consent || request.method === "PATCH") {
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
      if (consent) {
        if (
          !object(body) ||
          Object.keys(body).length !== 2 ||
          body.accepted !== true ||
          typeof body.terms_version !== "string" ||
          body.terms_version.trim().length === 0
        ) {
          return failure("INVALID_INPUT");
        }
        // Compare the current version and insert in one DB transaction. Never
        // accept a caller-supplied user ID or consent timestamp.
        const response = await fetcher(
          new URL("/rest/v1/rpc/accept_current_terms", settings.url),
          {
            method: "POST",
            headers: {
              apikey: settings.secretKey,
              accept: "application/json",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              p_event_id: eventId,
              p_user_id: user.id,
              p_terms_version: body.terms_version,
            }),
            redirect: "manual",
            cache: "no-store",
          },
        );
        if (!response.ok) return failure("INTERNAL_ERROR");
        const result: unknown = await response.json();
        if (result === "terms_mismatch") return failure("CONSENT_REQUIRED");
        if (result === "forbidden") return failure("FORBIDDEN");
        if (result !== "accepted") return failure("INTERNAL_ERROR");
        return reply({ request_id: crypto.randomUUID() }, 200);
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
        ...(auth.mode === "cookie"
          ? { csrf_token: await createCsrfToken(auth, eventId) }
          : {}),
      },
      200,
    );
  } catch {
    // Never include upstream responses, tokens, profile data, or keys in API errors.
    return failure("INTERNAL_ERROR");
  }
}
