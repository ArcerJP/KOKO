"use client";
import { useEffect, useId, useState } from "react";
import { useOperations } from "./operations-session";
import type { Theme } from "../api/operations-contract";
export type UploadThemeChoice = { id: string; endsAt: number; valid: boolean };
export const availableUploadThemes = (
  items: readonly Theme[],
  eventId: string,
  now: number,
) =>
  items.filter(
    (t) =>
      t.event_id === eventId &&
      t.status === "published" &&
      Date.parse(t.starts_at) <= now &&
      now < Date.parse(t.ends_at),
  );
export function UploadThemePicker({
  eventId,
  value,
  disabled,
  onChange,
  onInvalidate,
}: {
  eventId: string;
  value: UploadThemeChoice | null;
  disabled: boolean;
  onChange: (value: UploadThemeChoice | null) => void;
  onInvalidate: () => void;
}) {
  const { controller, state, busy } = useOperations(eventId),
    field = useId();
  const [snapshotAt, setSnapshotAt] = useState(0);
  useEffect(
    () =>
      controller.subscribe(() => {
        if (controller.getSnapshot().phase !== "ready") onInvalidate();
      }),
    [controller, onInvalidate],
  );
  const items =
    state.phase === "ready" && state.data?.kind === "themes"
      ? availableUploadThemes(state.data.items, eventId, snapshotAt)
      : [];
  const current =
    value?.valid && items.some((t) => t.id === value.id)
      ? value.id
      : value
        ? "__reselect__"
        : "";
  return (
    <section aria-label="投稿のお題">
      <h3>お題（任意）</h3>
      <p>
        選ばない場合は自由投稿です。お題を読み直した場合や期限が過ぎた場合は選び直してください。
        期間と受付可否は送信時にサーバーで最終確認します。
      </p>
      <button
        type="button"
        className="secondary"
        disabled={disabled || busy}
        onClick={() => {
          void controller.load({ name: "themes" }).then((ok) => {
            if (ok) setSnapshotAt(Date.now());
          });
        }}
      >
        開催中のお題を読み込む
      </button>
      {state.message ? (
        <p role={state.phase === "error" ? "alert" : "status"}>
          {state.message}
        </p>
      ) : null}
      <label htmlFor={field}>今回の投稿のお題</label>
      <select
        id={field}
        value={current}
        disabled={disabled || busy}
        onChange={(e) => {
          if (e.target.value === "") {
            onChange(null);
            return;
          }
          const item = items.find((t) => t.id === e.target.value);
          if (item)
            onChange({
              id: item.id,
              endsAt: Date.parse(item.ends_at),
              valid: true,
            });
        }}
      >
        {current === "__reselect__" ? (
          <option value="__reselect__" disabled>
            お題を選び直してください
          </option>
        ) : null}
        <option value="">自由投稿（お題なし）</option>
        {items.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title}
          </option>
        ))}
      </select>
      {state.phase === "ready" && items.length === 0 ? (
        <p>現在選べるお題はありません。自由投稿を利用できます。</p>
      ) : null}
      {value && !value.valid ? (
        <p role="status">
          お題の確認が切れました。お題を選び直すか、自由投稿を選んでください。
        </p>
      ) : null}
    </section>
  );
}
