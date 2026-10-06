"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createApiClient } from "../../api/client";
import { createFeedClient } from "../../api/feed-client";
import {
  createFeedController,
  type FeedController,
  type FeedItem,
} from "../../api/feed-controller";
import { createBrowserAuthClient } from "../../auth/browser";
import { postApiSession } from "../../auth/session-post";
import { FeedMedia } from "../../components/feed-media";
import { FeedFullscreen } from "./feed-fullscreen";
import styles from "./feed.module.css";

export function FeedPanel({
  owner,
  eventId,
  theme,
}: {
  owner: string;
  eventId: string;
  theme?: string;
}) {
  const [controller] = useState(() =>
    createFeedController(
      owner,
      eventId,
      theme,
      {
        getMe: (signal) =>
          createApiClient(new URL("/api/", location.origin), eventId).getMe(
            signal,
          ),
        list: (query, signal) =>
          createFeedClient(new URL("/api/", location.origin), eventId).list(
            query,
            signal,
          ),
        post: (id, signal) =>
          createFeedClient(new URL("/api/", location.origin), eventId).post(
            id,
            signal,
          ),
      },
      (signal) => postApiSession("/auth/api-session", signal),
    ),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getServerSnapshot,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const restore = useRef({ y: 0, id: "" });
  useEffect(() => {
    let unsubscribe: (() => void) | undefined,
      channel: BroadcastChannel | undefined;
    try {
      const { data } = createBrowserAuthClient().auth.onAuthStateChange(
        (event) => {
          if (["SIGNED_OUT", "SIGNED_IN", "USER_UPDATED"].includes(event))
            controller.close();
          else if (event !== "INITIAL_SESSION") controller.invalidate();
        },
      );
      unsubscribe = () => data.subscription.unsubscribe();
      channel = new BroadcastChannel("koko-upload-stop");
      channel.onmessage = (e: MessageEvent<unknown>) => {
        if (e.data === "stop") controller.close();
      };
    } catch {
      controller.close();
    }
    const hide = () => {
      if (document.visibilityState !== "visible") controller.invalidate();
    };
    const leave = () => controller.close();
    const resetSelection = controller.subscribe(() => {
      const current = controller.getSnapshot();
      if (["idle", "error", "closed", "loading"].includes(current.phase))
        setSelected(null);
    });
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void controller.poll();
    }, 10000);
    const expiry = setInterval(() => controller.expire(), 250);
    window.addEventListener("pagehide", leave);
    window.addEventListener("koko-upload-stop", leave);
    document.addEventListener("visibilitychange", hide);
    const pop = () => {
      const id =
        typeof history.state?.kokoFeedPost === "string"
          ? (history.state.kokoFeedPost as string)
          : null;
      setSelected(
        controller.getSnapshot().items.some((item) => item.post.id === id)
          ? id
          : null,
      );
      if (!id)
        requestAnimationFrame(() => {
          scrollTo(0, restore.current.y);
          document
            .getElementById(`feed-open-${restore.current.id}`)
            ?.focus({ preventScroll: true });
        });
    };
    window.addEventListener("popstate", pop);
    return () => {
      unsubscribe?.();
      channel?.close();
      resetSelection();
      clearInterval(poll);
      clearInterval(expiry);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("koko-upload-stop", leave);
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("popstate", pop);
      controller.invalidate();
    };
  }, [controller]);
  const active = state.items.some((item) => item.post.id === selected)
    ? selected
    : null;
  const open = (id: string) => {
    restore.current = { y: scrollY, id };
    history.pushState(
      { ...history.state, kokoFeedPost: id },
      "",
      `${location.pathname}${location.search}#post=${id}`,
    );
    setSelected(id);
  };
  const close = () => {
    if (history.state?.kokoFeedPost) history.back();
    else {
      setSelected(null);
      requestAnimationFrame(() => scrollTo(0, restore.current.y));
    }
  };
  const busy =
    state.phase === "loading" ||
    state.phase === "refreshing" ||
    state.phase === "closed";
  return (
    <section aria-label="公開投稿一覧">
      <p role={state.phase === "error" ? "alert" : "status"} aria-live="polite">
        {state.message}
      </p>
      <div className="actions">
        <button disabled={busy} onClick={() => void controller.reload()}>
          本人確認・投稿を読み込む
        </button>
        {state.nextCursor ? (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              const replaceWindow = state.items.length >= 300;
              void controller.more().then((ok) => {
                if (ok && replaceWindow) scrollTo(0, 0);
              });
            }}
          >
            {state.items.length >= 300
              ? "さらに古い投稿へ移動"
              : "続きを読み込む"}
          </button>
        ) : null}
      </div>
      {state.newCount > 0 ? (
        <button
          className={styles.new}
          onClick={() => {
            void controller.reload().then((ok) => {
              if (ok) scrollTo(0, 0);
            });
          }}
        >
          新着 {state.newCount} 件を確認・先頭へ移動
        </button>
      ) : null}
      {state.phase === "ready" && state.items.length === 0 ? (
        <p>公開中の投稿はまだありません。</p>
      ) : null}
      {state.items.length >= 300 ? (
        <p>
          一度に表示するのは最大300件です。「さらに古い投稿へ移動」で現在の表示分を置き換え、続きから閲覧できます。
        </p>
      ) : null}
      {active ? (
        <FeedFullscreen
          items={state.items}
          initialId={active}
          controller={controller}
          onClose={close}
          onActive={(id) => {
            history.replaceState(
              { ...history.state, kokoFeedPost: id },
              "",
              `${location.pathname}${location.search}#post=${id}`,
            );
          }}
        />
      ) : (
        <FeedGrid items={state.items} controller={controller} onOpen={open} />
      )}
    </section>
  );
}

function FeedGrid({
  items,
  controller,
  onOpen,
}: {
  items: readonly FeedItem[];
  controller: FeedController;
  onOpen: (id: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    [visible, setVisible] = useState<string[]>([]);
  useEffect(() => {
    const nodes = [
      ...(root.current?.querySelectorAll<HTMLElement>("[data-feed-id]") ?? []),
    ];
    const shown = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.feedId!;
          if (entry.isIntersecting && entry.intersectionRatio >= 0.1)
            shown.add(id);
          else shown.delete(id);
        }
        const ids = nodes
          .map((node) => node.dataset.feedId!)
          .filter((id) => shown.has(id));
        setVisible(ids);
        controller.visible(ids);
      },
      { threshold: [0.1, 0.5] },
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [controller, items]);
  const activeVideos = new Set(
    items
      .filter(
        (item) =>
          visible.includes(item.post.id) &&
          item.post.kind === "video" &&
          item.validUntil > 0,
      )
      .slice(0, 6)
      .map((item) => item.post.id),
  );
  return (
    <div className={styles.grid} ref={root}>
      {items.map((item) => (
        <article
          className={styles.card}
          key={item.post.id}
          data-feed-id={item.post.id}
        >
          <button
            id={`feed-open-${item.post.id}`}
            className={styles.open}
            onClick={() => onOpen(item.post.id)}
            disabled={item.validUntil <= 0}
            aria-label={`${item.post.display_name}さんの投稿を全画面で開く`}
          >
            <div className={styles.media}>
              <FeedMedia
                post={item.post}
                leaseValid={item.validUntil > 0}
                active={
                  item.post.kind === "photo"
                    ? visible.includes(item.post.id)
                    : activeVideos.has(item.post.id)
                }
              />
            </div>
          </button>
          <p className={styles.caption}>
            {item.post.display_name}
            {item.post.kind === "video" ? " · 動画" : ""}
          </p>
        </article>
      ))}
    </div>
  );
}
