import {
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  MATROSKA,
  MP4,
  Mp4OutputFormat,
  Output,
  QTFF,
  WEBM,
  WebMOutputFormat,
} from "mediabunny";
import {
  checkTrimOutput,
  isTrimTarget,
  type MediaMeasurement,
  type TrimResult,
  type TrimTarget,
} from "./trim-policy";

// プレイリスト/HLSを受理しない。Blobの内容から外部URLを取得させない。
const localFormats = [MP4, QTFF, WEBM, MATROSKA];

export async function measureMedia(blob: Blob): Promise<MediaMeasurement> {
  const input = new Input({
    source: new BlobSource(blob),
    formats: localFormats,
  });
  try {
    return await measureInput(input);
  } finally {
    input.dispose();
  }
}

async function measureInput(input: Input): Promise<MediaMeasurement> {
  const [video, audio, start, duration] = await Promise.all([
    input.getVideoTracks(),
    input.getAudioTracks(),
    input.getFirstTimestamp(),
    input.computeDuration(),
  ]);
  return {
    start,
    duration,
    video: await Promise.all(
      video.map(async (track) => ({
        codec: await track.getCodec(),
        start: await track.getFirstTimestamp(),
        end: await track.computeDuration(),
        width: await track.getDisplayWidth(),
        height: await track.getDisplayHeight(),
        rotation: await track.getRotation(),
        flipped: await track.getFlip(),
      })),
    ),
    audio: await Promise.all(
      audio.map(async (track) => ({
        codec: await track.getCodec(),
        start: await track.getFirstTimestamp(),
        end: await track.computeDuration(),
      })),
    ),
  };
}

export async function trimVideo(
  file: Blob,
  target: TrimTarget,
  onProgress: (progress: number) => void = () => {},
  signal?: AbortSignal,
): Promise<TrimResult> {
  if (!isTrimTarget(target)) throw new RangeError("未承認のトリム目標です。");
  signal?.throwIfAborted();
  const started = performance.now();
  const fallback = (
    reason: Extract<TrimResult, { status: "fallback" }>["reason"],
  ): TrimResult => ({
    status: "fallback",
    target,
    reason,
    elapsedMs: performance.now() - started,
  });
  if (file.size === 0) return fallback("unreadable");
  const input = new Input({
    source: new BlobSource(file),
    formats: localFormats,
  });
  let output:
    Output<Mp4OutputFormat | WebMOutputFormat, BufferTarget> | undefined;
  let conversion: Conversion | undefined;
  const cancel = () => {
    void conversion?.cancel();
  };
  try {
    const before = await measureInput(input);
    signal?.throwIfAborted();
    if (
      !Number.isFinite(before.start) ||
      !Number.isFinite(before.duration) ||
      before.duration <= Math.max(0, before.start) ||
      before.video.length === 0
    )
      return fallback("unreadable");
    const tracks = [
      ...(await input.getVideoTracks()),
      ...(await input.getAudioTracks()),
    ];
    const codecs = await Promise.all(tracks.map((track) => track.getCodec()));
    const format = [new Mp4OutputFormat(), new WebMOutputFormat()].find(
      (candidate) =>
        codecs.every(
          (codec) =>
            codec !== null && candidate.getSupportedCodecs().includes(codec),
        ),
    );
    if (!format) return fallback("unsupported");
    output = new Output(makeOutputOptions(format));
    // startは指定せず先頭から。forcedで再エンコードを禁止し、トラック欠落も拒否。
    conversion = await Conversion.init({
      input,
      output,
      tracks: "all",
      trim: {
        end: Math.min(before.duration, Math.max(0, before.start) + target),
      },
      copy: { mode: "forced", boundaryPolicy: "shrink", shiftTolerance: 0 },
      showWarnings: false,
    });
    signal?.throwIfAborted();
    if (
      !conversion.isValid ||
      conversion.discardedTracks.length > 0 ||
      conversion.utilizedTracks.length !== tracks.length
    )
      return fallback("unsupported");
    conversion.onProgress = (progress) =>
      onProgress(Math.max(0, Math.min(1, progress)));
    signal?.addEventListener("abort", cancel, { once: true });
    await conversion.execute();
    signal?.throwIfAborted();
    const buffer = output.target.buffer;
    if (!buffer || buffer.byteLength === 0) return fallback("unreadable");
    const blob = new Blob([buffer], { type: format.mimeType });
    const after = await measureMedia(blob);
    signal?.throwIfAborted();
    const failure = checkTrimOutput(before, after);
    if (failure) return fallback(failure);
    return {
      status: "ready",
      target,
      elapsedMs: performance.now() - started,
      input: before,
      output: after,
      blob,
    };
  } catch {
    signal?.throwIfAborted();
    return fallback("unreadable");
  } finally {
    signal?.removeEventListener("abort", cancel);
    try {
      if (output && output.state !== "finalized" && output.state !== "canceled")
        await output.cancel();
    } finally {
      input.dispose();
    }
  }
}

function makeOutputOptions(format: Mp4OutputFormat | WebMOutputFormat) {
  return { format, target: new BufferTarget() };
}
