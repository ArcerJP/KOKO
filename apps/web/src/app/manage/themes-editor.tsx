"use client";
import { useId, useState, type FormEvent } from "react";
import {
  operationInput,
  type Operation,
  type Theme,
  type ThemeInput,
} from "../../api/operations-contract";
import { Confirm, ReasonForm, timeLabel } from "./_components/controls";
import styles from "./operations.module.css";
type Mutate = (
  op: Operation,
  input: unknown,
  confirmed: boolean,
) => Promise<boolean>;

export function ThemesEditor({
  items,
  mutate,
}: {
  items: Theme[];
  mutate: Mutate;
}) {
  return (
    <section aria-label="お題の管理">
      <h2>お題の管理</h2>
      <p>
        時刻は日本時間（JST）で入力します。公開・終了状態と期間を確認してください。
      </p>
      <details className={styles.details}>
        <summary>新しいお題を作成</summary>
        <ThemeForm
          onSave={(value) => void mutate({ name: "createTheme" }, value, true)}
        />
      </details>
      {items.length === 0 ? <p>お題はありません。</p> : null}
      <div className={styles.rows}>
        {items.map((theme) => (
          <article className={styles.row} key={theme.id}>
            <h3>{theme.title}</h3>
            <p className={styles.break}>お題ID：{theme.id}</p>
            <p>
              {theme.status === "draft"
                ? "下書き"
                : theme.status === "published"
                  ? "公開"
                  : "終了"}{" "}
              / {timeLabel(theme.starts_at)} 〜 {timeLabel(theme.ends_at)}
              （日本時間）
            </p>
            <details className={styles.details}>
              <summary>お題を編集</summary>
              <ThemeForm
                initial={theme}
                onSave={(value) =>
                  void mutate(
                    { name: "updateTheme", id: theme.id },
                    value,
                    true,
                  )
                }
              />
            </details>
            <details className={styles.details}>
              <summary>お題を削除</summary>
              <ReasonForm
                label="お題を削除する"
                reasonRequired={false}
                description="削除後の関連投稿はサーバー側の条件に従います。戻せない操作です。"
                onSubmit={() =>
                  void mutate({ name: "deleteTheme", id: theme.id }, {}, true)
                }
              />
            </details>
          </article>
        ))}
      </div>
    </section>
  );
}

function localJst(value?: string) {
  return value
    ? new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 16)
    : "";
}
export function ThemeForm({
  initial,
  onSave,
}: {
  initial?: Theme;
  onSave: (value: ThemeInput) => void;
}) {
  const id = useId();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "");
  const [color, setColor] = useState(initial?.color ?? "#5b4bda");
  const [status, setStatus] = useState<ThemeInput["status"]>(
    initial?.status ?? "draft",
  );
  const [start, setStart] = useState(localJst(initial?.starts_at));
  const [end, setEnd] = useState(localJst(initial?.ends_at));
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!confirmed) return;
    try {
      const value: ThemeInput = {
        title: title.trim(),
        description,
        icon,
        color,
        status,
        starts_at: new Date(`${start}:00+09:00`).toISOString(),
        ends_at: new Date(`${end}:00+09:00`).toISOString(),
      };
      operationInput({ name: "createTheme" }, value);
      setError(null);
      setConfirmed(false);
      onSave(value);
    } catch {
      setError(
        "名称・色・期間を確認してください。終了は開始より後にしてください。",
      );
    }
  }
  return (
    <form
      className={styles.form}
      onSubmit={submit}
      onChange={() => setConfirmed(false)}
    >
      <label htmlFor={`${id}-title`}>お題の名称</label>
      <input
        id={`${id}-title`}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={100}
        required
      />
      <label htmlFor={`${id}-description`}>説明</label>
      <textarea
        id={`${id}-description`}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        maxLength={2000}
        rows={3}
      />
      <label htmlFor={`${id}-icon`}>アイコン（文字・絵文字）</label>
      <input
        id={`${id}-icon`}
        value={icon}
        onChange={(e) => setIcon(e.target.value)}
        maxLength={50}
      />
      <label htmlFor={`${id}-color`}>色</label>
      <input
        id={`${id}-color`}
        type="color"
        value={color}
        onChange={(e) => setColor(e.target.value)}
      />
      <label htmlFor={`${id}-status`}>状態</label>
      <select
        id={`${id}-status`}
        value={status}
        onChange={(e) => setStatus(e.target.value as ThemeInput["status"])}
      >
        <option value="draft">下書き</option>
        <option value="published">公開</option>
        <option value="ended">終了</option>
      </select>
      <label htmlFor={`${id}-start`}>開始（日本時間）</label>
      <input
        id={`${id}-start`}
        type="datetime-local"
        value={start}
        onChange={(e) => setStart(e.target.value)}
        required
      />
      <label htmlFor={`${id}-end`}>終了（日本時間）</label>
      <input
        id={`${id}-end`}
        type="datetime-local"
        value={end}
        onChange={(e) => setEnd(e.target.value)}
        required
      />
      {error ? <p role="alert">{error}</p> : null}
      <div onChange={(e) => e.stopPropagation()}>
        <Confirm checked={confirmed} onChange={setConfirmed} />
      </div>
      <button disabled={!confirmed || !title.trim() || !start || !end}>
        お題を保存する
      </button>
    </form>
  );
}
