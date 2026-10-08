"use client";
import { useId, useState, type FormEvent } from "react";
import { useOperations } from "../../components/operations-session";
import { validId } from "../../api/upload-contract";
import { Confirm, OperationsNotice } from "../manage/_components/controls";
import styles from "../manage/operations.module.css";

export function AppealPanel({
  eventId,
  initialPostId = "",
}: {
  eventId: string;
  initialPostId?: string;
}) {
  const { controller, state, busy } = useOperations(eventId);
  return (
    <section className="panel" aria-label="異議申立ての送信">
      <p>
        投稿の判定やBANについて、運営に確認を依頼できます。BAN中も利用できます。送信だけでBAN解除・再公開は行われません。
      </p>
      <OperationsNotice state={state} />
      <button disabled={busy} onClick={() => void controller.bootstrap()}>
        本人確認・申立てを準備
      </button>
      {state.phase === "ready" && state.data?.kind !== "ack" ? (
        <AppealForm
          initialPostId={initialPostId}
          onSubmit={(value) =>
            void controller.mutate({ name: "appeal" }, value, true)
          }
        />
      ) : null}
      {state.data?.kind === "ack" ? (
        <p>
          申立てを受け付けました。受付ID：
          <span className={styles.break}>{state.data.request_id}</span>
          。同じ内容を繰り返し送らないでください。
        </p>
      ) : null}
    </section>
  );
}

export function AppealForm({
  initialPostId,
  onSubmit,
}: {
  initialPostId: string;
  onSubmit: (value: { message: string; post_id?: string }) => void;
}) {
  const id = useId();
  const [postId, setPostId] = useState(initialPostId);
  const [message, setMessage] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!confirmed) return;
    if (
      !message.trim() ||
      [...message].length > 2000 ||
      (postId.trim() && !validId(postId.trim()))
    ) {
      setError(
        "本文と投稿IDを確認してください。投稿IDは空欄でも送信できます。",
      );
      return;
    }
    setConfirmed(false);
    setError(null);
    onSubmit({
      message: message.trim(),
      ...(postId.trim() ? { post_id: postId.trim().toLowerCase() } : {}),
    });
  }
  return (
    <form className={styles.form} onSubmit={submit}>
      <label htmlFor={`${id}-post`}>対象の投稿ID（任意）</label>
      <input
        id={`${id}-post`}
        value={postId}
        maxLength={36}
        onChange={(e) => {
          setPostId(e.target.value);
          setConfirmed(false);
        }}
      />
      <label htmlFor={`${id}-message`}>申立ての内容（2,000文字以内）</label>
      <textarea
        id={`${id}-message`}
        rows={6}
        value={message}
        maxLength={2000}
        required
        onChange={(e) => {
          setMessage(e.target.value);
          setConfirmed(false);
        }}
      />
      <p className="caption">
        確認してほしい内容を具体的に記入してください。パスワードや認証コードなどの秘密情報は記入しないでください。
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <Confirm
        checked={confirmed}
        onChange={setConfirmed}
        label="内容を確認し、運営へ送信します"
      />
      <button disabled={!confirmed || !message.trim()}>
        異議申立てを送信する
      </button>
    </form>
  );
}
