import {
  isAfterCursor,
  type CursorPosition,
  type components,
} from "@koko/contract";
import {
  failure,
  object,
  privateHeaders,
  reply,
  uuid,
  type AccountEnv,
} from "./api-context";
import { ownPostsCursorKey, validPosition } from "./own-post-cursor";
import { MediaReadError, mediaFailure, readMediaRpc } from "./media-delivery";

export type PublicFeedEnv = AccountEnv & {
  KOKO_PUBLIC_FEED_ENABLED?: string;
  KOKO_POST_CURSOR_SECRET?: string;
};
type PublicPost = components["schemas"]["PublicPost"];
type CacheProof = { id: string; fingerprint: string };
type CachedPage = {
  expiresAt: number;
  items: PublicPost[];
  hasMore: boolean;
  proof: CacheProof[];
};
/** Bounded, 10-second, common DTO cache. It is NEVER an authorization cache. */
export class PublicFeedCache {
  private readonly pages = new Map<string, CachedPage>();
  get(key: string): CachedPage | null {
    const page = this.pages.get(key);
    if (!page || page.expiresAt <= Date.now()) {
      this.pages.delete(key);
      return null;
    }
    return structuredClone(page);
  }
  put(key: string, page: Omit<CachedPage, "expiresAt">) {
    if (this.pages.size >= 64)
      this.pages.delete(this.pages.keys().next().value!);
    this.pages.set(
      key,
      structuredClone({ ...page, expiresAt: Date.now() + 10_000 }),
    );
  }
  delete(key: string) {
    this.pages.delete(key);
  }
}
const sharedPages = new PublicFeedCache();
const invalid = (): never => {
  throw new MediaReadError("INVALID_INPUT");
};
const bad = (): never => {
  throw new MediaReadError("INTERNAL_ERROR");
};
const encode = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
function decode(s: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error();
  const b = Uint8Array.from(
    atob(
      s.replaceAll("-", "+").replaceAll("_", "/") +
        "=".repeat((4 - (s.length % 4)) % 4),
    ),
    (c) => c.charCodeAt(0),
  );
  if (encode(b) !== s) throw new Error();
  return b;
}
async function signCursor(
  key: CryptoKey,
  scope: string[],
  position: CursorPosition,
) {
  const p = encode(
    new TextEncoder().encode(
      JSON.stringify([
        "koko.feed.v1:created_at.desc,id.desc",
        ...scope,
        position.createdAt,
        position.id,
        Math.floor(Date.now() / 1000) + 900,
      ]),
    ),
  );
  return `${p}.${encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(p))))}`;
}
async function readCursor(
  token: string,
  key: CryptoKey,
  scope: string[],
): Promise<CursorPosition> {
  try {
    if (!token || token.length > 1500) throw new Error();
    const [p, mac, extra] = token.split(".");
    if (
      !p ||
      !mac ||
      extra !== undefined ||
      decode(mac).length !== 32 ||
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        decode(mac),
        new TextEncoder().encode(p),
      ))
    )
      throw new Error();
    const v: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        decode(p),
      ),
    );
    if (
      !Array.isArray(v) ||
      v.length !== 7 ||
      v[0] !== "koko.feed.v1:created_at.desc,id.desc" ||
      !scope.every((s, i) => s === v[i + 1]) ||
      typeof v[4] !== "string" ||
      typeof v[5] !== "string" ||
      !Number.isSafeInteger(v[6]) ||
      v[6] <= Math.floor(Date.now() / 1000) ||
      v[6] > Math.floor(Date.now() / 1000) + 900
    )
      throw new Error();
    const result = { createdAt: v[4], id: v[5] };
    if (!validPosition(result)) throw new Error();
    return result;
  } catch {
    throw new MediaReadError("INVALID_CURSOR");
  }
}
/** Positive field projection; no user IDs, original keys, Stream UID, or upstream URLs. */
function projectPost(x: unknown, eventId: string): PublicPost {
  if (
    !object(x) ||
    typeof x.id !== "string" ||
    !uuid.test(x.id) ||
    x.event_id !== eventId ||
    typeof x.display_name !== "string" ||
    [...x.display_name].length < 1 ||
    [...x.display_name].length > 50 ||
    x.crown !== "none" ||
    x.like_count !== 0 ||
    (x.theme_id !== null &&
      (typeof x.theme_id !== "string" || !uuid.test(x.theme_id))) ||
    typeof x.created_at !== "string" ||
    !validPosition({ id: x.id, createdAt: x.created_at }) ||
    !object(x.media)
  )
    return bad();
  const base = `/media/${eventId}/${x.id}/`;
  let media:
    | components["schemas"]["PhotoDelivery"]
    | components["schemas"]["VideoDelivery"];
  if (x.kind === "photo" && x.media.kind === "photo") {
    if (
      x.media.webp_600 !== base + "webp-600" ||
      x.media.jpg_600 !== base + "jpg-600" ||
      x.media.webp_1600 !== base + "webp-1600" ||
      x.media.jpg_1600 !== base + "jpg-1600"
    )
      return bad();
    media = {
      kind: "photo",
      webp_600: x.media.webp_600,
      jpg_600: x.media.jpg_600,
      webp_1600: x.media.webp_1600,
      jpg_1600: x.media.jpg_1600,
    };
  } else if (x.kind === "video" && x.media.kind === "video") {
    if (
      x.media.hls_url !== base + "hls" ||
      x.media.thumbnail_url !== base + "thumbnail" ||
      typeof x.media.duration_seconds !== "number" ||
      !Number.isFinite(x.media.duration_seconds) ||
      x.media.duration_seconds <= 0 ||
      x.media.duration_seconds > 4 ||
      x.media.mp4_url !== undefined
    )
      return bad();
    media = {
      kind: "video",
      hls_url: x.media.hls_url,
      thumbnail_url: x.media.thumbnail_url,
      duration_seconds: x.media.duration_seconds,
    };
  } else return bad();
  return {
    id: x.id,
    event_id: eventId,
    kind: x.kind,
    display_name: x.display_name,
    crown: "none",
    theme_id: x.theme_id,
    created_at: x.created_at,
    like_count: 0,
    media,
  } as PublicPost;
}
export async function handlePublicFeed(
  request: Request,
  env: PublicFeedEnv,
  fetcher: typeof fetch = fetch,
  cache: PublicFeedCache = sharedPages,
): Promise<Response> {
  if (env.KOKO_PUBLIC_FEED_ENABLED !== "true") return failure("NOT_FOUND");
  if (request.method !== "GET")
    return new Response(null, {
      status: 405,
      headers: { ...privateHeaders, allow: "GET" },
    });
  try {
    const url = new URL(request.url),
      list = url.pathname === "/feed",
      postId = list
        ? null
        : /^\/posts\/([^/]+)$/.exec(url.pathname)?.[1]?.toLowerCase();
    if ((!list && (!postId || !uuid.test(postId))) || request.body !== null)
      invalid();
    const eventId = request.headers.get("X-Event-ID")?.toLowerCase();
    if (!eventId || !uuid.test(eventId)) invalid();
    if (
      [...url.searchParams.keys()].some(
        (k) =>
          !list ||
          !["theme", "limit", "cursor"].includes(k) ||
          url.searchParams.getAll(k).length !== 1,
      )
    )
      invalid();
    const rawLimit = url.searchParams.get("limit") ?? "30",
      theme = url.searchParams.get("theme")?.toLowerCase() ?? "";
    if (
      !/^(?:[1-9][0-9]?|100)$/.test(rawLimit) ||
      (url.searchParams.has("theme") && !uuid.test(theme))
    )
      invalid();
    const limit = Number(rawLimit),
      scope = [eventId!, theme, rawLimit];
    let key: CryptoKey | null = null;
    if (list) {
      try {
        key = await ownPostsCursorKey(env.KOKO_POST_CURSOR_SECRET);
      } catch {
        bad();
      }
    }
    const before = url.searchParams.has("cursor")
      ? await readCursor(url.searchParams.get("cursor")!, key!, scope)
      : null;
    const cacheKey = JSON.stringify([
      env.SUPABASE_URL,
      ...scope,
      before?.createdAt ?? null,
      before?.id ?? null,
    ]);
    const cached = list ? cache.get(cacheKey) : null;
    const input = list
      ? {
          limit,
          ...(theme ? { theme_id: theme } : {}),
          ...(before
            ? { before_at: before.createdAt, before_id: before.id }
            : {}),
          ...(cached ? { cache: cached.proof } : {}),
        }
      : {};
    const result = await readMediaRpc(
      request,
      env,
      {
        action: list ? "feed" : "post",
        postId: postId ?? null,
        resource: null,
        input,
      },
      fetcher,
    );
    if (result.eventId !== eventId) bad();
    const value = result.value;
    if (!list) {
      const item = projectPost(value.post, eventId!);
      if (item.id !== postId) bad();
      return reply(item, 200);
    }
    let items: PublicPost[], hasMore: boolean;
    if (value.cache_valid === true) {
      if (!cached) return bad();
      items = cached.items;
      hasMore = cached.hasMore;
    } else {
      cache.delete(cacheKey);
      if (
        value.cache_valid !== false ||
        !Array.isArray(value.items) ||
        value.items.length > limit ||
        typeof value.has_more !== "boolean" ||
        (value.has_more && value.items.length !== limit) ||
        !Array.isArray(value.cache) ||
        value.cache.length !== value.items.length
      )
        return bad();
      items = value.items.map((x) => projectPost(x, eventId!));
      hasMore = value.has_more;
      const proof: CacheProof[] = value.cache.map((x, i) => {
        if (
          !object(x) ||
          x.id !== items[i]!.id ||
          typeof x.fingerprint !== "string" ||
          !/^[a-f0-9]{32}$/.test(x.fingerprint)
        )
          return bad();
        return { id: items[i]!.id, fingerprint: x.fingerprint };
      });
      let previous = before;
      const seen = new Set<string>();
      for (const item of items) {
        const position = { id: item.id, createdAt: item.created_at };
        if (
          seen.has(item.id) ||
          (theme && item.theme_id !== theme) ||
          (previous && !isAfterCursor(position, previous))
        )
          bad();
        seen.add(item.id);
        previous = position;
      }
      cache.put(cacheKey, { items, hasMore, proof });
    }
    const last = items.at(-1);
    const next_cursor =
      hasMore && last
        ? await signCursor(key!, scope, {
            id: last.id,
            createdAt: last.created_at,
          })
        : null;
    if (request.signal.aborted) bad();
    return reply({ items, next_cursor }, 200);
  } catch (error) {
    return mediaFailure(error);
  }
}
