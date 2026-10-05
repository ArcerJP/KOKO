import { createHash } from "node:crypto";
import type { ImageJobReference } from "./db.js";
import { transformImage } from "./index.js";
import {
  createMediaModerator,
  type MediaModeratorOptions,
  type ModerationMedia,
} from "./moderation.js";
import {
  ModerationDatabaseError,
  snapshotModerationJob,
  snapshotModerationPlan,
  type ModerationDatabase,
  type ModerationPlan,
} from "./moderation-db.js";
import { ImageStorageError, type OriginalReference } from "./r2.js";
import type { ImageRunResult } from "./runner.js";
import type { Derivative } from "./types.js";

export type PrivateVideoFrames = Readonly<{
  streamAssetId: string;
  postVersion: number;
  measuredDurationSeconds: number;
  requireSignedURLs: true;
  readyToStream: true;
  processingComplete: true;
  frames: readonly Readonly<{
    index: number;
    seconds: number;
    sha256: string;
    bytes: Uint8Array;
  }>[];
}>;
type Failure =
  | "INVALID_INPUT"
  | "BUSY"
  | "STALE"
  | "POLICY_UNAPPROVED"
  | "MEDIA_NOT_READY"
  | "DB_FAILED"
  | "DB_TIMEOUT"
  | "TIMEOUT"
  | "ORIGINAL_MISMATCH"
  | "DECODE_FAILED"
  | "PROCESSING_FAILED";
export type ModerationRunResult =
  | { ok: true; outcome: "moderation_recorded" | "moderation_already_recorded" }
  | { ok: false; reason: Failure };
class RunError extends Error {
  constructor(readonly reason: Failure) {
    super(reason);
  }
}
function fail(reason: Failure): never {
  throw new RunError(reason);
}
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: object, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((k) => Object.hasOwn(value, k));
function aiImage(value: unknown): Derivative {
  if (
    !record(value) ||
    !exact(value, [
      "name",
      "contentType",
      "width",
      "height",
      "sha256",
      "bytes",
    ]) ||
    value.name !== "ai-1024.jpg" ||
    value.contentType !== "image/jpeg" ||
    !Number.isInteger(value.width) ||
    !Number.isInteger(value.height) ||
    (value.width as number) < 1 ||
    (value.height as number) < 1 ||
    Math.max(value.width as number, value.height as number) > 1024 ||
    !(value.bytes instanceof Uint8Array) ||
    value.bytes.byteLength < 1 ||
    value.bytes.byteLength > 4194304 ||
    typeof value.sha256 !== "string"
  )
    fail("DECODE_FAILED");
  const bytes = Buffer.from(value.bytes);
  if (hash(bytes) !== value.sha256) fail("DECODE_FAILED");
  return {
    name: "ai-1024.jpg",
    contentType: "image/jpeg",
    width: value.width as number,
    height: value.height as number,
    sha256: value.sha256,
    bytes,
  };
}

/** Internal coordinator. A successful return means the DB atomically recorded the verdict; never returns media. */
export function createModerationRunner(
  options: {
    enabled?: boolean;
    database?: ModerationDatabase | null;
    imageRun?: (job: ImageJobReference) => Promise<ImageRunResult>;
    getOriginal?: (
      ref: OriginalReference,
    ) => Promise<{ bytes: Uint8Array; sha256: string }>;
    /** Trusted private retrieval using DB-bound IDs only. Never an incoming URL/frame payload. */
    getVideoFrames?: (
      plan: ModerationPlan,
      signal: AbortSignal,
    ) => Promise<PrivateVideoFrames>;
    transform?: typeof transformImage;
    openaiToken?: MediaModeratorOptions["openaiToken"];
    visionToken?: MediaModeratorOptions["visionToken"];
    providerFetch?: typeof fetch;
    moderatorFactory?: typeof createMediaModerator;
  } = {},
): {
  run(
    job: ImageJobReference,
    signal?: AbortSignal,
  ): Promise<ModerationRunResult>;
} | null {
  if (options.enabled !== true) return null;
  const {
    database,
    imageRun,
    getOriginal,
    getVideoFrames,
    transform = transformImage,
    openaiToken,
    visionToken,
    providerFetch,
    moderatorFactory = createMediaModerator,
  } = options;
  if (
    !database ||
    [
      database.claim,
      database.check,
      database.reserve,
      database.finish,
      database.fail,
      getOriginal,
      transform,
      openaiToken,
      visionToken,
      moderatorFactory,
    ].some((fn) => typeof fn !== "function") ||
    (imageRun !== undefined && typeof imageRun !== "function") ||
    (getVideoFrames !== undefined && typeof getVideoFrames !== "function")
  )
    throw new Error("INVALID_MODERATION_RUNNER_CONFIG");
  let active = false;
  return Object.freeze({
    async run(
      value: ImageJobReference,
      externalSignal = new AbortController().signal,
    ): Promise<ModerationRunResult> {
      if (active) return { ok: false, reason: "BUSY" };
      active = true;
      const deadline = Date.now() + 120000;
      const controller = new AbortController();
      const abort = () => controller.abort();
      externalSignal.addEventListener("abort", abort, { once: true });
      if (externalSignal.aborted) abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let activePlan: ModerationPlan | undefined;
      const signal = controller.signal;
      const guard = () => {
        if (signal.aborted) fail("STALE");
      };
      async function bounded<T>(work: () => Promise<T>): Promise<T> {
        guard();
        let stop: (() => void) | undefined;
        try {
          return await Promise.race([
            Promise.resolve().then(() => {
              guard();
              return work();
            }),
            new Promise<never>((_, reject) => {
              stop = () => reject(new RunError("STALE"));
              signal.addEventListener("abort", stop, { once: true });
              if (signal.aborted) stop();
            }),
          ]);
        } finally {
          if (stop) signal.removeEventListener("abort", stop);
        }
      }
      try {
        const job = snapshotModerationJob(value);
        // A separate total bound also covers an unresponsive initial image stage.
        timer = setTimeout(abort, 120000);
        let found = await bounded(() => database.claim(job));
        if (["STALE", "MEDIA_NOT_READY"].includes(found.code) && imageRun) {
          const image = await bounded(() => imageRun(job));
          if (!image.ok) {
            if (
              [
                "BUSY",
                "STALE",
                "DB_TIMEOUT",
                "DB_FAILED",
                "TIMEOUT",
                "INVALID_INPUT",
              ].includes(image.reason)
            )
              fail(image.reason as Failure);
            fail("MEDIA_NOT_READY");
          }
          found = await bounded(() => database.claim(job));
        }
        if (found.code === "DONE")
          return { ok: true, outcome: "moderation_already_recorded" };
        if (found.code === "HELD")
          return { ok: false, reason: "PROCESSING_FAILED" };
        if (found.code !== "CLAIMED") return { ok: false, reason: found.code };
        const plan = snapshotModerationPlan(found.plan);
        if (
          plan.jobId !== job.jobId ||
          plan.original.eventId !== job.eventId ||
          plan.original.postId !== job.postId ||
          plan.expiresAt <= Date.now() ||
          plan.expiresAt > Date.now() + 125000
        )
          fail("STALE");
        activePlan = plan;
        clearTimeout(timer);
        timer = setTimeout(
          abort,
          Math.max(1, Math.min(deadline, plan.expiresAt) - Date.now()),
        );
        const check = async () => {
          guard();
          if (
            Date.now() >= plan.expiresAt ||
            !(await bounded(() => database.check(plan))) ||
            Date.now() >= plan.expiresAt
          )
            fail("STALE");
          guard();
        };
        const decode = async (bytes: Buffer): Promise<Derivative> => {
          const originalHash = hash(bytes);
          await check();
          let converted: Awaited<ReturnType<typeof transform>>;
          try {
            converted = await bounded(() => transform(bytes));
          } catch (e) {
            if (e instanceof RunError) throw e;
            fail("DECODE_FAILED");
          }
          if (hash(bytes) !== originalHash) fail("ORIGINAL_MISMATCH");
          if (!converted.ok || !Array.isArray(converted.derivatives))
            fail("DECODE_FAILED");
          const images = converted.derivatives.filter(
            (d) => d.name === "ai-1024.jpg",
          );
          if (images.length !== 1) fail("DECODE_FAILED");
          const ai = aiImage(images[0]);
          await check();
          return ai;
        };
        await check();
        let media: ModerationMedia;
        if (plan.media.kind === "photo") {
          const original: OriginalReference = {
            eventId: plan.original.eventId,
            postId: plan.original.postId,
            assetId: plan.original.assetId,
            size: plan.original.size,
            etag: plan.original.etag,
            ...(plan.original.sha256 ? { sha256: plan.original.sha256 } : {}),
          };
          const source = await bounded(() => getOriginal!(original));
          if (
            !(source?.bytes instanceof Uint8Array) ||
            source.bytes.byteLength !== original.size ||
            source.bytes.byteLength > 67108864
          )
            fail("ORIGINAL_MISMATCH");
          const bytes = Buffer.from(source.bytes);
          if (
            hash(bytes) !== source.sha256 ||
            source.sha256 !== original.sha256
          )
            fail("ORIGINAL_MISMATCH");
          media = { kind: "photo", image: await decode(bytes) };
        } else {
          if (!getVideoFrames) fail("MEDIA_NOT_READY");
          const source = await bounded(() => getVideoFrames(plan, signal));
          if (
            !record(source) ||
            !exact(source, [
              "streamAssetId",
              "postVersion",
              "measuredDurationSeconds",
              "requireSignedURLs",
              "readyToStream",
              "processingComplete",
              "frames",
            ]) ||
            source.streamAssetId !== plan.media.streamAssetId ||
            source.postVersion !== plan.postVersion ||
            source.measuredDurationSeconds !==
              plan.media.measuredDurationSeconds ||
            source.requireSignedURLs !== true ||
            source.readyToStream !== true ||
            source.processingComplete !== true ||
            !Array.isArray(source.frames) ||
            source.frames.length !== 3
          )
            fail("MEDIA_NOT_READY");
          // Snapshot all frames before the first await, bounded to 3 x 4 MiB.
          const frames = source.frames.map((f, index) => {
            if (
              !record(f) ||
              !exact(f, ["index", "seconds", "sha256", "bytes"]) ||
              f.index !== index ||
              f.seconds !==
                (
                  plan.media as Extract<
                    ModerationPlan["media"],
                    { kind: "video" }
                  >
                ).frameTimes[index] ||
              !(f.bytes instanceof Uint8Array) ||
              f.bytes.byteLength < 1 ||
              f.bytes.byteLength > 4194304
            )
              fail("MEDIA_NOT_READY");
            const bytes = Buffer.from(f.bytes);
            if (hash(bytes) !== f.sha256) fail("MEDIA_NOT_READY");
            return { index, seconds: f.seconds as number, bytes };
          });
          const normalized: Extract<
            ModerationMedia,
            { kind: "video" }
          >["frames"][number][] = [];
          for (const f of frames)
            normalized.push({
              index: f.index,
              seconds: f.seconds,
              image: await decode(f.bytes),
            });
          media = {
            kind: "video",
            measuredDurationSeconds: plan.media.measuredDurationSeconds,
            frames: normalized,
          };
        }
        await check();
        const token =
          (provider: NonNullable<MediaModeratorOptions["openaiToken"]>) =>
          async (s: AbortSignal) => {
            if (s.aborted) fail("STALE");
            await check();
            const value = await bounded(() => provider(s));
            if (s.aborted) fail("STALE");
            await check();
            return value;
          };
        const moderator = moderatorFactory({
          enabled: true,
          maxConcurrentJobs: 1,
          policy: plan.policy,
          attemptStarts: plan.attemptStarts,
          openaiToken: token(openaiToken!),
          visionToken: token(visionToken!),
          reserveQuota: async (request) => {
            if (request.signal.aborted) return { allowed: false };
            await check();
            const allowed = await bounded(() =>
              database.reserve(plan, {
                provider: request.provider,
                engine: request.feature,
                frame: request.frame,
                attempt: request.attempt,
              }),
            );
            if (request.signal.aborted) return { allowed: false };
            await check();
            return allowed;
          },
          ...(providerFetch ? { fetcher: providerFetch } : {}),
        });
        if (!moderator) fail("PROCESSING_FAILED");
        const result = await bounded(() => moderator.moderate(media, signal));
        await check();
        const saved = await bounded(() => database.finish(plan, result));
        if (saved.code === "RECORDED" || saved.code === "DONE")
          return {
            ok: true,
            outcome:
              saved.code === "RECORDED"
                ? "moderation_recorded"
                : "moderation_already_recorded",
          };
        return { ok: false, reason: saved.code };
      } catch (e) {
        const processingReason =
          e instanceof RunError
            ? e.reason
            : e instanceof ImageStorageError
              ? e.code
              : null;
        if (
          activePlan &&
          !signal.aborted &&
          (processingReason === "DECODE_FAILED" ||
            processingReason === "ORIGINAL_MISMATCH")
        ) {
          try {
            const saved = await bounded(() =>
              database.fail(activePlan!, processingReason),
            );
            if (saved.code !== "HELD")
              return {
                ok: false,
                reason: saved.code === "DONE" ? "STALE" : saved.code,
              };
          } catch (failure) {
            if (
              failure instanceof ModerationDatabaseError &&
              failure.code !== "INVALID_DB_CONFIG"
            )
              return { ok: false, reason: failure.code };
            if (failure instanceof RunError)
              return { ok: false, reason: failure.reason };
            return { ok: false, reason: "PROCESSING_FAILED" };
          }
        }
        if (e instanceof RunError) return { ok: false, reason: e.reason };
        if (
          e instanceof ModerationDatabaseError &&
          e.code !== "INVALID_DB_CONFIG"
        )
          return { ok: false, reason: e.code };
        if (
          e instanceof ImageStorageError &&
          ["TIMEOUT", "ORIGINAL_MISMATCH"].includes(e.code)
        )
          return { ok: false, reason: e.code as Failure };
        return { ok: false, reason: "PROCESSING_FAILED" };
      } finally {
        clearTimeout(timer);
        externalSignal.removeEventListener("abort", abort);
        controller.abort();
        active = false;
      }
    },
  });
}
