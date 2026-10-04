import { createCsrfToken } from "./account-auth";
import {
  authenticateApiRequest,
  failure,
  limitedBody,
  object,
  privateHeaders as headers,
  reply,
  type AccountEnv,
} from "./api-context";
export type { AccountEnv } from "./api-context";

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

  try {
    const context = await authenticateApiRequest(request, env, fetcher);
    if (!context.ok) return failure(context.code);
    const { eventId, userId, auth, settings } = context;

    const memberUrl = restUrl(settings.url, "event_members", {
      select: "display_name,role,is_banned,crown",
      event_id: `eq.${eventId}`,
      user_id: `eq.${userId}`,
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
              p_user_id: userId,
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
        user_id: `eq.${userId}`,
        terms_version: `eq.${termsVersion}`,
      }),
      settings.secretKey,
    );
    if (!consents) return failure("INTERNAL_ERROR");
    return reply(
      {
        user_id: userId,
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
