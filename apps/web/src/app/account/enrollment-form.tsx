/** @jsxImportSource react */
"use client";
import type { EnrollmentState } from "../../api/enrollment-controller";
import { isValidDisplayName } from "../../api/client";
export function EnrollmentForm({
  state,
  onLoad,
  onEdit,
  onEnroll,
}: {
  state: EnrollmentState;
  onLoad: () => void;
  onEdit: (name: string) => void;
  onEnroll: () => void;
}) {
  const busy = state.phase === "loading" || state.phase === "saving";
  return (
    <section
      className="panel profile-panel"
      aria-labelledby="enrollment-heading"
      aria-busy={busy}
    >
      <h2 id="enrollment-heading">初めて参加する方</h2>
      <p className="caption">
        イベントで使う表示名を登録します。登録だけでは投稿できません。続けて現行規約への同意が必要です。
      </p>
      <button
        className="secondary"
        type="button"
        disabled={busy || state.phase === "closed"}
        onClick={onLoad}
      >
        参加状況を確認する
      </button>
      <p role={state.phase === "error" ? "alert" : "status"} aria-live="polite">
        {busy ? "参加状況を確認中…" : state.message}
      </p>
      {state.phase === "ready" && !state.enrolled && state.open && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onEnroll();
          }}
        >
          <label htmlFor="enrollment-name">イベントで使う表示名</label>
          <input
            id="enrollment-name"
            name="display_name"
            value={state.draft}
            onChange={(event) => onEdit(event.target.value)}
            maxLength={100}
            autoComplete="off"
            aria-describedby="enrollment-name-help"
          />
          <p id="enrollment-name-help" className="caption">
            1〜50文字。空白だけの名前や制御文字は使えません。
          </p>
          <button type="submit" disabled={!isValidDisplayName(state.draft)}>
            この表示名で参加する
          </button>
        </form>
      )}
    </section>
  );
}
