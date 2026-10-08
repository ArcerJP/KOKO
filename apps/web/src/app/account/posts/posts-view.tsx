"use client";
import { errors } from "@koko/contract";
import type { OwnPost } from "../../../api/own-posts-contract";
import type { OwnPostsState } from "../../../api/own-posts-controller";
import Link from "next/link";
import { PostActions } from "../../../components/post-actions";
import { PostStateDetails } from "../../../components/post-state-details";

const labels: Record<OwnPost["status"], string> = {
  uploading: "送信中",
  upload_failed: "送信未完了",
  uploaded: "サーバー受付済み・処理待ち",
  processing: "処理中",
  published: "公開済み",
  published_flagged: "公開済み（運営確認対象）",
  blocked: "公開不可（BLOCK）",
  held: "保留",
  hidden: "非表示",
  deleted: "削除受付済み",
};
export function PostsView({
  state,
  onReload,
  onMore,
  onRefresh,
  operationsEnabled = false,
  onDeleted,
}: {
  state: OwnPostsState;
  onReload: () => void;
  onMore: () => void;
  onRefresh: (id: string) => void;
  operationsEnabled?: boolean;
  onDeleted?: () => void;
}) {
  return (
    <section className="panel" aria-labelledby="own-posts-heading">
      <h2 id="own-posts-heading">自分の投稿</h2>
      <p>この画面は投稿状態の確認用です。写真・動画そのものは表示しません。</p>
      <p role={state.phase === "error" ? "alert" : "status"} aria-live="polite">
        {state.message}
      </p>
      <div className="actions">
        <button
          disabled={state.phase === "loading" || state.phase === "closed"}
          onClick={onReload}
        >
          本人確認・先頭から読み込む
        </button>
        {state.nextCursor && (
          <button
            className="secondary"
            disabled={state.phase !== "ready"}
            onClick={onMore}
          >
            {state.items.length >= 300
              ? "さらに古い投稿へ（表示を入れ替え）"
              : "続きを読み込む"}
          </button>
        )}
      </div>
      {state.phase === "ready" && state.items.length === 0 && (
        <p>投稿はまだありません。</p>
      )}
      <p className="caption">
        最大300件ずつ表示します。さらに古い投稿へ進むと直前の表示分を入れ替えます。最新の投稿へ戻るときは先頭から読み直してください。
      </p>
      <div className="results">
        {state.items.map((post) => (
          <article
            className="result"
            key={post.id}
            aria-label={`投稿 ${post.id}`}
          >
            <h3>{labels[post.status]}</h3>
            <p className="caption">投稿ID：{post.id}</p>
            <p>
              <time dateTime={post.created_at}>
                {new Date(post.created_at).toLocaleString("ja-JP", {
                  timeZone: "Asia/Tokyo",
                })}
              </time>
              （日本時間）
            </p>
            {post.error_code && (
              <p className="warning">{errors[post.error_code].message}</p>
            )}
            <PostStateDetails post={post} />
            {["uploading", "upload_failed"].includes(post.status) && (
              <p>送信の再開は、元の端末の送信画面で確認してください。</p>
            )}
            {post.status === "deleted" && (
              <p>
                非表示の状態です。保存先からの原本削除完了を示すものではありません。
              </p>
            )}
            {["blocked", "held", "hidden"].includes(post.status) && (
              <p>
                この画面から再公開はできません。
                {operationsEnabled ? (
                  <Link href={`/appeal?post=${post.id}`} prefetch={false}>
                    この投稿について異議を申し立てる
                  </Link>
                ) : (
                  "異議申立て機能は準備中です。"
                )}
              </p>
            )}
            <button
              className="secondary"
              disabled={state.phase !== "ready"}
              onClick={() => onRefresh(post.id)}
            >
              この投稿の状態を更新
            </button>
            {operationsEnabled &&
            state.phase === "ready" &&
            post.status !== "deleted" ? (
              <PostActions
                eventId={post.event_id}
                postId={post.id}
                mode="delete-own"
                {...(onDeleted ? { onCompleted: onDeleted } : {})}
              />
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
