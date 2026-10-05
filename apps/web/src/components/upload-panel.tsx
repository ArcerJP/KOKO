"use client";

import {
  useEffect,
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
} from "react";
import { errors, videoTrimTargetsSeconds } from "@koko/contract";
import { MediaPreview } from "./media-preview";
import {
  fallbackMessages,
  isSafeDuration,
  type TrimResult,
  type TrimTarget,
} from "../media/trim-policy";
import type { UploadQueue } from "../media/upload-queue";
import type { UploadRequest } from "../api/upload-contract";
import { validId } from "../api/upload-contract";
import {
  UploadThemePicker,
  type UploadThemeChoice,
} from "./upload-theme-picker";

const notice =
  "写る人の同意を得て、個人情報・位置情報・著作権に配慮してください。危険な行為や不適切な内容は投稿できません。";
type Draft = {
  id: string;
  kind: "photo" | "video";
  file: File;
  url: string;
  result: TrimResult | null;
  previewUrl: string | null;
  duration: number | null;
};
export function UploadPanel({
  queue,
  eventId,
  themesEnabled = false,
}: {
  queue: UploadQueue;
  eventId?: string;
  themesEnabled?: boolean;
}) {
  const state = useSyncExternalStore(
    queue.subscribe,
    queue.getSnapshot,
    queue.getServerSnapshot,
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [theme, setTheme] = useState<UploadThemeChoice | null>(null);
  const invalidateTheme = useCallback(
    () =>
      setTheme((previous) =>
        previous?.valid ? { ...previous, valid: false } : previous,
      ),
    [],
  );
  const allowThemes = themesEnabled && validId(eventId);
  const operation = useRef<AbortController | null>(null);
  const urls = useRef(new Set<string>());
  const submitting = useRef(false);
  const release = () => {
    urls.current.forEach((url) => URL.revokeObjectURL(url));
    urls.current.clear();
  };
  const objectUrl = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    urls.current.add(url);
    return url;
  };
  useEffect(() => {
    const stop = () => {
      operation.current?.abort();
      release();
      setDraft(null);
      setBusy(false);
      setTheme(null);
    };
    const unsubscribe = queue.subscribe(() => {
      if (!queue.getSnapshot().ready) stop();
    });
    return () => {
      unsubscribe();
      operation.current?.abort();
      release();
    };
  }, [queue]);
  function choose(
    event: ChangeEvent<HTMLInputElement>,
    kind: "photo" | "video",
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    operation.current?.abort();
    release();
    setDraft(null);
    setMessage("");
    if (!file.size) {
      setMessage("空のファイルは送信できません。");
      return;
    }
    setDraft({
      id: crypto.randomUUID(),
      kind,
      file,
      url: objectUrl(file),
      result: null,
      previewUrl: null,
      duration: null,
    });
  }
  async function trim(target: TrimTarget) {
    if (!draft || busy || submitting.current) return;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setMessage("端末内で動画を短くしています…");
    try {
      const { runTrim } = await import("../media/worker-client");
      const result = await runTrim(
        draft.file,
        target,
        controller.signal,
        () => {},
      );
      controller.signal.throwIfAborted();
      if (draft.previewUrl) {
        URL.revokeObjectURL(draft.previewUrl);
        urls.current.delete(draft.previewUrl);
      }
      setDraft({
        ...draft,
        id: crypto.randomUUID(),
        result,
        previewUrl: result.status === "ready" ? objectUrl(result.blob) : null,
        duration: null,
      });
      setMessage(
        result.status === "ready"
          ? "処理結果を再生して確認してください。まだ送信していません。"
          : `${fallbackMessages[result.reason]} 送信すると全長原本を保存し、サーバー側の短縮処理を待ちます。`,
      );
    } catch {
      if (!controller.signal.aborted)
        setMessage("端末内の処理に失敗しました。再試行してください。");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function submit() {
    if (!draft || !state.ready || busy || submitting.current) return;
    if (theme && (!allowThemes || !theme.valid || theme.endsAt <= Date.now())) {
      invalidateTheme();
      setMessage(
        "お題を確認できません。開催中のお題を選び直すか、自由投稿を選んでください。",
      );
      return;
    }
    if (
      draft.kind === "video" &&
      (!draft.result ||
        (draft.result.status === "ready" &&
          (!isSafeDuration(draft.result.output.duration) ||
            draft.duration === null ||
            !isSafeDuration(draft.duration))))
    )
      return;
    submitting.current = true;
    setBusy(true);
    const blob =
      draft.result?.status === "ready" ? draft.result.blob : draft.file;
    const request: UploadRequest = {
      client_request_id: draft.id,
      kind: draft.kind,
      file_size_bytes: blob.size,
      content_type: blob.type || "application/octet-stream",
      original_scope:
        draft.kind === "photo"
          ? "photo_file"
          : draft.result?.status === "ready"
            ? "client_trimmed"
            : "full_video_fallback",
      theme_id: theme?.id ?? null,
    };
    try {
      if (await queue.enqueue(blob, request)) {
        release();
        setDraft(null);
        setMessage("");
        setTheme(null);
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const canSubmit =
    state.ready &&
    !busy &&
    (!theme || theme.valid) &&
    draft &&
    (draft.kind === "photo" ||
      (draft.result &&
        (draft.result.status === "fallback" ||
          (isSafeDuration(draft.result.output.duration) &&
            draft.duration !== null &&
            isSafeDuration(draft.duration)))));
  return (
    <>
      <aside className="notice">
        <strong>
          送信ボタンを押すと、写真・動画をこの端末に保存し、KOKOへ送ります。
        </strong>
        <p>
          共用端末には保存分が残ります。完了後は原本を端末のキューから除去します。端末の故障・ブラウザのデータ消去に備え、元ファイルを残してください。
        </p>
      </aside>
      <section className="panel" aria-labelledby="upload-capture">
        <h2 id="upload-capture">撮影・プレビュー</h2>
        <p>{notice}</p>
        {allowThemes ? (
          <UploadThemePicker
            eventId={eventId}
            value={theme}
            disabled={!state.ready || busy}
            onChange={setTheme}
            onInvalidate={invalidateTheme}
          />
        ) : null}
        <div className="actions">
          {(["photo", "video"] as const).map((kind) => (
            <label
              className={`capture-button ${!state.ready || busy ? "disabled" : ""}`}
              key={kind}
            >
              {kind === "photo"
                ? "投稿する写真を撮る／選ぶ"
                : "投稿する動画を撮る／選ぶ"}
              <input
                className="visually-hidden"
                type="file"
                accept={kind === "photo" ? "image/*" : "video/*"}
                capture="environment"
                disabled={!state.ready || busy}
                onChange={(event) => choose(event, kind)}
              />
            </label>
          ))}
        </div>
        <p className="caption">
          {notice}{" "}
          縦向きがおすすめです。横向きも余白付きで扱います。撮り直しは任意です。
        </p>
        {draft && (
          <div className="upload-preview">
            <MediaPreview
              key={draft.previewUrl ?? draft.url}
              kind={draft.kind}
              url={draft.previewUrl ?? draft.url}
              onDuration={(duration) =>
                setDraft((previous) =>
                  previous?.id === draft.id
                    ? { ...previous, duration }
                    : previous,
                )
              }
            />
            {draft.kind === "video" && (
              <div className="target-buttons">
                {videoTrimTargetsSeconds.map((target) => (
                  <button
                    key={target}
                    disabled={busy}
                    onClick={() => void trim(target)}
                  >
                    {target.toFixed(1)}秒{target === 3.8 ? "（標準）" : ""}
                  </button>
                ))}
              </div>
            )}
            <p>
              {notice}{" "}
              内容と音声を確認してください。サーバーでの再計測・判定が終わるまで公開されません。
            </p>
            {draft.result?.status === "fallback" && (
              <p className="warning">
                この動画は全長の原本を送ります。短縮処理が終わるまで公開しません。
              </p>
            )}
            <div className="actions">
              <button disabled={!canSubmit} onClick={() => void submit()}>
                {busy ? "処理中…" : "端末に保存して送信"}
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  release();
                  setDraft(null);
                  setMessage("");
                }}
              >
                選び直す・撮り直す
              </button>
            </div>
          </div>
        )}
        {message && <p role="status">{message}</p>}
      </section>
      <section className="panel" aria-labelledby="upload-list">
        <h2 id="upload-list">この端末の送信状況</h2>
        <p role="status" aria-live="polite">
          {state.message}
        </p>
        <p className="caption">
          画面を移動しても送信を続けます。ブラウザ終了・OS中断・ログアウト後は、この画面で本人確認して再開してください。自動再試行は最大3回。再開ボタンは同じ投稿の再試行を始めます。
        </p>
        {state.busy && (
          <button className="secondary" onClick={queue.stop}>
            送信を停止
          </button>
        )}
        {state.ready && state.items.length === 0 && (
          <p>送信待ちはありません。</p>
        )}
        <div className="results">
          {state.items.map((item, index) => (
            <article className="result" key={item.id}>
              <h3>
                {item.request.kind === "photo" ? "写真" : "動画"} {index + 1}
              </h3>
              <p>
                {item.phase === "done"
                  ? "サーバー受付済み（公開待ち）"
                  : item.phase === "completing"
                    ? "保存結果を確認中"
                    : item.phase === "transferring"
                      ? "原本を送信中／再開待ち"
                      : "端末保存済み・送信待ち"}
              </p>
              {state.busy &&
                item.session?.mode === "single" &&
                item.phase === "transferring" && (
                  <progress aria-label={`項目${index + 1}を送信中`} />
                )}
              {item.session?.mode === "multipart" && (
                <>
                  <progress
                    aria-label={`項目${index + 1}の送信済みパート`}
                    max={Math.ceil(
                      item.request.file_size_bytes / item.session.partSize!,
                    )}
                    value={
                      item.checkpoint?.parts.length ??
                      (item.phase === "done"
                        ? Math.ceil(
                            item.request.file_size_bytes /
                              item.session.partSize!,
                          )
                        : 0)
                    }
                  />
                  <p className="caption">完了したパート数を表示しています。</p>
                </>
              )}
              {item.error && (
                <p className="warning">{errors[item.error].message}</p>
              )}
              {item.phase !== "done" && (
                <button
                  disabled={!state.ready || state.busy}
                  onClick={() => void queue.resume(item.id)}
                >
                  この送信を再開
                </button>
              )}
              <button
                className="text-button"
                disabled={!state.ready || state.busy}
                onClick={() => {
                  if (
                    window.confirm(
                      "この端末の保存分を削除します。未送信分は再開できなくなります。送信済みの投稿はサーバーに残ります。削除しますか？",
                    )
                  )
                    void queue.remove(item.id);
                }}
              >
                端末の保存分を削除
              </button>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
