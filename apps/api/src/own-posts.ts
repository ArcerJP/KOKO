import {
  isAfterCursor,
  postStates,
  type components,
  type CursorPosition,
} from "@koko/contract";
import {
  authenticateApiRequest,
  failure,
  object,
  privateHeaders,
  reply,
  uuid,
  type AccountEnv,
} from "./api-context";
import {
  OwnPostsError,
  ownPostsCursorKey,
  readOwnPostsCursor,
  signOwnPostsCursor,
  validPosition,
} from "./own-post-cursor";

export type OwnPostsEnv = AccountEnv & {
  KOKO_OWN_POSTS_ENABLED?: string;
  KOKO_POST_CURSOR_SECRET?: string;
};
type PostStatus = components["schemas"]["PostStatus"];
const safeReasons = [
  "UNSUPPORTED_MEDIA",
  "VIDEO_TOO_LONG",
  "PROVIDER_LIMIT",
  "UPLOAD_EXPIRED",
  "UPLOAD_INCOMPLETE",
  "INTERNAL_ERROR",
  "PROCESSING_HELD",
  "CONTENT_BLOCKED",
] as const;
function invalid(): never {
  throw new OwnPostsError("INTERNAL_ERROR");
}
const blockCategories = [
  "sexual",
  "violence",
  "hate",
  "harassment",
  "self_harm",
  "illicit",
  "other",
] as const;
const deletionStates = [
  "RETENTION_UNKNOWN",
  "RETENTION_PENDING",
  "PHYSICAL_DELETION_NOT_ENABLED",
  "DELETION_UNCONFIRMED",
] as const;
function validRetentionTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
  )
    return false;
  const wall = value.slice(0, 19);
  return (
    Number.isFinite(Date.parse(value)) &&
    new Date(`${wall}Z`).toISOString().slice(0, 19) === wall
  );
}
/** Only coarse categories and recorded retention metadata; never raw moderation/provider output. */
export function projectPostStateDetails(
  value: Record<string, unknown>,
  current: PostStatus["status"],
): Pick<PostStatus, "block_category" | "deletion"> {
  const details: Pick<PostStatus, "block_category" | "deletion"> = {};
  if (value.block_category !== undefined) {
    if (
      current !== "blocked" ||
      !blockCategories.includes(
        value.block_category as (typeof blockCategories)[number],
      )
    )
      invalid();
    details.block_category = value.block_category as NonNullable<
      PostStatus["block_category"]
    >;
  }
  if (value.deletion !== undefined) {
    const d = value.deletion;
    if (
      current !== "deleted" ||
      !object(d) ||
      !deletionStates.includes(d.state as (typeof deletionStates)[number]) ||
      (d.retention_until !== null &&
        !validRetentionTimestamp(d.retention_until)) ||
      (d.state === "RETENTION_PENDING" && d.retention_until === null)
    )
      invalid();
    details.deletion = {
      state: d.state as NonNullable<PostStatus["deletion"]>["state"],
      retention_until: d.retention_until as string | null,
    };
  }
  return details;
}
/** All response fields are explicitly projected, never a spread of RPC data. */
function status(value: unknown, eventId: string, postId?: string): PostStatus {
  if (
    !object(value) ||
    typeof value.id !== "string" ||
    (postId !== undefined && value.id !== postId) ||
    value.event_id !== eventId ||
    typeof value.created_at !== "string" ||
    !validPosition({ id: value.id, createdAt: value.created_at }) ||
    !postStates.includes(value.status as PostStatus["status"]) ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1
  )
    invalid();
  const result: PostStatus = {
    id: value.id,
    event_id: eventId,
    created_at: value.created_at,
    status: value.status as PostStatus["status"],
    version: value.version as number,
  };
  if (value.error_code !== undefined) {
    if (
      !safeReasons.includes(value.error_code as (typeof safeReasons)[number]) ||
      !["held", "blocked", "upload_failed"].includes(result.status)
    )
      invalid();
    result.error_code = value.error_code as NonNullable<
      PostStatus["error_code"]
    >;
  }
  return { ...result, ...projectPostStateDetails(value, result.status) };
}
/** Bound upstream JSON before parsing, without propagating secret headers or bodies. */
function boundedFetch(
  fetcher: typeof fetch,
  signal: AbortSignal,
): typeof fetch {
  return async (target, init) => {
    signal.throwIfAborted();
    const response = await fetcher(target, { ...init, signal });
    signal.throwIfAborted();
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => {});
      return new Response(null, { status: 502 });
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return new Response(null, { status: response.status });
    }
    if (
      !response.body ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      void response.body?.cancel().catch(() => {});
      invalid();
    }
    const reader = response.body.getReader();
    let length = 0,
      text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    const abort = () => void reader.cancel().catch(() => {});
    signal.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        length += value.byteLength;
        if (length > 256 * 1024) invalid();
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return new Response(text, {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    } catch {
      abort();
      return invalid();
    } finally {
      signal.removeEventListener("abort", abort);
      reader.releaseLock();
    }
  };
}

export async function handleOwnPosts(
  request: Request,
  env: OwnPostsEnv,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (env.KOKO_OWN_POSTS_ENABLED !== "true") return failure("NOT_FOUND");
  if (request.method !== "GET")
    return Response.json(
      { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } },
      { status: 405, headers: { ...privateHeaders, allow: "GET" } },
    );
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 10_000);
  try {
    const signal = AbortSignal.any([request.signal, deadline.signal]);
    const upstream = boundedFetch(fetcher, signal);
    const context = await authenticateApiRequest(request, env, upstream);
    if (!context.ok) return failure(context.code);
    const { settings } = context;
    const eventId = context.eventId.toLowerCase(),
      userId = context.userId.toLowerCase();
    const url = new URL(request.url);
    const list = url.pathname === "/me/posts";
    const postId = list
      ? undefined
      : /^\/posts\/([^/]+)\/status$/.exec(url.pathname)?.[1]?.toLowerCase();
    if ((!list && (!postId || !uuid.test(postId))) || request.body !== null)
      return failure("INVALID_INPUT");
    const params = url.searchParams;
    if (
      [...params.keys()].some(
        (name) =>
          !list ||
          !["limit", "cursor"].includes(name) ||
          params.getAll(name).length !== 1,
      )
    )
      return failure("INVALID_INPUT");
    const rawLimit = params.get("limit") ?? "30";
    if (!/^(?:[1-9][0-9]?|100)$/.test(rawLimit))
      return failure("INVALID_INPUT");
    const limit = list ? Number(rawLimit) : 1;
    const scope = { eventId, userId, limit };
    const key = list
      ? await ownPostsCursorKey(env.KOKO_POST_CURSOR_SECRET)
      : null;
    const before: CursorPosition | null = params.has("cursor")
      ? await readOwnPostsCursor(params.get("cursor")!, key!, scope)
      : null;
    const response = await upstream(
      new URL("/rest/v1/rpc/read_own_posts", settings.url),
      {
        method: "POST",
        redirect: "manual",
        cache: "no-store",
        headers: {
          apikey: settings.secretKey,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          p_event_id: eventId,
          p_user_id: userId,
          p_post_id: postId ?? null,
          p_before_created_at: before?.createdAt ?? null,
          p_before_id: before?.id ?? null,
          p_limit: limit,
        }),
      },
    );
    if (response.status !== 200) invalid();
    const value: unknown = await response.json();
    if (!object(value)) invalid();
    if (
      value.code === "FORBIDDEN" ||
      value.code === "NOT_FOUND" ||
      value.code === "INVALID_INPUT"
    )
      return failure(value.code);
    if (
      value.code !== "ok" ||
      !Array.isArray(value.items) ||
      value.items.length > limit ||
      typeof value.has_more !== "boolean" ||
      (value.has_more && value.items.length !== limit)
    )
      invalid();
    const items = value.items.map((item) => status(item, eventId, postId));
    let previous = before;
    const seen = new Set<string>();
    for (const item of items) {
      const position = { createdAt: item.created_at, id: item.id };
      if (seen.has(item.id) || (previous && !isAfterCursor(position, previous)))
        invalid();
      seen.add(item.id);
      previous = position;
    }
    signal.throwIfAborted();
    if (!list) {
      if (items.length !== 1 || value.has_more) invalid();
      return reply(items[0]!, 200);
    }
    const next = value.has_more
      ? await signOwnPostsCursor(key!, scope, previous!)
      : null;
    signal.throwIfAborted();
    return reply({ items, next_cursor: next }, 200);
  } catch (error) {
    return failure(
      error instanceof OwnPostsError ? error.code : "INTERNAL_ERROR",
    );
  } finally {
    clearTimeout(timer);
  }
}
