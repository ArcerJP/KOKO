import { errors, type ErrorCode } from "@koko/contract";
import type { components, operations } from "@koko/contract/api";

export type Me =
  operations["getMe"]["responses"][200]["content"]["application/json"];
type ApiError = components["schemas"]["ApiError"];
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ApiFailure extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly requestId: string | null = null,
  ) {
    super(errors[code].message);
    this.name = "ApiFailure";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMe(value: unknown, eventId: string): value is Me {
  if (!object(value)) return false;
  return (
    typeof value.user_id === "string" &&
    uuid.test(value.user_id) &&
    value.event_id === eventId &&
    typeof value.display_name === "string" &&
    Array.from(value.display_name).length >= 1 &&
    Array.from(value.display_name).length <= 50 &&
    typeof value.role === "string" &&
    ["user", "moderator", "admin"].includes(value.role) &&
    typeof value.is_banned === "boolean" &&
    typeof value.consent_required === "boolean" &&
    typeof value.terms_version === "string" &&
    typeof value.crown === "string" &&
    ["none", "white", "gold"].includes(value.crown) &&
    (value.csrf_token === undefined ||
      (typeof value.csrf_token === "string" &&
        value.csrf_token.length >= 32 &&
        value.csrf_token.length <= 256))
  );
}

function isApiError(value: unknown): value is ApiError {
  return (
    object(value) &&
    typeof value.code === "string" &&
    Object.hasOwn(errors, value.code) &&
    errors[value.code as ErrorCode].status > 0 &&
    typeof value.request_id === "string" &&
    uuid.test(value.request_id)
  );
}

/** GET境界の基盤。認証・Cookie発行・CSRF更新APIの実装ではない。 */
export function createApiClient(
  baseUrl: URL,
  eventId: string,
  fetcher: typeof fetch = fetch,
) {
  if (!uuid.test(eventId))
    throw new TypeError("event_idがUUIDではありません。");
  if (
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    !baseUrl.pathname.endsWith("/")
  )
    throw new TypeError("API設定が不正です。");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname);
  if (baseUrl.protocol !== "https:" && !(local && baseUrl.protocol === "http:"))
    throw new TypeError("HTTPSのAPI設定が必要です。");
  const endpoint = new URL("me", baseUrl);
  return {
    async getMe(signal?: AbortSignal): Promise<Me> {
      let response: Response;
      try {
        response = await fetcher(endpoint, {
          headers: { Accept: "application/json", "X-Event-ID": eventId },
          credentials: "same-origin",
          redirect: "error",
          cache: "no-store",
          ...(signal ? { signal } : {}),
        });
      } catch {
        signal?.throwIfAborted();
        throw new ApiFailure("NETWORK_UNAVAILABLE");
      }
      const body: unknown = await response.json().catch(() => null);
      signal?.throwIfAborted();
      if (response.status === 200 && isMe(body, eventId)) return body;
      if (
        !response.ok &&
        isApiError(body) &&
        errors[body.code].status === response.status
      )
        throw new ApiFailure(body.code, body.request_id);
      // サーバーの生レスポンス・CSRF token・内部例外を表示/ログしない。
      throw new ApiFailure("INTERNAL_ERROR");
    },
  };
}
