"use client";
import { useId, useState, type FormEvent } from "react";
import { useOperations } from "./operations-session";
import { validId } from "../api/upload-contract";
import { Confirm, OperationsNotice } from "../app/manage/_components/controls";
import styles from "../app/manage/operations.module.css";

type Props = {
  eventId: string;
  postId: string;
  mode: "report" | "delete-own";
  onCompleted?: () => void;
};
export function PostActions(props: Props) {
  if (!validId(props.eventId) || !validId(props.postId)) return null;
  return (
    <PostActionsSession
      key={`${props.eventId}:${props.postId}:${props.mode}`}
      {...props}
    />
  );
}
function PostActionsSession({ eventId, postId, mode, onCompleted }: Props) {
  const { controller, state, busy } = useOperations(eventId);
  const label = mode === "report" ? "この投稿を通報" : "自分の投稿を削除";
  const done = state.phase === "ready" && state.data?.kind === "ack";
  return (
    <details className={styles.details}>
      <summary>{label}</summary>
      <OperationsNotice state={state} />
      <button
        className="secondary"
        disabled={busy || done}
        onClick={() => void controller.bootstrap()}
      >
        本人確認・操作を準備
      </button>
      {state.phase === "ready" && !done ? (
        <PostActionForm
          mode={mode}
          onSubmit={async (input) => {
            const ok = await controller.mutate(
              { name: mode === "report" ? "report" : "deleteOwn", id: postId },
              input,
              true,
            );
            if (ok) onCompleted?.();
          }}
        />
      ) : null}
      {done ? (
        <p role="status">
          {mode === "report"
            ? "通報を受け付けました。運営が確認します。"
            : "削除を受け付けました。新規配信を停止します。原本の物理削除完了とは別です。"}
        </p>
      ) : null}
    </details>
  );
}
export function PostActionForm({
  mode,
  onSubmit,
}: {
  mode: Props["mode"];
  onSubmit: (input: Record<string, string>) => void;
}) {
  const id = useId();
  const [reason, setReason] = useState("privacy");
  const [detail, setDetail] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!confirmed) return;
    setConfirmed(false);
    onSubmit(mode === "report" ? { reason, detail } : {});
  }
  return (
    <form className={styles.form} onSubmit={submit}>
      {mode === "report" ? (
        <>
          <label htmlFor={`${id}-reason`}>通報の理由</label>
          <select
            id={`${id}-reason`}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setConfirmed(false);
            }}
          >
            <option value="privacy">プライバシー・写り込み</option>
            <option value="sexual">性的な内容</option>
            <option value="violence">暴力的な内容</option>
            <option value="harassment">嫌がらせ</option>
            <option value="other">その他</option>
          </select>
          <label htmlFor={`${id}-detail`}>補足（任意・1,000文字以内）</label>
          <textarea
            id={`${id}-detail`}
            value={detail}
            onChange={(e) => {
              setDetail(e.target.value);
              setConfirmed(false);
            }}
            maxLength={1000}
            rows={3}
          />
          <p>
            通報後は運営の確認まで非表示となります。同じ人からの重複通報は加算しません。
          </p>
        </>
      ) : (
        <p className="warning">
          本人の投稿を削除し、新規配信を停止します。操作は戻せません。BAN中も本人削除は可能です。
        </p>
      )}
      <Confirm checked={confirmed} onChange={setConfirmed} />
      <button disabled={!confirmed}>
        {mode === "report" ? "通報を送信する" : "本人の投稿を削除する"}
      </button>
    </form>
  );
}
