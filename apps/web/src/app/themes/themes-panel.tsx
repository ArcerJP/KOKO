"use client";
import Link from "next/link";
import { useOperations } from "../../components/operations-session";
import type { Theme } from "../../api/operations-contract";
import { OperationsNotice, timeLabel } from "../manage/_components/controls";
import styles from "../manage/operations.module.css";

export function ThemesPanel({ eventId }: { eventId: string }) {
  const { controller, state, busy } = useOperations(eventId);
  return (
    <section className="panel" aria-label="イベントのお題">
      <p>投稿時にお題を1つ選べます。選ばない場合は自由投稿です。</p>
      <OperationsNotice state={state} />
      <button
        disabled={busy}
        onClick={() => void controller.load({ name: "themes" })}
      >
        お題を読み込む
      </button>
      {state.phase === "ready" && state.data?.kind === "themes" ? (
        <ThemesList items={state.data.items} />
      ) : null}
    </section>
  );
}
export function ThemesList({ items }: { items: Theme[] }) {
  return (
    <>
      {items.length === 0 ? (
        <p>公開中のお題はありません。自由投稿を利用できます。</p>
      ) : null}
      <div className={styles.rows}>
        {items.map((theme) => (
          <article className={styles.row} key={theme.id}>
            <span
              aria-hidden="true"
              className={styles.themeIcon}
              style={{
                borderColor: /^#[a-fA-F0-9]{6}$/.test(theme.color)
                  ? theme.color
                  : "#5b4bda",
              }}
            >
              {theme.icon}
            </span>
            <h3>{theme.title}</h3>
            <p className={styles.reason}>{theme.description}</p>
            <p>
              {theme.status === "ended" ? "終了" : "公開"}：
              {timeLabel(theme.starts_at)} 〜 {timeLabel(theme.ends_at)}
              （日本時間）
            </p>
            <p className={styles.break}>お題ID：{theme.id}</p>
            <p>
              <Link href={`/feed?theme_id=${theme.id}`} prefetch={false}>
                このお題の投稿を見る
              </Link>
            </p>
          </article>
        ))}
      </div>
    </>
  );
}
