/** @jsxImportSource react */
"use client";

import { isValidDisplayName } from "../../api/client";
import type { ProfileState } from "../../api/account-profile";

export function ProfileForm({
  state,
  onLoad,
  onEdit,
  onSave,
}: {
  state: ProfileState;
  onLoad: () => void;
  onEdit: (value: string) => void;
  onSave: () => void;
}) {
  const busy =
    state.phase === "loading" ||
    state.phase === "saving" ||
    state.phase === "consenting";
  const editable = state.phase === "ready" && !state.blocked;
  const valid = isValidDisplayName(state.draft);
  return (
    <section
      className="panel profile-panel"
      aria-labelledby="profile-heading"
      aria-busy={busy}
    >
      <h2 id="profile-heading">表示名</h2>
      <p className="caption">
        このイベントで使う表示名を確認・変更できます。変更は保存ボタンを押すまで送信されません。
      </p>
      <button
        type="button"
        className="secondary"
        disabled={busy || state.phase === "closed"}
        onClick={onLoad}
      >
        本人情報を読み込む
      </button>
      <p role="status" aria-live="polite">
        {busy
          ? state.phase === "consenting"
            ? "同意結果を確認中…"
            : state.phase === "saving"
              ? "保存結果を確認中…"
              : "本人情報を読込み中…"
          : !state.error
            ? state.message
            : null}
      </p>
      {state.error && (
        <p role="alert" className="warning">
          {state.message}
        </p>
      )}
      {state.displayName !== null && (
        <>
          <p>
            現在の表示名：
            <strong className="profile-name">{state.displayName}</strong>
          </p>
          {state.blocked && (
            <p className="warning">現在、このアカウントでは変更できません。</p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSave();
            }}
          >
            <label htmlFor="display-name">新しい表示名</label>
            <input
              id="display-name"
              name="display_name"
              type="text"
              value={state.draft}
              onChange={(event) => onEdit(event.target.value)}
              disabled={!editable}
              maxLength={100}
              autoComplete="off"
              aria-describedby="display-name-help"
              aria-invalid={!valid}
            />
            <p id="display-name-help" className="caption">
              1〜50文字。空白だけの名前や制御文字は使えません（現在
              {Array.from(state.draft).length}文字）。
            </p>
            <button
              type="submit"
              disabled={
                !editable || !valid || state.draft === state.displayName
              }
            >
              表示名を保存
            </button>
          </form>
        </>
      )}
    </section>
  );
}
