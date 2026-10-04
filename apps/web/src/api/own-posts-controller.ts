import { isAfterCursor } from "@koko/contract";
import { ApiFailure, type Me } from "./client";
import type {
  OwnPost,
  OwnPostsPage,
  OwnPostsQuery,
} from "./own-posts-contract";
import { validId } from "./upload-contract";

export type OwnPostsState = {
  phase: "idle" | "loading" | "ready" | "error" | "closed";
  items: readonly OwnPost[];
  nextCursor: string | null;
  message: string;
};
type Client = {
  getMe(signal: AbortSignal): Promise<Me>;
  listOwnPosts(
    query: OwnPostsQuery,
    signal: AbortSignal,
  ): Promise<OwnPostsPage>;
  getPostStatus(id: string, signal: AbortSignal): Promise<OwnPost>;
};
const initial: OwnPostsState = {
  phase: "idle",
  items: [],
  nextCursor: null,
  message: "本人確認して投稿を読み込んでください。",
};
const position = (post: OwnPost) => ({
  id: post.id,
  createdAt: post.created_at,
});
export function createOwnPostsController(
  owner: string,
  eventId: string,
  client: Client,
  prepare: (signal: AbortSignal) => Promise<boolean>,
) {
  let state = initial,
    revision = 0;
  let active: AbortController | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: OwnPostsState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  function reset(phase: "idle" | "closed") {
    ++revision;
    active?.abort();
    active = null;
    publish({
      ...initial,
      phase,
      message:
        phase === "closed"
          ? "投稿情報を破棄しました。ログイン状態を確認してページを開き直してください。"
          : "投稿情報を破棄しました。本人確認して読み直してください。",
    });
  }
  async function run(kind: "reload" | "more" | "status", id?: string) {
    if (active || state.phase === "closed") return;
    const previous = state;
    if (
      kind === "more" &&
      (previous.phase !== "ready" ||
        !previous.nextCursor ||
        previous.items.length >= 300)
    )
      return;
    const selected = previous.items.find((post) => post.id === id);
    if (kind === "status" && (previous.phase !== "ready" || !selected)) return;
    const current = ++revision,
      controller = new AbortController();
    active = controller;
    publish({
      ...initial,
      phase: "loading",
      message: "本人と最新の投稿状態を確認しています…",
    });
    const check = () => {
      controller.signal.throwIfAborted();
      if (current !== revision) throw new Error("STALE_POSTS");
    };
    const verify = async () => {
      const me = await client.getMe(controller.signal);
      check();
      if (
        me.user_id.toLowerCase() !== owner ||
        me.event_id.toLowerCase() !== eventId
      )
        throw new ApiFailure("AUTH_REQUIRED");
      // BAN and missing consent restrict posting, not reading one's status.
    };
    let cancel!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error("POSTS_STOPPED"));
      controller.signal.addEventListener("abort", cancel, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      await Promise.race([
        stopped,
        (async () => {
          if (
            !validId(owner) ||
            !validId(eventId) ||
            !(await prepare(controller.signal))
          )
            throw new ApiFailure("AUTH_REQUIRED");
          check();
          await verify();
          let items: OwnPost[], nextCursor: string | null;
          if (kind === "status") {
            const fresh = await client.getPostStatus(id!, controller.signal);
            check();
            if (
              fresh.id !== selected!.id ||
              fresh.event_id !== eventId ||
              fresh.created_at !== selected!.created_at ||
              fresh.version < selected!.version
            )
              throw new ApiFailure("INTERNAL_ERROR");
            items = previous.items.map((post) =>
              post.id === id ? fresh : post,
            );
            nextCursor = previous.nextCursor;
          } else {
            const page = await client.listOwnPosts(
              {
                limit: 30,
                ...(kind === "more" ? { cursor: previous.nextCursor! } : {}),
              },
              controller.signal,
            );
            check();
            const last = previous.items.at(-1),
              first = page.items[0];
            if (
              kind === "more" &&
              ((first &&
                last &&
                !isAfterCursor(position(first), position(last))) ||
                (page.next_cursor !== null &&
                  page.next_cursor === previous.nextCursor) ||
                page.items.some((post) =>
                  previous.items.some((old) => old.id === post.id),
                ))
            )
              throw new ApiFailure("INTERNAL_ERROR");
            items =
              kind === "more" ? [...previous.items, ...page.items] : page.items;
            nextCursor = page.next_cursor;
          }
          await verify();
          check();
          publish({
            phase: "ready",
            items,
            nextCursor,
            message:
              kind === "status"
                ? "選択した投稿を更新しました。他の投稿は前回取得時点の状態です。"
                : "取得時点の投稿状態です。自動更新ではありません。",
          });
        })(),
      ]);
    } catch (error) {
      if (current === revision)
        publish({
          ...initial,
          phase: "error",
          message:
            error instanceof ApiFailure && error.code === "INVALID_CURSOR"
              ? "一覧の続きが無効または期限切れです。先頭から読み直してください。"
              : "投稿を確認できませんでした。ログイン状態を確認して、先頭から読み直してください。",
        });
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", cancel);
      controller.abort();
      if (current === revision) active = null;
    }
  }
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reload: () => run("reload"),
    more: () => run("more"),
    refresh: (id: string) => run("status", id),
    invalidate: () => {
      if (state.phase !== "closed") reset("idle");
    },
    close: () => reset("closed"),
  };
}
export type OwnPostsController = ReturnType<typeof createOwnPostsController>;
