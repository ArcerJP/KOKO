/** @jsxImportSource react */
"use client";

import type { ProfileState } from "../../api/account-profile";

export function ConsentForm({
  state,
  onCheck,
  onAccept,
}: {
  state: ProfileState;
  onCheck: (checked: boolean) => void;
  onAccept: () => void;
}) {
  const doc = state.terms;
  return (
    <section className="panel consent-panel" aria-labelledby="consent-heading">
      <h2 id="consent-heading">利用規約・プライバシーポリシー</h2>
      {state.phase !== "ready" ? (
        <p className="caption">
          本人情報の読込み完了後に、現行版と同意状態を確認できます。
        </p>
      ) : !doc ? (
        <p className="warning">
          現行版に対応する正式な本文が未設定、または版が一致しないため、この画面では同意を受け付けられません。
        </p>
      ) : (
        <>
          <p className="terms-version">共通の版：{doc.version}</p>
          <h3>利用規約</h3>
          {doc.terms.map((text, index) => (
            <p className="terms-text" key={index}>
              {text}
            </p>
          ))}
          <h3>プライバシーポリシー</h3>
          {doc.privacy.map((text, index) => (
            <p className="terms-text" key={index}>
              {text}
            </p>
          ))}
          {state.blocked && (
            <p className="warning">
              同意しても、このアカウントの投稿制限は解除されません。
            </p>
          )}
          {state.consentRequired === false ? (
            <p role="status">この現行版には同意済みです。</p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                onAccept();
              }}
            >
              <label className="consent-check">
                <input
                  type="checkbox"
                  name="terms_accepted"
                  checked={state.consentChecked}
                  onChange={(event) => onCheck(event.target.checked)}
                  required
                  aria-describedby="consent-help"
                />
                <span>
                  上記の利用規約とプライバシーポリシーを確認し、この版に同意します
                </span>
              </label>
              <p id="consent-help" className="caption">
                チェックだけでは送信されません。内容を確認してから同意ボタンを押してください。
              </p>
              <button
                type="submit"
                disabled={
                  !state.consentChecked || state.consentRequired !== true
                }
              >
                この版への同意を保存
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
