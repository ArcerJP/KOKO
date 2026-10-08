"use client";
import { PostStateDetails } from "../../components/post-state-details";
import { useState } from "react";
import { hasPermission } from "@koko/contract";
import { useOperations } from "../../components/operations-session";
import { AdminRealtimeNotice } from "../../components/admin-realtime";
import type {
  AdminPost,
  Operation,
  OperationName,
} from "../../api/operations-contract";
import {
  OperationsNotice,
  ReasonForm,
  timeLabel,
} from "./_components/controls";
import { ThemesEditor } from "./themes-editor";
import { SettingsEditor } from "./settings-editor";
import styles from "./operations.module.css";

type Tab = "adminFeed" | "adminThemes" | "appeals" | "settings";
type Mutate = (
  op: Operation,
  input: unknown,
  confirmed: boolean,
) => Promise<boolean>;
const tabNames: Record<Tab, string> = {
  adminFeed: "投稿の監視",
  adminThemes: "お題の管理",
  appeals: "異議申立て対応",
  settings: "停止・AI設定",
};
const labels: Record<AdminPost["post"]["status"], string> = {
  uploading: "送信中",
  upload_failed: "送信未完了",
  uploaded: "受付済み",
  processing: "処理中",
  published: "公開済み",
  published_flagged: "FLAG・運営確認対象",
  blocked: "BLOCK・公開不可",
  held: "保留",
  hidden: "非表示",
  deleted: "削除受付済み",
};

export function ManagePanel({
  eventId,
  realtimeEnabled = false,
}: {
  eventId: string;
  realtimeEnabled?: boolean;
}) {
  const { controller, state, busy } = useOperations(eventId);
  const [tab, setTab] = useState<Tab>("adminFeed");
  const role = state.role;
  const canReview = role !== null && hasPermission(role, "review");
  const isAdmin = role === "admin";
  function load(next: Tab, cursor?: string) {
    setTab(next);
    void controller.load({ name: next, ...(cursor ? { cursor } : {}) });
  }
  const data = state.phase === "ready" && canReview ? state.data : null;
  return (
    <section className="panel" aria-label="運営操作">
      <p>
        毎回の本人・権限確認後に操作します。更新結果が不明なときは再送せず、一覧を読み直してください。
      </p>
      <OperationsNotice state={state} />
      <AdminRealtimeNotice
        eventId={eventId}
        enabled={realtimeEnabled}
        canReview={canReview}
      />
      <div className="actions">
        <button disabled={busy} onClick={() => load("adminFeed")}>
          本人確認・投稿を読み込む
        </button>
        {canReview ? (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => load(tab)}
          >
            現在の一覧を読み直す
          </button>
        ) : null}
      </div>
      {state.phase === "ready" && !canReview ? (
        <p role="alert">運営権限がありません。この画面では操作できません。</p>
      ) : null}
      {canReview ? (
        <p>
          現在の権限：{isAdmin ? "管理者（admin）" : "モデレーター"}
          。表示上の制限だけでなく、APIでも権限を確認します。
        </p>
      ) : null}
      {isAdmin ? (
        <nav className="actions" aria-label="管理項目">
          {(Object.keys(tabNames) as Tab[]).map((name) => (
            <button
              key={name}
              className="secondary"
              aria-pressed={tab === name}
              disabled={busy}
              onClick={() => load(name)}
            >
              {tabNames[name]}
            </button>
          ))}
        </nav>
      ) : null}
      {data?.kind === "posts" ? (
        <>
          <h2>投稿の監視</h2>
          <p>
            このページ内では通報・FLAGを先に表示します。次のページも確認してください。
          </p>
          {data.items.length === 0 ? <p>対象の投稿はありません。</p> : null}
          <div className={styles.rows}>
            {[...data.items]
              .sort(
                (a, b) =>
                  Number(b.report_count > 0) - Number(a.report_count > 0) ||
                  Number(b.post.status === "published_flagged") -
                    Number(a.post.status === "published_flagged"),
              )
              .map((item) => (
                <PostReview
                  key={`${item.post.id}:${item.post.version}`}
                  item={item}
                  isAdmin={isAdmin}
                  mutate={controller.mutate}
                />
              ))}
          </div>
          {data.next_cursor ? (
            <button
              className="secondary"
              onClick={() => load("adminFeed", data.next_cursor!)}
            >
              次の30件を読む
            </button>
          ) : null}
        </>
      ) : null}
      {data?.kind === "themes" && isAdmin ? (
        <ThemesEditor items={data.items} mutate={controller.mutate} />
      ) : null}
      {data?.kind === "settings" && isAdmin ? (
        <SettingsEditor
          key={data.settings.version}
          settings={data.settings}
          mutate={controller.mutate}
        />
      ) : null}
      {data?.kind === "appeals" && isAdmin ? (
        <>
          <h2>異議申立て対応</h2>
          <p>
            対応記録だけではBAN解除や再公開は行いません。必要な操作は別に確認して実行してください。
          </p>
          {data.items.length === 0 ? <p>申立てはありません。</p> : null}
          <div className={styles.rows}>
            {data.items.map((item) => (
              <article
                className={styles.row}
                key={item.id}
                aria-label={`申立て ${item.id}`}
              >
                <h3>
                  {item.status === "open"
                    ? "未対応"
                    : item.status === "resolved"
                      ? "対応済み"
                      : "却下"}
                </h3>
                <p>受付：{timeLabel(item.created_at)}（日本時間）</p>
                <p>申立てID：{item.id}</p>
                <p>利用者ID：{item.user_id}</p>
                {item.post_id ? <p>投稿ID：{item.post_id}</p> : null}
                <p className={styles.reason}>{item.message}</p>
                {item.status === "open" ? (
                  <AppealResolution id={item.id} mutate={controller.mutate} />
                ) : null}
              </article>
            ))}
          </div>
          {data.next_cursor ? (
            <button
              className="secondary"
              onClick={() => load("appeals", data.next_cursor!)}
            >
              次の申立てを読む
            </button>
          ) : null}
        </>
      ) : null}
      {data?.kind === "ack" ? (
        <p>
          受付ID：<span className={styles.break}>{data.request_id}</span>
          。最新の状態を読み直して確認してください。
        </p>
      ) : null}
    </section>
  );
}

export function PostReview({
  item,
  isAdmin,
  mutate,
}: {
  item: AdminPost;
  isAdmin: boolean;
  mutate: Mutate;
}) {
  const { post } = item;
  const [action, setAction] = useState<OperationName>("hide");
  const [themeId, setThemeId] = useState("");
  const actions: [OperationName, string][] = [];
  if (["published", "published_flagged"].includes(post.status))
    actions.push(["hide", "非表示にする"]);
  if (post.status === "hidden" && !item.is_banned)
    actions.push(["restore", "確認済みの判定へ復帰"]);
  if (post.status !== "deleted")
    actions.push(["deletePost", "削除を受け付ける"]);
  if (isAdmin && ["held", "blocked"].includes(post.status) && !item.is_banned)
    actions.push(["retry", "AI再処理を予約"]);
  const processing = ["uploading", "uploaded", "processing"].includes(
    post.status,
  );
  if (isAdmin && !processing && post.status !== "deleted")
    actions.push(["reassignTheme", "お題を付け替える・解除"]);
  const selected = actions.some(([name]) => name === action)
    ? action
    : actions[0]?.[0];
  const label = actions.find(([name]) => name === selected)?.[1];
  const safeMedia =
    ["published", "published_flagged", "hidden"].includes(post.status) &&
    !item.is_banned;
  return (
    <article className={styles.row} aria-label={`投稿 ${post.id}`}>
      <h3>{labels[post.status]}</h3>
      <p>
        投稿ID：{post.id} / 更新世代：{post.version}
      </p>
      <p>利用者ID：{item.user_id}</p>
      <p>
        通報：{item.report_count} 件 {item.is_banned ? "・BAN中" : ""}
      </p>
      <p>投稿日時：{timeLabel(post.created_at)}（日本時間）</p>
      <PostStateDetails post={post} />
      {isAdmin && processing ? (
        <p>
          アップロード・判定処理中のお題変更はできません。処理結果を確認してから変更してください。
        </p>
      ) : null}
      {safeMedia && item.preview_url ? (
        <p>
          <a href={item.preview_url} target="_blank" rel="noopener noreferrer">
            確認用画像を開く
          </a>
        </p>
      ) : null}
      {safeMedia ? (
        <p>
          <a
            href={`/api/admin/posts/${post.id}/original?expected_version=${post.version}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            この投稿の保存原本を個別取得
          </a>
        </p>
      ) : null}
      {post.status === "deleted" ? (
        <p>
          新規配信は停止しています。原本の物理削除完了を示すものではありません。
        </p>
      ) : null}
      {selected ? (
        <details className={styles.details}>
          <summary>投稿への操作</summary>
          <label className={styles.form}>
            操作を選択
            <select
              value={selected}
              onChange={(e) => setAction(e.target.value as OperationName)}
            >
              {actions.map(([name, title]) => (
                <option key={name} value={name}>
                  {title}
                </option>
              ))}
            </select>
          </label>
          <ReasonForm
            key={selected}
            label={label!}
            description="理由と更新世代を送信します。古い状態に対する操作は拒否されます。削除は元に戻せません。BLOCKの直接公開はできません。"
            onSubmit={(reason) =>
              void mutate(
                { name: selected, id: post.id },
                {
                  expected_version: post.version,
                  reason,
                  ...(selected === "reassignTheme"
                    ? { theme_id: themeId.trim() || null }
                    : {}),
                },
                true,
              )
            }
          >
            {selected === "reassignTheme" ? (
              <ThemeChoice
                eventId={post.event_id}
                value={themeId}
                onChange={setThemeId}
              />
            ) : null}
          </ReasonForm>
        </details>
      ) : null}
      {isAdmin ? (
        <details className={styles.details}>
          <summary>
            {item.is_banned ? "この利用者のBAN解除" : "この利用者をBAN"}
          </summary>
          <ReasonForm
            label={item.is_banned ? "BANを解除する" : "BANを実行する"}
            description="BANは過去投稿も非公開にします。解除だけで過去投稿は再公開されません。"
            onSubmit={(reason) =>
              void mutate(
                { name: item.is_banned ? "unban" : "ban", id: item.user_id },
                { reason },
                true,
              )
            }
          />
        </details>
      ) : null}
    </article>
  );
}

function ThemeChoice({
  eventId,
  value,
  onChange,
}: {
  eventId: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { controller, state, busy } = useOperations(eventId);
  return (
    <div>
      <p>
        未選択はお題の解除です。付け替える場合は一覧を確認して選択してください。
      </p>
      <button
        className="secondary"
        type="button"
        disabled={busy}
        onClick={() => void controller.load({ name: "adminThemes" })}
      >
        選択できるお題を読む
      </button>
      {state.phase === "error" ? (
        <p role="alert">
          お題を取得できませんでした。付け替え操作は送らず読み直してください。
        </p>
      ) : null}
      {state.phase === "ready" &&
      state.role === "admin" &&
      state.data?.kind === "themes" ? (
        <label>
          付け替え先のお題
          <select value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">選択なし（解除）</option>
            {state.data.items.map((theme) => (
              <option value={theme.id} key={theme.id}>
                {theme.title}（
                {theme.status === "draft"
                  ? "下書き"
                  : theme.status === "ended"
                    ? "終了"
                    : "公開"}
                ）
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

function AppealResolution({ id, mutate }: { id: string; mutate: Mutate }) {
  const [status, setStatus] = useState("resolved");
  return (
    <ReasonForm
      key={status}
      label="対応結果を記録"
      onSubmit={(reason) =>
        void mutate({ name: "resolveAppeal", id }, { status, reason }, true)
      }
    >
      <label>
        対応結果
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="resolved">対応済み</option>
          <option value="rejected">却下</option>
        </select>
      </label>
    </ReasonForm>
  );
}
