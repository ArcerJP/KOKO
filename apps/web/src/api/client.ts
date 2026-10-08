import { errors, type ErrorCode } from "@koko/contract";
import type { components, operations } from "@koko/contract/api";
import {
  ownPostsSearch,
  parseOwnPost,
  parseOwnPostsPage,
  type OwnPostsQuery,
} from "./own-posts-contract";

export type Me =
  operations["getMe"]["responses"][200]["content"]["application/json"];
export type UpdateMe =
  operations["updateMe"]["requestBody"]["content"]["application/json"];
export type AcceptTerms =
  operations["acceptTerms"]["requestBody"]["content"]["application/json"];
export type EnrollmentStatus =
  operations["getEnrollment"]["responses"][200]["content"]["application/json"];
export type EnrollmentRequest =
  operations["enrollEvent"]["requestBody"]["content"]["application/json"];
export type Acknowledgement = components["schemas"]["Acknowledgement"];
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

export function isValidDisplayName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Array.from(value).length <= 50 &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

// headerへ安全に載せられる値だけ。正当性・セッション束縛はサーバーで検証する。
function isCsrfToken(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{32,256}$/.test(value);
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
    (value.csrf_token === undefined || isCsrfToken(value.csrf_token))
  );
}

function isAcknowledgement(value: unknown): value is Acknowledgement {
  return (
    object(value) &&
    typeof value.request_id === "string" &&
    uuid.test(value.request_id) &&
    (value.resource_id === undefined ||
      (typeof value.resource_id === "string" && uuid.test(value.resource_id)))
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

/** 同一originのCookie API用。Cookie発行・CSRF検証を実装するサーバーとは別。 */
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
  // 呼出し元が渡したURLを後から変更しても、送信先を変えない。
  const apiBase = new URL(baseUrl);
  function assertSameOrigin() {
    if (
      typeof globalThis.location !== "undefined" &&
      apiBase.origin !== globalThis.location.origin
    )
      throw new TypeError("同一originのAPI設定が必要です。");
  }
  assertSameOrigin();

  async function request(
    path: string,
    method: "GET" | "PATCH" | "POST",
    signal?: AbortSignal,
    mutation?: { body: string; csrfToken: string },
  ): Promise<unknown> {
    signal?.throwIfAborted();
    assertSameOrigin();
    let response: Response;
    try {
      response = await fetcher(new URL(path, apiBase), {
        method,
        headers: {
          Accept: "application/json",
          "X-Event-ID": eventId,
          ...(mutation
            ? {
                "Content-Type": "application/json",
                "X-CSRF-Token": mutation.csrfToken,
              }
            : {}),
        },
        // credentialsだけでは別originへの送信そのものを防げない。
        mode: "same-origin",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        ...(mutation ? { body: mutation.body } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch {
      signal?.throwIfAborted();
      throw new ApiFailure("NETWORK_UNAVAILABLE");
    }
    const body: unknown = await response.json().catch(() => null);
    signal?.throwIfAborted();
    if (response.status === 200) return body;
    if (
      !response.ok &&
      isApiError(body) &&
      errors[body.code].status === response.status
    )
      throw new ApiFailure(body.code, body.request_id);
    throw new ApiFailure("INTERNAL_ERROR");
  }

  async function mutate(
    path: "me" | "consents" | "me/enrollment",
    method: "PATCH" | "POST",
    input: UpdateMe | AcceptTerms,
    csrfToken: string,
    signal?: AbortSignal,
  ): Promise<Acknowledgement> {
    signal?.throwIfAborted();
    if (!isCsrfToken(csrfToken)) throw new ApiFailure("FORBIDDEN");
    const body = JSON.stringify(input);
    // 現在のWorker入力上限に合わせる。UTF-16文字数ではなくUTF-8 byte数。
    if (new TextEncoder().encode(body).byteLength > 1024)
      throw new ApiFailure("INVALID_INPUT");
    const result = await request(path, method, signal, { body, csrfToken });
    if (!isAcknowledgement(result)) throw new ApiFailure("INTERNAL_ERROR");
    // サーバーの余分なフィールド・内部情報を呼出し元へ渡さない。
    return {
      request_id: result.request_id,
      ...(result.resource_id ? { resource_id: result.resource_id } : {}),
    };
  }

  return {
    async getEnrollment(signal?: AbortSignal): Promise<EnrollmentStatus> {
      const body = await request("me/enrollment", "GET", signal);
      if (
        !object(body) ||
        typeof body.user_id !== "string" ||
        !uuid.test(body.user_id) ||
        body.event_id !== eventId ||
        typeof body.enrolled !== "boolean" ||
        typeof body.registration_open !== "boolean" ||
        (body.enrolled && body.registration_open) ||
        (body.csrf_token !== undefined && !isCsrfToken(body.csrf_token))
      )
        throw new ApiFailure("INTERNAL_ERROR");
      return {
        user_id: body.user_id,
        event_id: eventId,
        enrolled: body.enrolled,
        registration_open: body.registration_open,
        ...(body.csrf_token === undefined
          ? {}
          : { csrf_token: body.csrf_token }),
      };
    },
    async enrollEvent(
      input: EnrollmentRequest,
      csrfToken: string,
      signal?: AbortSignal,
    ): Promise<Acknowledgement> {
      signal?.throwIfAborted();
      if (
        !object(input) ||
        Object.keys(input).length !== 1 ||
        !isValidDisplayName(input.display_name)
      )
        throw new ApiFailure("INVALID_INPUT");
      return mutate(
        "me/enrollment",
        "POST",
        { display_name: input.display_name },
        csrfToken,
        signal,
      );
    },
    async getPostStatus(id: string, signal?: AbortSignal) {
      if (!uuid.test(id)) throw new ApiFailure("INVALID_INPUT");
      const normalized = id.toLowerCase();
      const body = await request(`posts/${normalized}/status`, "GET", signal);
      const post = parseOwnPost(body, eventId, normalized);
      if (!post) throw new ApiFailure("INTERNAL_ERROR");
      return post;
    },
    async listOwnPosts(query: OwnPostsQuery = {}, signal?: AbortSignal) {
      const search = ownPostsSearch(query);
      if (search === null) throw new ApiFailure("INVALID_INPUT");
      const body = await request(`me/posts${search}`, "GET", signal);
      const page = parseOwnPostsPage(body, eventId, query.limit ?? 30);
      if (!page) throw new ApiFailure("INTERNAL_ERROR");
      return page;
    },
    async getMe(signal?: AbortSignal): Promise<Me> {
      const body = await request("me", "GET", signal);
      if (!isMe(body, eventId)) throw new ApiFailure("INTERNAL_ERROR");
      return {
        user_id: body.user_id,
        event_id: body.event_id,
        display_name: body.display_name,
        role: body.role,
        is_banned: body.is_banned,
        terms_version: body.terms_version,
        consent_required: body.consent_required,
        crown: body.crown,
        ...(body.csrf_token === undefined
          ? {}
          : { csrf_token: body.csrf_token }),
      };
    },
    async updateMe(
      input: UpdateMe,
      csrfToken: string,
      signal?: AbortSignal,
    ): Promise<Acknowledgement> {
      signal?.throwIfAborted();
      if (
        !object(input) ||
        Object.keys(input).length !== 1 ||
        !isValidDisplayName(input.display_name)
      )
        throw new ApiFailure("INVALID_INPUT");
      return mutate(
        "me",
        "PATCH",
        { display_name: input.display_name },
        csrfToken,
        signal,
      );
    },
    async acceptTerms(
      input: AcceptTerms,
      csrfToken: string,
      signal?: AbortSignal,
    ): Promise<Acknowledgement> {
      signal?.throwIfAborted();
      if (
        !object(input) ||
        Object.keys(input).length !== 2 ||
        input.accepted !== true ||
        typeof input.terms_version !== "string" ||
        input.terms_version.trim().length === 0
      )
        throw new ApiFailure("INVALID_INPUT");
      return mutate(
        "consents",
        "POST",
        { terms_version: input.terms_version, accepted: true },
        csrfToken,
        signal,
      );
    },
  };
}
