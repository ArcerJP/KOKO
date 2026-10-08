"use client";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { OperationsState } from "../../../api/operations-controller";
import styles from "../operations.module.css";

export function OperationsNotice({ state }: { state: OperationsState }) {
  const message =
    state.phase === "closed"
      ? "ログイン状態が変わったため操作を停止しました。ページを開き直してください。"
      : state.phase === "loading"
        ? "本人と最新の状態を確認しています。"
        : state.phase === "saving"
          ? "操作結果を確認しています。再送しないでください。"
          : state.message;
  return (
    <p
      role={state.phase === "error" ? "alert" : "status"}
      aria-live="polite"
      className="status"
    >
      {message ?? "まだ読み込んでいません。"}
    </p>
  );
}

export function Confirm({
  checked,
  onChange,
  label = "対象と影響を確認しました",
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
}) {
  return (
    <label className={styles.check}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        required
      />
      {label}
    </label>
  );
}

/** One explicit user submission. The caller never retries ambiguous mutations. */
export function ReasonForm({
  label,
  description,
  onSubmit,
  children,
  reasonRequired = true,
}: {
  label: string;
  description?: string;
  onSubmit: (reason: string) => void;
  children?: ReactNode;
  reasonRequired?: boolean;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !confirmed ||
      (reasonRequired && (!reason.trim() || [...reason].length > 1000))
    )
      return;
    setConfirmed(false);
    onSubmit(reason.trim());
  }
  return (
    <form
      className={styles.form}
      onSubmit={submit}
      onChange={() => setConfirmed(false)}
    >
      {description ? <p className="warning">{description}</p> : null}
      {children}
      {reasonRequired ? (
        <>
          <label htmlFor={id}>操作理由</label>
          <textarea
            id={id}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setConfirmed(false);
            }}
            maxLength={1000}
            required
            rows={3}
          />
        </>
      ) : null}
      <div onChange={(e) => e.stopPropagation()}>
        <Confirm checked={confirmed} onChange={setConfirmed} />
      </div>
      <button
        type="submit"
        disabled={!confirmed || (reasonRequired && !reason.trim())}
      >
        {label}
      </button>
    </form>
  );
}

export const timeLabel = (value: string) =>
  new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
