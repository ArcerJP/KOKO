import { isAfterCursor } from "@koko/contract";
import { ApiFailure, type Me } from "./client";
import { validId } from "./upload-contract";
import type { FeedPage, FeedQuery, PublicPost } from "./feed-contract";

export type FeedItem = { post: PublicPost; validUntil: number };
export type FeedState = {
  phase: "idle" | "loading" | "ready" | "refreshing" | "error" | "closed";
  items: readonly FeedItem[];
  nextCursor: string | null;
  newCount: number;
  message: string;
};
const initial: FeedState = {
  phase: "idle",
  items: [],
  nextCursor: null,
  newCount: 0,
  message: "本人確認して投稿を読み込んでください。",
};
type Client = {
  getMe(signal: AbortSignal): Promise<Me>;
  list(query: FeedQuery, signal: AbortSignal): Promise<FeedPage>;
  post(id: string, signal: AbortSignal): Promise<PublicPost>;
};
const position = (post: PublicPost) => ({
  id: post.id,
  createdAt: post.created_at,
});
/** View leases are not authorization. Every image/HLS resource is separately authorized by the API. */
export function createFeedController(
  owner: string,
  eventId: string,
  theme: string | undefined,
  client: Client,
  prepare: (signal: AbortSignal) => Promise<boolean>,
  clock = Date.now,
) {
  let state = initial,
    revision = 0,
    active: AbortController | null = null,
    role: Me["role"] | null = null;
  let visible: string[] = [],
    pendingVisible = false;
  const listeners = new Set<() => void>();
  const publish = (next: FeedState) => {
    state = next;
    listeners.forEach((cb) => cb());
  };
  const invalidate = (closed: boolean) => {
    revision++;
    active?.abort();
    active = null;
    role = null;
    visible = [];
    pendingVisible = false;
    publish({
      ...initial,
      phase: closed ? "closed" : "idle",
      message: closed
        ? "ログイン状態が変わったため表示を終了しました。開き直してください。"
        : "表示を破棄しました。本人確認して読み直してください。",
    });
  };
  async function run(
    kind: "reload" | "more" | "poll" | "media",
    mediaId?: string,
  ): Promise<boolean> {
    if (active || state.phase === "closed") return false;
    if (kind !== "reload" && state.phase !== "ready") return false;
    if (kind === "more" && !state.nextCursor) return false;
    if (
      kind === "media" &&
      (!mediaId ||
        !validId(mediaId) ||
        !state.items.some((item) => item.post.id === mediaId))
    )
      return false;
    const replaceWindow = kind === "more" && state.items.length >= 300;
    const previous = state,
      current = ++revision,
      abort = new AbortController(),
      started = clock();
    active = abort;
    pendingVisible = false;
    publish(
      kind === "reload"
        ? {
            ...initial,
            phase: "loading",
            message: "本人と投稿を確認しています。",
          }
        : { ...previous, phase: "refreshing" },
    );
    const check = () => {
      abort.signal.throwIfAborted();
      if (revision !== current) throw new Error("STALE");
    };
    const verify = async () => {
      const me = await client.getMe(abort.signal);
      check();
      if (
        !validId(owner) ||
        !validId(eventId) ||
        me.user_id !== owner ||
        me.event_id !== eventId ||
        (role !== null && me.role !== role)
      )
        throw new ApiFailure("AUTH_REQUIRED");
      if (me.is_banned) throw new ApiFailure("ACCOUNT_BANNED");
      if (me.consent_required) throw new ApiFailure("CONSENT_REQUIRED");
      role = me.role;
    };
    const query: FeedQuery = {
      limit:
        kind === "more" && !replaceWindow
          ? Math.min(30, 300 - previous.items.length)
          : 30,
      ...(theme ? { theme } : {}),
      ...(kind === "more" ? { cursor: previous.nextCursor! } : {}),
    };
    const timer = setTimeout(() => abort.abort(), 10000);
    let cancel = () => {};
    try {
      return await Promise.race([
        new Promise<never>((_, reject) => {
          cancel = () => reject(new Error("ABORTED"));
          abort.signal.addEventListener("abort", cancel, { once: true });
        }),
        (async () => {
          if (!(await prepare(abort.signal)))
            throw new ApiFailure("AUTH_REQUIRED");
          check();
          await verify();
          const page =
            kind === "media"
              ? {
                  items: [await client.post(mediaId!, abort.signal)],
                  next_cursor: previous.nextCursor,
                }
              : await client.list(query, abort.signal);
          check();
          if (page.items.length > query.limit!)
            throw new ApiFailure("INVALID_CURSOR");
          let items: FeedItem[],
            nextCursor = previous.nextCursor,
            newCount = 0;
          const leased = (post: PublicPost): FeedItem => ({
            post,
            validUntil: started + 10000,
          });
          if (kind === "media") {
            const post = page.items[0]!;
            if (
              post.id !== mediaId ||
              post.event_id !== eventId ||
              (theme && post.theme_id !== theme)
            )
              throw new ApiFailure("NOT_FOUND");
            items = previous.items.map((item) =>
              item.post.id === mediaId ? leased(post) : item,
            );
            newCount = previous.newCount;
          } else if (kind === "reload") {
            items = page.items.map(leased);
            nextCursor = page.next_cursor;
          } else if (kind === "more") {
            const last = previous.items.at(-1)?.post,
              first = page.items[0];
            if (
              (last &&
                first &&
                !isAfterCursor(position(first), position(last))) ||
              (page.next_cursor !== null &&
                page.next_cursor === previous.nextCursor) ||
              page.items.some((p) =>
                previous.items.some((old) => old.post.id === p.id),
              )
            )
              throw new ApiFailure("INVALID_CURSOR");
            items = replaceWindow
              ? page.items.map(leased)
              : [...previous.items, ...page.items.map(leased)];
            nextCursor = page.next_cursor;
            newCount = previous.newCount;
          } else {
            const updates = new Map(page.items.map((p) => [p.id, leased(p)]));
            const known = new Set(previous.items.map((p) => p.post.id));
            newCount = page.items.filter((p) => !known.has(p.id)).length;
            const missing = visible.filter(
              (id) => known.has(id) && !updates.has(id),
            );
            const removed = new Set<string>();
            // At most four reads concurrently; only visible metadata, never preload all 300 items.
            for (let n = 0; n < missing.length; n += 4) {
              await Promise.all(
                missing.slice(n, n + 4).map(async (id) => {
                  try {
                    const post = await client.post(id, abort.signal);
                    check();
                    if (theme && post.theme_id !== theme) removed.add(id);
                    else updates.set(id, leased(post));
                  } catch (error) {
                    check();
                    if (
                      error instanceof ApiFailure &&
                      error.code === "NOT_FOUND"
                    )
                      removed.add(id);
                    else throw error;
                  }
                }),
              );
            }
            items = previous.items
              .filter((item) => !removed.has(item.post.id))
              .map((item) => updates.get(item.post.id) ?? item);
          }
          await verify();
          check();
          publish({
            phase: "ready",
            items,
            nextCursor,
            newCount,
            message: replaceWindow
              ? "さらに古い投稿へ移動しました。直前の表示分は破棄し、最大300件ずつ表示します。"
              : newCount
                ? "新しい投稿があります。表示位置はそのままです。"
                : "取得時点の公開投稿です。",
          });
          return true;
        })(),
      ]);
    } catch (error) {
      if (revision === current) {
        role = null;
        publish({
          ...initial,
          phase: "error",
          message:
            error instanceof ApiFailure
              ? error.message
              : "公開状態を確認できませんでした。表示を停止しました。読み直してください。",
        });
      }
      return false;
    } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener("abort", cancel);
      abort.abort();
      if (revision === current) {
        active = null;
        if (pendingVisible && state.phase === "ready") {
          pendingVisible = false;
          void run("poll");
        }
      }
    }
  }
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    reload: () => run("reload"),
    more: () => run("more"),
    poll: () => run("poll"),
    retryMedia: (id: string) => run("media", id),
    visible(ids: readonly string[]) {
      const next = [...new Set(ids.filter(validId))].slice(0, 30).sort();
      if (JSON.stringify(next) === JSON.stringify(visible)) return;
      visible = next;
      if (
        !visible.some((id) =>
          state.items.some(
            (item) => item.post.id === id && item.validUntil <= clock(),
          ),
        )
      )
        return;
      if (active) pendingVisible = true;
      else void run("poll");
    },
    expire() {
      if (
        state.items.some(
          (item) => item.validUntil > 0 && item.validUntil <= clock(),
        )
      )
        publish({
          ...state,
          items: state.items.map((item) =>
            item.validUntil <= clock() ? { ...item, validUntil: 0 } : item,
          ),
        });
    },
    remove(id: string) {
      // A completed report must not be undone by an older in-flight feed response.
      revision++;
      active?.abort();
      active = null;
      pendingVisible = false;
      visible = visible.filter((value) => value !== id);
      publish({
        ...state,
        phase: state.phase === "refreshing" ? "ready" : state.phase,
        items: state.items.filter((item) => item.post.id !== id),
      });
    },
    invalidate() {
      if (state.phase !== "closed") invalidate(false);
    },
    close() {
      invalidate(true);
    },
  };
}
export type FeedController = ReturnType<typeof createFeedController>;
