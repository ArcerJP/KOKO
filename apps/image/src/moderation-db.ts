import type { ImageJobReference, ImageReceipt } from "./db.js";
import {
  moderationCategories,
  snapshotModerationPolicy,
  type MediaModerationResult,
  type ModerationAttemptStart,
  type ModerationPolicy,
} from "./moderation.js";
import { snapshotImageProcessingPlan } from "./pipeline.js";
import type { OriginalReference } from "./r2.js";

export type ModerationPlan = Readonly<{
  jobId: string;
  postVersion: number;
  leaseId: string;
  expiresAt: number;
  policy: ModerationPolicy;
  attemptStarts: readonly ModerationAttemptStart[];
  original: Readonly<OriginalReference & { objectVersion: string }>;
  media:
    | Readonly<{
        kind: "photo";
        source: "original_read_only";
        imageReceipt: Readonly<{
          originalSha256: string;
          deliveries: readonly Omit<
            ImageReceipt["deliveries"][number],
            "outcome"
          >[];
        }>;
      }>
    | Readonly<{
        kind: "video";
        postVersion: number;
        streamAssetId: string;
        streamUid: string;
        sourceUid: string | null;
        measuredDurationSeconds: number;
        frameTimes: readonly number[];
        requireSignedURLs: true;
        readyToStream: true;
        processingComplete: true;
      }>;
}>;
type Refusal =
  | "BUSY"
  | "DONE"
  | "STALE"
  | "POLICY_UNAPPROVED"
  | "MEDIA_NOT_READY"
  | "INVALID_INPUT";
type FailureCode = "DECODE_FAILED" | "ORIGINAL_MISMATCH";
export type ModerationDatabase = {
  claim(
    job: ImageJobReference,
  ): Promise<
    { code: "CLAIMED"; plan: ModerationPlan } | { code: Refusal | "HELD" }
  >;
  check(plan: ModerationPlan): Promise<boolean>;
  fail(
    plan: ModerationPlan,
    reason: FailureCode,
  ): Promise<{ code: "HELD" | Refusal }>;
  reserve(
    plan: ModerationPlan,
    request: {
      provider: "openai" | "vision";
      engine: ModerationAttemptStart["engine"];
      frame: number;
      attempt: number;
    },
  ): Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
  finish(
    plan: ModerationPlan,
    result: MediaModerationResult,
  ): Promise<{ code: "RECORDED" | Refusal }>;
};
export class ModerationDatabaseError extends Error {
  constructor(
    readonly code:
      "INVALID_DB_CONFIG" | "INVALID_INPUT" | "DB_FAILED" | "DB_TIMEOUT",
  ) {
    super(code);
    this.name = "ModerationDatabaseError";
  }
}
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const exact = (x: object, names: readonly string[]) =>
  Object.keys(x).length === names.length &&
  names.every((n) => Object.hasOwn(x, n));
const id = (x: unknown): x is string =>
  typeof x === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    x,
  );
const integer = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const hash = (x: unknown): x is string =>
  typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const engines = ["openai", "safesearch", "ocr"] as const;
const errors = [
  "INVALID_MEDIA",
  "BUSY",
  "ABORTED",
  "TIMEOUT",
  "QUOTA",
  "CREDENTIALS",
  "PROVIDER_REJECTED",
  "PROVIDER_UNAVAILABLE",
  "INVALID_RESPONSE",
  "RESOURCE_LIMIT",
];
function invalid(): never {
  throw new ModerationDatabaseError("INVALID_INPUT");
}
function failed(): never {
  throw new ModerationDatabaseError("DB_FAILED");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function snapshotModerationJob(value: unknown): ImageJobReference {
  if (
    !record(value) ||
    !exact(value, ["eventId", "postId", "jobId"]) ||
    !id(value.eventId) ||
    !id(value.postId) ||
    !id(value.jobId)
  )
    invalid();
  return Object.freeze({
    eventId: value.eventId,
    postId: value.postId,
    jobId: value.jobId,
  });
}

/** Shape checking is not authorization. Only the fixed service-role RPC grants a lease. */
export function snapshotModerationPlan(input: unknown): ModerationPlan {
  let x: unknown;
  try {
    x = structuredClone(input);
  } catch {
    return invalid();
  }
  if (
    !record(x) ||
    !exact(x, [
      "jobId",
      "postVersion",
      "leaseId",
      "expiresAt",
      "policy",
      "attemptStarts",
      "original",
      "media",
    ]) ||
    !id(x.jobId) ||
    !id(x.leaseId) ||
    !integer(x.postVersion) ||
    x.postVersion > 2147483646 ||
    !integer(x.expiresAt)
  )
    invalid();
  let policy: ModerationPolicy;
  try {
    policy = snapshotModerationPolicy(x.policy as ModerationPolicy);
  } catch {
    return invalid();
  }
  if (policy.version > 2147483647) invalid();
  const o = x.original;
  if (
    !record(o) ||
    !exact(o, [
      "eventId",
      "postId",
      "assetId",
      "size",
      "etag",
      "objectVersion",
      ...(Object.hasOwn(o, "sha256") ? ["sha256"] : []),
    ]) ||
    !id(o.eventId) ||
    !id(o.postId) ||
    !id(o.assetId) ||
    !integer(o.size) ||
    typeof o.etag !== "string" ||
    !/^[a-f0-9]{32}(?:-[1-9][0-9]{0,3}|-10000)?$/.test(o.etag) ||
    typeof o.objectVersion !== "string" ||
    !/^[\x21-\x7e]{1,1024}$/.test(o.objectVersion) ||
    (Object.hasOwn(o, "sha256") && !hash(o.sha256))
  )
    invalid();
  const media = x.media;
  if (!record(media)) invalid();
  let frameCount: number;
  if (media.kind === "photo") {
    frameCount = 1;
    if (
      !exact(media, ["kind", "source", "imageReceipt"]) ||
      media.source !== "original_read_only" ||
      !hash(o.sha256)
    )
      invalid();
    const receipt = media.imageReceipt;
    if (
      !record(receipt) ||
      !exact(receipt, ["originalSha256", "deliveries"]) ||
      receipt.originalSha256 !== o.sha256 ||
      !Array.isArray(receipt.deliveries) ||
      receipt.deliveries.length !== 4
    )
      invalid();
    for (const d of receipt.deliveries) {
      if (
        !record(d) ||
        !exact(d, [
          "eventId",
          "assetId",
          "variant",
          "format",
          "sha256",
          "size",
          "width",
          "height",
        ]) ||
        !hash(d.sha256) ||
        !integer(d.size) ||
        d.size > 16777216 ||
        !integer(d.width) ||
        !integer(d.height) ||
        Math.max(d.width, d.height) > Number(d.variant)
      )
        invalid();
    }
    try {
      const original = { ...o };
      delete original.objectVersion;
      snapshotImageProcessingPlan({
        jobId: x.jobId,
        postVersion: x.postVersion,
        leaseId: x.leaseId,
        expiresAt: x.expiresAt,
        original,
        deliveries: receipt.deliveries.map((d) => ({
          eventId: d.eventId,
          assetId: d.assetId,
          variant: d.variant,
          format: d.format,
        })),
      });
    } catch {
      return invalid();
    }
  } else if (media.kind === "video") {
    frameCount = 3;
    if (
      !exact(media, [
        "kind",
        "postVersion",
        "streamAssetId",
        "streamUid",
        "sourceUid",
        "measuredDurationSeconds",
        "frameTimes",
        "requireSignedURLs",
        "readyToStream",
        "processingComplete",
      ]) ||
      media.postVersion !== x.postVersion ||
      !id(media.streamAssetId) ||
      typeof media.streamUid !== "string" ||
      !/^[a-f0-9]{32}$/.test(media.streamUid) ||
      (media.sourceUid !== null &&
        (typeof media.sourceUid !== "string" ||
          !/^[a-f0-9]{32}$/.test(media.sourceUid) ||
          media.sourceUid === media.streamUid)) ||
      media.requireSignedURLs !== true ||
      media.readyToStream !== true ||
      media.processingComplete !== true ||
      typeof media.measuredDurationSeconds !== "number" ||
      !Number.isFinite(media.measuredDurationSeconds) ||
      media.measuredDurationSeconds <= 0 ||
      media.measuredDurationSeconds > 4 ||
      !Array.isArray(media.frameTimes) ||
      media.frameTimes.length !== 3
    )
      invalid();
    let previous = 0;
    for (const t of media.frameTimes) {
      if (
        typeof t !== "number" ||
        !Number.isFinite(t) ||
        t <= previous ||
        t >= media.measuredDurationSeconds
      )
        invalid();
      previous = t;
    }
  } else return invalid();
  if (
    !Array.isArray(x.attemptStarts) ||
    x.attemptStarts.length !== frameCount * 3
  )
    invalid();
  const seen = new Set<string>();
  for (const a of x.attemptStarts) {
    if (
      !record(a) ||
      !exact(a, ["engine", "frame", "nextAttempt"]) ||
      !engines.includes(a.engine as (typeof engines)[number]) ||
      typeof a.frame !== "number" ||
      !Number.isInteger(a.frame) ||
      a.frame < 0 ||
      a.frame >= frameCount ||
      !integer(a.nextAttempt) ||
      a.nextAttempt > 4 ||
      seen.has(`${a.engine}:${a.frame}`)
    )
      invalid();
    seen.add(`${a.engine}:${a.frame}`);
  }
  return freeze({ ...x, policy }) as ModerationPlan;
}

function evidence(input: MediaModerationResult): MediaModerationResult {
  let x: unknown;
  try {
    x = structuredClone(input);
  } catch {
    return invalid();
  }
  if (
    !record(x) ||
    !exact(x, [
      "decision",
      "policyVersion",
      "engines",
      "runs",
      "categories",
      "immediateBan",
      ...(Object.hasOwn(x, "errorCode") ? ["errorCode"] : []),
    ]) ||
    !["PASS", "FLAG", "BLOCK", "HELD"].includes(x.decision as string) ||
    !integer(x.policyVersion) ||
    typeof x.immediateBan !== "boolean" ||
    !Array.isArray(x.engines) ||
    x.engines.length !== 3 ||
    !Array.isArray(x.runs) ||
    x.runs.length > 27 ||
    !Array.isArray(x.categories) ||
    x.categories.length > 24 ||
    (Object.hasOwn(x, "errorCode") && !errors.includes(x.errorCode as string))
  )
    invalid();
  const seen = new Set<string>();
  for (const e of x.engines) {
    if (
      !record(e) ||
      !exact(e, ["engine", "decision"]) ||
      !engines.includes(e.engine as (typeof engines)[number]) ||
      !["PASS", "FLAG", "BLOCK", "ERROR"].includes(e.decision as string) ||
      seen.has(e.engine as string)
    )
      invalid();
    seen.add(e.engine as string);
  }
  for (const c of x.categories) {
    if (
      !record(c) ||
      !exact(c, ["engine", "category", "decision"]) ||
      !engines.includes(c.engine as (typeof engines)[number]) ||
      !moderationCategories[c.engine as (typeof engines)[number]].includes(
        c.category as string,
      ) ||
      !["FLAG", "BLOCK"].includes(c.decision as string)
    )
      invalid();
  }
  for (const r of x.runs) {
    if (
      !record(r) ||
      !exact(r, [
        "engine",
        "frame",
        "attempt",
        "decision",
        "modelVersion",
        "scores",
        "latencyMs",
        "usage",
        "estimatedCostUsd",
        "observation",
        ...(Object.hasOwn(r, "errorCode") ? ["errorCode"] : []),
        ...(Object.hasOwn(r, "retryAfterSeconds") ? ["retryAfterSeconds"] : []),
      ]) ||
      !engines.includes(r.engine as (typeof engines)[number]) ||
      !["PASS", "FLAG", "BLOCK", "ERROR"].includes(r.decision as string) ||
      !Number.isInteger(r.frame) ||
      (r.frame as number) < 0 ||
      (r.frame as number) > 2 ||
      !integer(r.attempt) ||
      r.attempt > 3 ||
      !Number.isInteger(r.latencyMs) ||
      (r.latencyMs as number) < 0 ||
      (r.latencyMs as number) > 2147483647 ||
      r.estimatedCostUsd !== null ||
      !["scores", "no_text", "error"].includes(r.observation as string) ||
      !record(r.scores) ||
      !record(r.usage) ||
      !exact(r.usage, ["openaiRequests", "safeSearchImages", "ocrImages"]) ||
      Object.values(r.usage).some((n) => n !== 0 && n !== 1) ||
      (Object.hasOwn(r, "errorCode") &&
        !errors.includes(r.errorCode as string)) ||
      (Object.hasOwn(r, "retryAfterSeconds") &&
        (!integer(r.retryAfterSeconds) || r.retryAfterSeconds > 3600))
    )
      invalid();
    const model =
      r.engine === "openai"
        ? "omni-moderation-2024-09-26"
        : r.engine === "safesearch"
          ? "vision-v1/builtin-stable/unreported/likelihood-ordinal-v1"
          : "vision-v1/builtin-stable/unreported+omni-moderation-2024-09-26";
    if (
      r.modelVersion !== model ||
      (r.observation === "scores"
        ? !exact(
            r.scores,
            moderationCategories[r.engine as (typeof engines)[number]],
          )
        : Object.keys(r.scores).length !== 0) ||
      Object.values(r.scores).some(
        (n) => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1,
      )
    )
      invalid();
  }
  return x as MediaModerationResult;
}

/** No env access, retries, arbitrary endpoint, or browser credentials. */
export function createModerationDatabase(
  options: {
    enabled?: boolean;
    supabaseUrl?: string;
    secretKey?: string;
    fetcher?: typeof fetch;
    timeoutMs?: number;
  } = {},
): ModerationDatabase | null {
  if (options.enabled !== true) return null;
  const { supabaseUrl, secretKey, fetcher = fetch, timeoutMs = 5000 } = options;
  if (
    typeof supabaseUrl !== "string" ||
    !/^https:\/\/[a-z0-9]{20}\.supabase\.co\/?$/.test(supabaseUrl) ||
    typeof secretKey !== "string" ||
    !/^sb_secret_[A-Za-z0-9_-]{1,256}$/.test(secretKey) ||
    typeof fetcher !== "function" ||
    !integer(timeoutMs) ||
    timeoutMs > 5000
  )
    throw new ModerationDatabaseError("INVALID_DB_CONFIG");
  const endpoint = new URL("/rest/v1/rpc/manage_media_moderation", supabaseUrl)
    .href;
  async function rpc(
    ref: ImageJobReference,
    action: string,
    input: object,
  ): Promise<Record<string, unknown>> {
    const body = JSON.stringify({
      p_event_id: ref.eventId,
      p_post_id: ref.postId,
      p_job_id: ref.jobId,
      p_action: action,
      p_input: input,
    });
    if (Buffer.byteLength(body) > 65536) invalid();
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        (async () => {
          const response = await fetcher(endpoint, {
            method: "POST",
            redirect: "manual",
            cache: "no-store",
            credentials: "omit",
            signal: controller.signal,
            headers: {
              apikey: secretKey!,
              "content-type": "application/json",
              accept: "application/json",
            },
            body,
          });
          if (controller.signal.aborted) {
            void response.body?.cancel().catch(() => {});
            failed();
          }
          reader = response.body?.getReader();
          const length = response.headers.get("content-length");
          if (
            response.status !== 200 ||
            response.redirected ||
            (response.url && response.url !== endpoint) ||
            !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
              response.headers.get("content-type") ?? "",
            ) ||
            (response.headers.has("content-encoding") &&
              response.headers.get("content-encoding") !== "identity") ||
            !reader ||
            (length !== null &&
              (!/^\d+$/.test(length) || Number(length) > 65536))
          )
            failed();
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const next = await reader.read();
            if (controller.signal.aborted) failed();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 65536) failed();
            chunks.push(next.value);
          }
          if (length !== null && Number(length) !== size) failed();
          return JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          ) as unknown;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new ModerationDatabaseError("DB_TIMEOUT"));
            controller.abort();
          }, timeoutMs);
        }),
      ]);
      if (!record(result)) failed();
      return result;
    } catch (e) {
      if (e instanceof ModerationDatabaseError) throw e;
      return failed();
    } finally {
      clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
  }
  const refFor = (p: ModerationPlan) => ({
    eventId: p.original.eventId,
    postId: p.original.postId,
    jobId: p.jobId,
  });
  const refusals: Refusal[] = [
    "BUSY",
    "DONE",
    "STALE",
    "POLICY_UNAPPROVED",
    "MEDIA_NOT_READY",
    "INVALID_INPUT",
  ];
  return Object.freeze({
    async claim(value: ImageJobReference) {
      const ref = snapshotModerationJob(value);
      const r = await rpc(ref, "claim", {});
      if (r.code === "CLAIMED") {
        if (!exact(r, ["code", "plan"])) failed();
        let p: ModerationPlan;
        try {
          p = snapshotModerationPlan(r.plan);
        } catch {
          return failed();
        }
        if (
          p.jobId !== ref.jobId ||
          p.original.eventId !== ref.eventId ||
          p.original.postId !== ref.postId ||
          p.expiresAt <= Date.now() ||
          p.expiresAt > Date.now() + 125000
        )
          failed();
        return { code: "CLAIMED" as const, plan: p };
      }
      if (
        !exact(r, ["code"]) ||
        !(r.code === "HELD" || refusals.includes(r.code as Refusal))
      )
        failed();
      return { code: r.code as Refusal | "HELD" };
    },
    async fail(value: ModerationPlan, reason: FailureCode) {
      const p = snapshotModerationPlan(value);
      if (!["DECODE_FAILED", "ORIGINAL_MISMATCH"].includes(reason)) invalid();
      const r = await rpc(refFor(p), "fail", { plan: p, reason });
      if (
        !exact(r, ["code"]) ||
        !(r.code === "HELD" || refusals.includes(r.code as Refusal))
      )
        failed();
      return { code: r.code as "HELD" | Refusal };
    },
    async check(value: ModerationPlan) {
      const p = snapshotModerationPlan(value);
      if (p.expiresAt <= Date.now()) return false;
      const r = await rpc(refFor(p), "check", { plan: p });
      if (
        !exact(r, ["code"]) ||
        !["CURRENT", ...refusals].includes(r.code as string)
      )
        failed();
      return r.code === "CURRENT" && p.expiresAt > Date.now();
    },
    async reserve(
      value: ModerationPlan,
      request: {
        provider: "openai" | "vision";
        engine: ModerationAttemptStart["engine"];
        frame: number;
        attempt: number;
      },
    ) {
      const p = snapshotModerationPlan(value);
      if (
        !record(request) ||
        !exact(request, ["provider", "engine", "frame", "attempt"]) ||
        !["openai", "vision"].includes(request.provider) ||
        !engines.includes(request.engine) ||
        !Number.isInteger(request.frame) ||
        request.frame < 0 ||
        request.frame >= (p.media.kind === "photo" ? 1 : 3) ||
        !integer(request.attempt) ||
        request.attempt > 3 ||
        (request.engine === "openai" && request.provider !== "openai") ||
        (request.engine === "safesearch" && request.provider !== "vision")
      )
        invalid();
      if (p.expiresAt <= Date.now()) return { allowed: false };
      const r = await rpc(refFor(p), "reserve", { plan: p, ...request });
      if (exact(r, ["code"]) && refusals.includes(r.code as Refusal))
        return { allowed: false };
      if (r.code === "QUOTA") {
        if (
          !exact(r, ["code", "allowed", "retryAfterSeconds"]) ||
          r.allowed !== false ||
          !integer(r.retryAfterSeconds) ||
          r.retryAfterSeconds > 3600
        )
          failed();
        return { allowed: false, retryAfterSeconds: r.retryAfterSeconds };
      }
      if (
        !exact(r, ["code", "allowed"]) ||
        !["RESERVED", "RESERVED_ALREADY", "QUOTA_UNCONFIGURED"].includes(
          r.code as string,
        ) ||
        r.allowed !== (r.code === "RESERVED")
      )
        failed();
      return { allowed: r.allowed === true && p.expiresAt > Date.now() };
    },
    async finish(value: ModerationPlan, result: MediaModerationResult) {
      const p = snapshotModerationPlan(value);
      const proof = evidence(result);
      if (proof.policyVersion !== p.policy.version) invalid();
      const r = await rpc(refFor(p), "finish", { plan: p, result: proof });
      if (
        !exact(r, ["code"]) ||
        !["RECORDED", ...refusals].includes(r.code as string)
      )
        failed();
      return { code: r.code as "RECORDED" | Refusal };
    },
  });
}
