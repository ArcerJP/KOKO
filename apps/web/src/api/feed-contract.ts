import { isAfterCursor } from "@koko/contract";
import type { components } from "@koko/contract/api";
import { record, validId } from "./upload-contract";
import { isValidDisplayName } from "./client";

export type PublicPost = components["schemas"]["PublicPost"];
export type FeedPage = components["schemas"]["PostPage"];
export type FeedQuery = { limit?: number; cursor?: string; theme?: string };
export const validFeedCursor = (x: unknown): x is string =>
  typeof x === "string" &&
  x.length <= 1500 &&
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(x);
export function feedSearch(query: FeedQuery): string | null {
  if (
    !record(query) ||
    Object.keys(query).some((k) => !["limit", "cursor", "theme"].includes(k))
  )
    return null;
  const limit = query.limit ?? 30;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (query.cursor !== undefined && !validFeedCursor(query.cursor)) ||
    (query.theme !== undefined && !validId(query.theme))
  )
    return null;
  const search = new URLSearchParams({ limit: String(limit) });
  if (query.theme !== undefined) search.set("theme", query.theme.toLowerCase());
  if (query.cursor !== undefined) search.set("cursor", query.cursor);
  return `?${search}`;
}
export function parsePublicPost(
  value: unknown,
  eventId: string,
  expectedId?: string,
): PublicPost | null {
  if (
    !record(value) ||
    !validId(value.id) ||
    value.id !== value.id.toLowerCase() ||
    value.event_id !== eventId ||
    (expectedId !== undefined && value.id !== expectedId) ||
    !isValidDisplayName(value.display_name) ||
    value.crown !== "none" ||
    value.like_count !== 0 ||
    !(value.theme_id === null || validId(value.theme_id)) ||
    typeof value.created_at !== "string" ||
    !record(value.media)
  )
    return null;
  try {
    const wall = value.created_at.slice(0, 19);
    if (new Date(`${wall}Z`).toISOString().slice(0, 19) !== wall) return null;
    isAfterCursor(
      { id: value.id, createdAt: value.created_at },
      { id: value.id, createdAt: value.created_at },
    );
  } catch {
    return null;
  }
  const base = `/media/${eventId}/${value.id}/`,
    x = value.media;
  let media: PublicPost["media"];
  if (
    value.kind === "photo" &&
    x.kind === "photo" &&
    ["webp_600", "jpg_600", "webp_1600", "jpg_1600"].every(
      (k) => x[k] === base + k.replace("_", "-"),
    )
  ) {
    media = {
      kind: "photo",
      webp_600: base + "webp-600",
      jpg_600: base + "jpg-600",
      webp_1600: base + "webp-1600",
      jpg_1600: base + "jpg-1600",
    };
  } else if (
    value.kind === "video" &&
    x.kind === "video" &&
    x.hls_url === base + "hls" &&
    x.thumbnail_url === base + "thumbnail" &&
    x.mp4_url === undefined &&
    typeof x.duration_seconds === "number" &&
    Number.isFinite(x.duration_seconds) &&
    x.duration_seconds > 0 &&
    x.duration_seconds <= 4
  ) {
    media = {
      kind: "video",
      hls_url: base + "hls",
      thumbnail_url: base + "thumbnail",
      duration_seconds: x.duration_seconds,
    };
  } else return null;
  return {
    id: value.id,
    event_id: eventId,
    kind: value.kind,
    display_name: value.display_name,
    crown: "none",
    like_count: 0,
    theme_id: value.theme_id,
    created_at: value.created_at,
    media,
  } as PublicPost;
}
export function parseFeedPage(
  value: unknown,
  eventId: string,
  query: FeedQuery,
): FeedPage | null {
  if (
    !feedSearch(query) ||
    !record(value) ||
    !Array.isArray(value.items) ||
    value.items.length > (query.limit ?? 30) ||
    !(value.next_cursor === null || validFeedCursor(value.next_cursor)) ||
    (value.next_cursor !== null && value.items.length !== (query.limit ?? 30))
  )
    return null;
  const items: PublicPost[] = [],
    ids = new Set<string>();
  for (const row of value.items) {
    const item = parsePublicPost(row, eventId),
      previous = items.at(-1);
    if (
      !item ||
      ids.has(item.id) ||
      (query.theme !== undefined &&
        item.theme_id !== query.theme.toLowerCase()) ||
      (previous &&
        !isAfterCursor(
          { id: item.id, createdAt: item.created_at },
          { id: previous.id, createdAt: previous.created_at },
        ))
    )
      return null;
    items.push(item);
    ids.add(item.id);
  }
  return { items, next_cursor: value.next_cursor };
}
