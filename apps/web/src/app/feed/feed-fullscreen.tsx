"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { FeedController, FeedItem } from "../../api/feed-controller";
import { FeedMedia } from "../../components/feed-media";
import { PostActions } from "../../components/post-actions";
import styles from "./feed.module.css";

export function FeedFullscreen({
  items,
  initialId,
  controller,
  onClose,
  onActive,
}: {
  items: readonly FeedItem[];
  initialId: string;
  controller: FeedController;
  onClose: () => void;
  onActive: (id: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    dialog = useRef<HTMLDivElement>(null),
    close = useRef<HTMLButtonElement>(null);
  const [selected, setSelected] = useState(initialId);
  const selectedIndex = Math.max(
    0,
    items.findIndex((item) => item.post.id === selected),
  );
  const touch = useRef<{ x: number; y: number } | null>(null);
  const activeHandler = useRef(onActive),
    closeHandler = useRef(onClose);
  useEffect(() => {
    activeHandler.current = onActive;
    closeHandler.current = onClose;
  }, [onActive, onClose]);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    close.current?.focus();
    root.current
      ?.querySelector<HTMLElement>(`[data-full-id="${initialId}"]`)
      ?.scrollIntoView({ block: "start" });
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeHandler.current();
      }
      if (event.key === "Tab") {
        const nodes = [
          ...(dialog.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),a[href],input,textarea,select,summary",
          ) ?? []),
        ].filter((node) => node.getClientRects().length > 0);
        const first = nodes[0],
          last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", key);
    };
  }, [initialId]);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const current = entries.find(
          (entry) => entry.isIntersecting && entry.intersectionRatio > 0.65,
        );
        const id = (current?.target as HTMLElement | undefined)?.dataset.fullId;
        if (id) {
          setSelected(id);
          activeHandler.current(id);
        }
      },
      { root: root.current, threshold: [0.65] },
    );
    root.current
      ?.querySelectorAll("[data-full-id]")
      .forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [items]);
  useEffect(() => {
    controller.visible(
      items
        .slice(Math.max(0, selectedIndex - 1), selectedIndex + 2)
        .map((item) => item.post.id),
    );
  }, [controller, items, selectedIndex]);
  function move(index: number) {
    const id = items[index]?.post.id;
    if (id)
      root.current
        ?.querySelector<HTMLElement>(`[data-full-id="${id}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  return (
    <div
      className={styles.overlay}
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label="投稿の全画面表示"
      onPointerDown={(event) => {
        if (
          (event.target as HTMLElement).closest(
            "button,a,input,textarea,select,summary",
          )
        )
          return;
        touch.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={(event) => {
        const start = touch.current;
        touch.current = null;
        if (
          start &&
          event.clientX - start.x < -80 &&
          Math.abs(event.clientY - start.y) < 70
        )
          onClose();
      }}
    >
      <button ref={close} className={styles.close} onClick={onClose}>
        一覧に戻る
      </button>
      <div className={styles.snap} ref={root}>
        {items.map((item, index) => {
          const nearby = Math.abs(index - selectedIndex) <= 1,
            current = index === selectedIndex;
          return (
            <article
              key={item.post.id}
              className={styles.slide}
              data-full-id={item.post.id}
              aria-label={`${item.post.display_name}さんの投稿`}
            >
              <div className={styles.fullMedia}>
                {nearby && item.validUntil > 0 ? (
                  <FeedMedia
                    post={item.post}
                    active
                    large
                    play={current}
                    sound={current}
                  />
                ) : (
                  <p>公開状態を確認中</p>
                )}
              </div>
              {current ? (
                <div className={styles.details}>
                  <p>{item.post.display_name}</p>
                  {item.post.theme_id ? (
                    <Link
                      href={`/feed?theme_id=${item.post.theme_id}`}
                      prefetch={false}
                    >
                      このお題の投稿
                    </Link>
                  ) : (
                    <p>自由投稿</p>
                  )}
                  {item.post.kind === "video" ? (
                    <p>
                      音はタップ後に再生します。端末の消音設定等により音が出ない場合があります。
                    </p>
                  ) : null}
                  <PostActions
                    eventId={item.post.event_id}
                    postId={item.post.id}
                    mode="report"
                    onCompleted={() => {
                      controller.remove(item.post.id);
                      onClose();
                    }}
                  />
                  <div className={styles.nav}>
                    <button
                      className="secondary"
                      disabled={index === 0}
                      onClick={() => move(index - 1)}
                    >
                      前の投稿
                    </button>
                    <button
                      className="secondary"
                      disabled={index === items.length - 1}
                      onClick={() => move(index + 1)}
                    >
                      次の投稿
                    </button>
                  </div>
                </div>
              ) : (
                <p>{item.post.display_name}</p>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
