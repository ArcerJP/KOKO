import {
  maxPublishedVideoSeconds,
  videoTrimTargetsSeconds,
} from "@koko/contract";

export type TrimTarget = (typeof videoTrimTargetsSeconds)[number];
export type TrackMeasurement = {
  codec: string | null;
  start: number;
  end: number;
};
export type VideoMeasurement = TrackMeasurement & {
  width: number;
  height: number;
  rotation: number;
  flipped: boolean;
};
export type MediaMeasurement = {
  start: number;
  duration: number;
  video: VideoMeasurement[];
  audio: TrackMeasurement[];
};

export const fallbackMessages = {
  unreadable:
    "この端末では動画を読み取れません。原本を保持し、後続のサーバー処理が必要です。",
  unsupported: "再エンコードせずに処理できない形式です。原本を保持しています。",
  tracks:
    "映像・音声の欠落や向きの変化を検出しました。処理結果は採用せず、原本を保持しています。",
  duration:
    "出力時間を安全に確認できませんでした。処理結果は採用せず、原本を保持しています。",
  worker: "端末内の処理を開始・継続できませんでした。原本を保持しています。",
} as const;

export type FallbackReason = keyof typeof fallbackMessages;
export type TrimResult =
  | {
      status: "ready";
      target: TrimTarget;
      elapsedMs: number;
      input: MediaMeasurement;
      output: MediaMeasurement;
      blob: Blob;
    }
  | {
      status: "fallback";
      target: TrimTarget;
      elapsedMs: number;
      reason: FallbackReason;
    };

export function isTrimTarget(value: number): value is TrimTarget {
  return videoTrimTargetsSeconds.some((target) => target === value);
}

export function isSafeDuration(value: number): boolean {
  return (
    Number.isFinite(value) && value > 0 && value <= maxPublishedVideoSeconds
  );
}

/** 端末内の採用判定。本番公開時のBEによる再計測・AI判定を置き換えない。 */
export function checkTrimOutput(
  input: MediaMeasurement,
  output: MediaMeasurement,
): FallbackReason | null {
  if (
    !isSafeDuration(output.duration) ||
    [...output.video, ...output.audio].some(
      (track) =>
        !isSafeDuration(track.end) ||
        !Number.isFinite(track.start) ||
        track.end <= track.start,
    )
  )
    return "duration";
  if (
    output.video.length === 0 ||
    input.video.length !== output.video.length ||
    input.audio.length !== output.audio.length
  )
    return "tracks";
  if (
    input.video.some((track, index) => {
      const other = output.video[index];
      return (
        !other ||
        track.codec !== other.codec ||
        track.width !== other.width ||
        track.height !== other.height ||
        track.rotation !== other.rotation ||
        track.flipped !== other.flipped
      );
    })
  )
    return "tracks";
  if (
    input.audio.some(
      (track, index) => track.codec !== output.audio[index]?.codec,
    )
  )
    return "tracks";
  return null;
}
