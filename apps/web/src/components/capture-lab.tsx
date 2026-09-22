"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { videoTrimTargetsSeconds } from "@koko/contract";
import {
  fallbackMessages,
  isSafeDuration,
  type TrimResult,
  type TrimTarget,
} from "../media/trim-policy";
import { MediaPreview } from "./media-preview";

type Selection = { file: File; kind: "photo" | "video"; url: string };
type Candidate = {
  result: TrimResult;
  url: string | null;
  browserDuration: number | null;
};
const seconds = (value: number) => `${value.toFixed(3)} 秒`;
const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(3)} MB`;

export function CaptureLab() {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] =
    useState("写真か動画を撮影・選択してください。");
  const [checked, setChecked] = useState({
    sound: false,
    orientation: false,
    playback: false,
  });
  const abortRef = useRef<AbortController | null>(null);
  const urls = useRef(new Set<string>());

  useEffect(
    () => () => {
      abortRef.current?.abort();
      urls.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  const release = (keep?: string) => {
    for (const url of urls.current)
      if (url !== keep) {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
      }
  };
  const makeUrl = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    urls.current.add(url);
    return url;
  };
  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setMessage("処理を中止しました。元ファイルは変更していません。");
  };
  const choose = (
    event: ChangeEvent<HTMLInputElement>,
    kind: Selection["kind"],
  ) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    cancel();
    release();
    setCandidates([]);
    setChecked({ sound: false, orientation: false, playback: false });
    if (file.size === 0) {
      setSelection(null);
      setMessage("空のファイルです。撮影・選択し直してください。");
      return;
    }
    setSelection({ file, kind, url: makeUrl(file) });
    setMessage(
      kind === "photo"
        ? "写真は受け取ったFileを無変換で表示しています。"
        : "3.8秒から試せます。比較時だけ3つの目標を順に処理します。",
    );
  };
  const run = async (targets: readonly TrimTarget[]) => {
    if (!selection || selection.kind !== "video" || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    release(selection.url);
    setCandidates([]);
    setChecked({ sound: false, orientation: false, playback: false });
    setBusy(true);
    setProgress(0);
    try {
      const { runTrim } = await import("../media/worker-client");
      for (const target of targets) {
        controller.signal.throwIfAborted();
        setMessage(
          `${target.toFixed(1)}秒を処理中。データは端末内だけで扱います。`,
        );
        const result = await runTrim(
          selection.file,
          target,
          controller.signal,
          setProgress,
        );
        controller.signal.throwIfAborted();
        const candidate: Candidate = {
          result,
          url: result.status === "ready" ? makeUrl(result.blob) : null,
          browserDuration: null,
        };
        setCandidates((previous) => [...previous, candidate]);
      }
      setMessage(
        "端末内の処理が終わりました。再生・音声・向きを実機で確認してください。まだ投稿されていません。",
      );
    } catch {
      if (!controller.signal.aborted)
        setMessage("端末内の処理に失敗しました。元ファイルを保持しています。");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  };
  const reset = () => {
    cancel();
    release();
    setSelection(null);
    setCandidates([]);
    setChecked({ sound: false, orientation: false, playback: false });
    setMessage(
      "検証画面のデータをクリアしました。端末にある元ファイルは削除していません。",
    );
  };
  const download = () => {
    const report = {
      scope: "KOKO F1-2 端末内検証（公開判定・実サービス試験ではない）",
      createdAt: new Date().toISOString(),
      browser: navigator.userAgent,
      inputBytes: selection?.file.size,
      inputType: selection?.file.type,
      manualChecks: checked,
      attempts: candidates.map(({ result, browserDuration }) =>
        result.status === "ready"
          ? {
              status: result.status,
              targetSeconds: result.target,
              elapsedMs: result.elapsedMs,
              input: result.input,
              output: result.output,
              outputBytes: result.blob.size,
              browserDuration,
            }
          : result,
      ),
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "koko-capture-check.json";
    link.click();
    // ダウンロード開始前の失効を避ける。画像・動画・ファイル名・EXIFは含めない。
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <main className="shell">
      <header className="masthead">
        <span className="wordmark">
          KOKO<span className="brand-dot">.</span>
        </span>
        <span className="badge">第1要件 · 端末内検証</span>
      </header>
      <section className="intro">
        <p className="eyebrow">第49回技科大祭</p>
        <h1>撮影・トリム検証</h1>
        <p>写真はそのまま。動画は先頭から、再エンコードせずに短くします。</p>
      </section>
      <aside className="notice">
        <strong>この画面から投稿・外部送信は行いません。</strong>
        <p>
          Googleログイン・R2保存・AI判定は未接続です。再読み込みすると検証結果は消えます。
        </p>
      </aside>

      <section className="panel" aria-labelledby="capture-heading">
        <div className="section-heading">
          <span className="step">01</span>
          <h2 id="capture-heading">撮影する・選ぶ</h2>
        </div>
        <p>
          写る人の同意を得て、個人情報や位置情報の写り込みに配慮してください。検証には、人物のいない風景や物をおすすめします。
        </p>
        <div className="actions">
          <label className={`capture-button ${busy ? "disabled" : ""}`}>
            写真を撮る／選ぶ
            <input
              className="visually-hidden"
              type="file"
              accept="image/*"
              capture="environment"
              disabled={busy}
              onChange={(event) => choose(event, "photo")}
            />
          </label>
          <label
            className={`capture-button secondary ${busy ? "disabled" : ""}`}
          >
            動画を撮る／選ぶ
            <input
              className="visually-hidden"
              type="file"
              accept="video/*"
              capture="environment"
              disabled={busy}
              onChange={(event) => choose(event, "video")}
            />
          </label>
        </div>
        <p className="caption">
          スマートフォンではOSのカメラ、PCではファイル選択が開く場合があります。撮り直しは任意です。
        </p>
        <p className="status" role="status" aria-live="polite">
          {message}
        </p>
      </section>

      {selection && (
        <section className="panel" aria-labelledby="preview-heading">
          <div className="section-heading">
            <span className="step">02</span>
            <h2 id="preview-heading">
              {selection.kind === "photo" ? "写真を確認" : "原本を確認・トリム"}
            </h2>
          </div>
          <div className="preview-layout">
            <MediaPreview
              key={selection.url}
              kind={selection.kind}
              url={selection.url}
            />
            <div>
              <dl className="facts">
                <dt>元ファイル</dt>
                <dd className="filename">{selection.file.name}</dd>
                <dt>容量</dt>
                <dd>{bytes(selection.file.size)}</dd>
                <dt>形式</dt>
                <dd>{selection.file.type || "端末から形式情報なし"}</dd>
              </dl>
              <p className="caption">
                原本は変更せず保持。プレビュー非対応でも自動で圧縮しません。
              </p>
              {selection.kind === "video" && (
                <>
                  <h3>先頭からの長さ</h3>
                  <div className="target-buttons">
                    {videoTrimTargetsSeconds.map((target) => (
                      <button
                        key={target}
                        disabled={busy}
                        onClick={() => void run([target])}
                      >
                        {target.toFixed(1)}秒{target === 3.8 ? "（標準）" : ""}
                      </button>
                    ))}
                  </div>
                  <button
                    className="secondary wide"
                    disabled={busy}
                    onClick={() => void run(videoTrimTargetsSeconds)}
                  >
                    3つの長さを比較する
                  </button>
                  <p className="caption">
                    元から短い動画は延長しません。目標値と実際の出力時間は異なることがあります。
                  </p>
                </>
              )}
              {busy && (
                <>
                  <progress
                    max="1"
                    value={progress}
                    aria-label="トリム処理の進捗"
                  />
                  <button className="secondary wide" onClick={cancel}>
                    処理を中止
                  </button>
                </>
              )}
              <button className="text-button" onClick={reset}>
                画面のデータをクリア
              </button>
            </div>
          </div>
        </section>
      )}

      {candidates.length > 0 && (
        <section className="panel" aria-labelledby="result-heading">
          <div className="section-heading">
            <span className="step">03</span>
            <h2 id="result-heading">処理結果を確かめる</h2>
          </div>
          <p>
            共有前には写り込みを再確認してください。ここでの成功は公開許可ではありません。サーバー側の再計測・AI判定が別途必要です。
          </p>
          <div className="results">
            {candidates.map(({ result, url, browserDuration }) => (
              <article className="result" key={result.target}>
                <h3>目標 {result.target.toFixed(1)}秒</h3>
                {result.status === "fallback" ? (
                  <p className="warning">
                    {fallbackMessages[result.reason]} R2保存・Stream
                    clipへの切替は後続実装です。
                  </p>
                ) : (
                  <>
                    <span className="badge success">
                      再エンコードなし・トリム候補
                    </span>
                    {url && (
                      <MediaPreview
                        key={url}
                        kind="video"
                        url={url}
                        onDuration={(value) =>
                          setCandidates((previous) =>
                            previous.map((candidate) =>
                              candidate.result.target === result.target
                                ? { ...candidate, browserDuration: value }
                                : candidate,
                            ),
                          )
                        }
                      />
                    )}
                    <dl className="facts">
                      <dt>出力の実測</dt>
                      <dd>{seconds(result.output.duration)}</dd>
                      <dt>ブラウザ読取</dt>
                      <dd>
                        {browserDuration === null
                          ? "未確認／読取不可"
                          : seconds(browserDuration)}
                      </dd>
                      <dt>容量</dt>
                      <dd>{bytes(result.blob.size)}</dd>
                      <dt>映像／音声</dt>
                      <dd>
                        {result.output.video.length}／
                        {result.output.audio.length}トラック
                      </dd>
                      <dt>処理時間</dt>
                      <dd>{(result.elapsedMs / 1000).toFixed(2)}秒</dd>
                    </dl>
                    {browserDuration !== null &&
                      !isSafeDuration(browserDuration) && (
                        <p className="warning">
                          ブラウザ読取時間が上限外です。この結果は採用しないでください。
                        </p>
                      )}
                  </>
                )}
              </article>
            ))}
          </div>
          <fieldset>
            <legend>実際に再生して確認（自動判定ではありません）</legend>
            <label>
              <input
                type="checkbox"
                checked={checked.playback}
                onChange={(event) =>
                  setChecked({ ...checked, playback: event.target.checked })
                }
              />
              映像の欠け・停止がない
            </label>
            <label>
              <input
                type="checkbox"
                checked={checked.sound}
                onChange={(event) =>
                  setChecked({ ...checked, sound: event.target.checked })
                }
              />
              音声がある場合、音と映像が合う
            </label>
            <label>
              <input
                type="checkbox"
                checked={checked.orientation}
                onChange={(event) =>
                  setChecked({ ...checked, orientation: event.target.checked })
                }
              />
              縦・横の向きが原本と同じ
            </label>
          </fieldset>
          <button disabled={busy} onClick={download}>
            測定結果だけを保存（JSON）
          </button>
          <p className="caption">
            映像・写真・ファイル名は含みません。ブラウザ情報を含む測定記録を、この端末へ保存します。送信はしません。
          </p>
        </section>
      )}
      <footer>
        第49回技科大祭 KOKO · 開発用検証画面 ·
        実機確認後も、公開には別の受入れが必要です。{" "}
        <a href="/third-party-notices.txt">ライセンス・ソース入手先</a>
      </footer>
    </main>
  );
}
