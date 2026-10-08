"use client";
import { useState } from "react";
import { useUploadQueue } from "../../components/upload-provider";
import { UploadPanel } from "../../components/upload-panel";

export function UploadScreen({
  owner,
  eventId,
  themesEnabled = false,
}: {
  owner: string;
  eventId: string;
  themesEnabled?: boolean;
}) {
  const context = useUploadQueue();
  const [failed, setFailed] = useState(false);
  if (!context) return <p>送信画面は現在無効です。</p>;
  return (
    <>
      <button
        onClick={() => {
          setFailed(false);
          void context.activate(owner).catch(() => setFailed(true));
        }}
      >
        本人確認・送信待ちを読み込む
      </button>
      {failed && (
        <p role="alert">
          準備できませんでした。ログイン状態を確認してください。
        </p>
      )}
      {context.owner === owner && context.queue && (
        <UploadPanel
          key={`${eventId}:${owner}`}
          queue={context.queue}
          eventId={eventId}
          themesEnabled={themesEnabled}
        />
      )}
    </>
  );
}
