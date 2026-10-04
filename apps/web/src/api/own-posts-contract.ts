import { isAfterCursor, postStates } from "@koko/contract";
import type { components, operations } from "@koko/contract/api";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OwnPost = components["schemas"]["PostStatus"];
export type OwnPostsPage =
  operations["listOwnPosts"]["responses"][200]["content"]["application/json"];
export type OwnPostsQuery = NonNullable<
  operations["listOwnPosts"]["parameters"]["query"]
>;
const reasons = [
  "UNSUPPORTED_MEDIA",
  "VIDEO_TOO_LONG",
  "PROVIDER_LIMIT",
  "UPLOAD_EXPIRED",
  "UPLOAD_INCOMPLETE",
  "INTERNAL_ERROR",
  "PROCESSING_HELD",
  "CONTENT_BLOCKED",
] as const;

export function validCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 1024 &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)
  );
}
export function ownPostsSearch(query: OwnPostsQuery): string | null {
  if (
    !record(query) ||
    Object.keys(query).some((key) => !["limit", "cursor"].includes(key))
  )
    return null;
  const limit = query.limit === undefined ? 30 : query.limit;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (query.cursor !== undefined && !validCursor(query.cursor))
  )
    return null;
  const params = new URLSearchParams({ limit: String(limit) });
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  return `?${params}`;
}
/** Allowlist projection at both browser and server boundaries; no raw categories. */
export function parseOwnPost(
  value: unknown,
  eventId: string,
  id?: string,
): OwnPost | null {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    !uuid.test(value.id) ||
    (id !== undefined && value.id !== id) ||
    value.event_id !== eventId ||
    !postStates.includes(value.status as OwnPost["status"]) ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1 ||
    typeof value.created_at !== "string"
  )
    return null;
  try {
    // Date.parse normalizes impossible dates (e.g. February 30); fail closed.
    const wallTime = value.created_at.slice(0, 19);
    if (new Date(`${wallTime}Z`).toISOString().slice(0, 19) !== wallTime)
      return null;
    isAfterCursor(
      { id: value.id, createdAt: value.created_at },
      { id: value.id, createdAt: value.created_at },
    );
  } catch {
    return null;
  }
  const item: OwnPost = {
    id: value.id,
    event_id: eventId,
    status: value.status as OwnPost["status"],
    version: value.version as number,
    created_at: value.created_at,
  };
  if (value.error_code !== undefined) {
    if (
      !reasons.includes(value.error_code as (typeof reasons)[number]) ||
      !["blocked", "held", "upload_failed"].includes(item.status)
    )
      return null;
    item.error_code = value.error_code as NonNullable<OwnPost["error_code"]>;
  }
  return item;
}
export function parseOwnPostsPage(
  value: unknown,
  eventId: string,
  limit: number,
): OwnPostsPage | null {
  if (
    !record(value) ||
    !Array.isArray(value.items) ||
    value.items.length > limit ||
    (value.next_cursor !== null && !validCursor(value.next_cursor)) ||
    (value.next_cursor !== null && value.items.length !== limit)
  )
    return null;
  const items: OwnPost[] = [];
  const ids = new Set<string>();
  for (const entry of value.items) {
    const item = parseOwnPost(entry, eventId);
    if (!item || ids.has(item.id.toLowerCase())) return null;
    const previous = items.at(-1);
    if (
      previous &&
      !isAfterCursor(
        { id: item.id, createdAt: item.created_at },
        { id: previous.id, createdAt: previous.created_at },
      )
    )
      return null;
    ids.add(item.id.toLowerCase());
    items.push(item);
  }
  return { items, next_cursor: value.next_cursor };
}
