"use client";

import Image from "next/image";
import { useState } from "react";

export function MediaPreview({
  kind,
  url,
  onDuration,
}: {
  kind: "photo" | "video";
  url: string;
  onDuration?: (value: number | null) => void;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <>
      <div className="preview">
        {kind === "photo" ? (
          <Image
            unoptimized
            src={url}
            alt="この端末で選んだ写真のプレビュー"
            fill
            sizes="(max-width: 720px) 100vw, 480px"
            onError={() => setFailed(true)}
          />
        ) : (
          /* 撮影データの原音検証。字幕は未生成であり、音声有無は測定表で示す。 */
          <video
            src={url}
            controls
            playsInline
            preload="metadata"
            onLoadedMetadata={(event) =>
              onDuration?.(
                Number.isFinite(event.currentTarget.duration)
                  ? event.currentTarget.duration
                  : null,
              )
            }
            onError={() => {
              setFailed(true);
              onDuration?.(null);
            }}
          />
        )}
      </div>
      {failed && (
        <p className="warning" role="status">
          このブラウザではプレビューできません。元ファイルは変更していません。別の形式へ自動変換はしません。
        </p>
      )}
    </>
  );
}
