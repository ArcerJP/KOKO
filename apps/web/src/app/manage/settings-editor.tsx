"use client";
import { useId, useState, type FormEvent } from "react";
import {
  operationInput,
  type Operation,
  type Settings,
} from "../../api/operations-contract";
import { Confirm } from "./_components/controls";
import styles from "./operations.module.css";

type Threshold = Settings["thresholds"][number];
type ThresholdDraft = {
  key: string;
  engine: Threshold["engine"];
  category: string;
  flag: string;
  block: string;
  immediate_ban: boolean;
};

export function SettingsEditor({
  settings,
  mutate,
}: {
  settings: Settings;
  mutate: (
    op: Operation,
    input: unknown,
    confirmed: boolean,
  ) => Promise<boolean>;
}) {
  const id = useId();
  const [stopped, setStopped] = useState(settings.publication_stopped);
  const [uploads, setUploads] = useState(settings.uploads_enabled);
  const [concurrency, setConcurrency] = useState(
    String(settings.moderation_concurrency),
  );
  const [thresholds, setThresholds] = useState<ThresholdDraft[]>(() =>
    settings.thresholds.map((t, index) => ({
      ...t,
      key: String(index),
      flag: String(t.flag),
      block: String(t.block),
    })),
  );
  const [nextKey, setNextKey] = useState(settings.thresholds.length);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function change(index: number, value: Partial<ThresholdDraft>) {
    setConfirmed(false);
    setThresholds((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...value } : row)),
    );
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!confirmed) return;
    try {
      if (thresholds.some((t) => !t.flag.trim() || !t.block.trim()))
        throw new Error("EMPTY");
      const input = {
        version: settings.version,
        publication_stopped: stopped,
        uploads_enabled: uploads,
        moderation_concurrency: Number(concurrency),
        thresholds: thresholds.map(
          ({ engine, category, flag, block, immediate_ban }) => ({
            engine,
            category: category.trim(),
            flag: Number(flag),
            block: Number(block),
            immediate_ban,
          }),
        ),
      };
      operationInput({ name: "updateSettings" }, input);
      setConfirmed(false);
      setError(null);
      void mutate({ name: "updateSettings" }, input, true);
    } catch {
      setError(
        "並列度は正の整数、閾値は 0〜1 で BLOCK を FLAG より低くしないでください。エンジンとカテゴリの重複も確認してください。",
      );
    }
  }
  return (
    <section aria-label="停止・AI設定">
      <h2>停止・AI設定</h2>
      <p>設定の更新世代：{settings.version}</p>
      <p className="warning">
        全公開停止は新規の閲覧を停止します。すでに取得された画像や録画は回収できません。停止解除・受付再開は人間の判断と確認を伴う操作です。
      </p>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={settings.thresholds_approved === true}
          readOnly
          disabled
        />
        閾値の承認状態（この画面では承認できません）
      </label>
      <p>
        閾値を変更すると未承認になります。評価と承認の完了までAI判定の公開条件は満たせません。値の推奨・初期値は自動設定しません。
      </p>
      <form className={styles.form} onSubmit={submit}>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={stopped}
            onChange={(e) => {
              setStopped(e.target.checked);
              setConfirmed(false);
            }}
          />
          全公開を停止する
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={uploads}
            onChange={(e) => {
              setUploads(e.target.checked);
              setConfirmed(false);
            }}
          />
          新規投稿の受付を有効にする
        </label>
        <label htmlFor={`${id}-concurrency`}>モデレーション並列度</label>
        <input
          id={`${id}-concurrency`}
          type="number"
          min={1}
          step={1}
          value={concurrency}
          onChange={(e) => {
            setConcurrency(e.target.value);
            setConfirmed(false);
          }}
          required
        />
        <h3>カテゴリ別の閾値</h3>
        {thresholds.length === 0 ? (
          <p>閾値は未設定です。無判定での公開はできません。</p>
        ) : null}
        {thresholds.map((row, index) => (
          <fieldset className={styles.form} key={row.key}>
            <legend>閾値 {index + 1}</legend>
            <label htmlFor={`${id}-${row.key}-engine`}>エンジン</label>
            <select
              id={`${id}-${row.key}-engine`}
              value={row.engine}
              onChange={(e) =>
                change(index, { engine: e.target.value as Threshold["engine"] })
              }
            >
              <option value="openai">OpenAI 画像</option>
              <option value="safesearch">SafeSearch</option>
              <option value="ocr">OCR テキスト</option>
            </select>
            <label htmlFor={`${id}-${row.key}-category`}>カテゴリ</label>
            <input
              id={`${id}-${row.key}-category`}
              value={row.category}
              maxLength={100}
              required
              onChange={(e) => change(index, { category: e.target.value })}
            />
            <label htmlFor={`${id}-${row.key}-flag`}>FLAG（0〜1）</label>
            <input
              id={`${id}-${row.key}-flag`}
              type="number"
              min={0}
              max={1}
              step="any"
              value={row.flag}
              required
              onChange={(e) => change(index, { flag: e.target.value })}
            />
            <label htmlFor={`${id}-${row.key}-block`}>
              BLOCK（FLAG以上・1以下）
            </label>
            <input
              id={`${id}-${row.key}-block`}
              type="number"
              min={0}
              max={1}
              step="any"
              value={row.block}
              required
              onChange={(e) => change(index, { block: e.target.value })}
            />
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={row.immediate_ban}
                onChange={(e) =>
                  change(index, { immediate_ban: e.target.checked })
                }
              />
              重大カテゴリのBLOCKで即時BAN
            </label>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setThresholds((rows) => rows.filter((_, i) => i !== index));
                setConfirmed(false);
              }}
            >
              この閾値を設定案から除く
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          className="secondary"
          disabled={thresholds.length >= 100}
          onClick={() => {
            setThresholds((rows) => [
              ...rows,
              {
                key: String(nextKey),
                engine: "openai",
                category: "",
                flag: "",
                block: "",
                immediate_ban: false,
              },
            ]);
            setNextKey((x) => x + 1);
            setConfirmed(false);
          }}
        >
          閾値の入力欄を追加
        </button>
        {error ? <p role="alert">{error}</p> : null}
        <Confirm
          checked={confirmed}
          onChange={setConfirmed}
          label="停止・受付・閾値の変更内容と影響を確認しました"
        />
        <button disabled={!confirmed}>設定を保存する</button>
      </form>
    </section>
  );
}
