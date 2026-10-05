import { createHash } from "node:crypto";
import {
  moderationEngines,
  resolveModeration,
  type EngineResult,
  type ModerationDecision,
} from "@koko/contract";
import type { Derivative } from "./types.js";
import {
  estimateModerationCostUsd,
  snapshotModerationCostRates,
  type ModerationCostRates,
} from "./moderation-cost.js";

type Engine = EngineResult["engine"];
type Provider = "openai" | "vision";
export const moderationCategories = Object.freeze({
  openai: Object.freeze([
    "sexual",
    "violence",
    "violence/graphic",
    "self-harm",
    "self-harm/intent",
    "self-harm/instructions",
  ]),
  safesearch: Object.freeze(["adult", "spoof", "medical", "violence", "racy"]),
  ocr: Object.freeze([
    "sexual",
    "sexual/minors",
    "violence",
    "violence/graphic",
    "self-harm",
    "self-harm/intent",
    "self-harm/instructions",
    "harassment",
    "harassment/threatening",
    "hate",
    "hate/threatening",
    "illicit",
    "illicit/violent",
  ]),
});

/** Ordinal buckets, NOT probabilities; a changed mapping requires recalibration. */
export const safeSearchScoreVersion = "likelihood-ordinal-v1";
const likelihood: Readonly<Record<string, number>> = Object.freeze({
  VERY_UNLIKELY: 0,
  UNLIKELY: 0.25,
  POSSIBLE: 0.5,
  LIKELY: 0.75,
  VERY_LIKELY: 1,
});
export type ModerationThreshold = Readonly<{
  engine: Engine;
  category: string;
  flag: number;
  block: number;
  immediate_ban: boolean;
}>;
export type ModerationPolicy = Readonly<{
  approved: true;
  version: number;
  safeSearchScoreVersion: typeof safeSearchScoreVersion;
  // Deliberately explicit. No implicit latest-model upgrade or threshold defaults.
  openaiModel: "omni-moderation-2024-09-26";
  thresholds: readonly ModerationThreshold[];
  costRates?: ModerationCostRates;
}>;
export type ModerationMedia =
  | { kind: "photo"; image: Derivative }
  | {
      kind: "video";
      measuredDurationSeconds: number;
      frames: readonly { index: number; seconds: number; image: Derivative }[];
    };
type ErrorCode =
  | "INVALID_MEDIA"
  | "BUSY"
  | "ABORTED"
  | "TIMEOUT"
  | "QUOTA"
  | "CREDENTIALS"
  | "PROVIDER_REJECTED"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "RESOURCE_LIMIT";
export type ModerationAttemptStart = Readonly<{
  engine: Engine;
  frame: number;
  nextAttempt: number;
}>;
export type ModerationRun = {
  engine: Engine;
  frame: number;
  attempt: number;
  decision: ModerationDecision;
  modelVersion: string;
  scores: Record<string, number>;
  latencyMs: number;
  // Calls/features are measured; no unsupported price estimate is invented.
  usage: {
    openaiRequests: number;
    safeSearchImages: number;
    ocrImages: number;
  };
  estimatedCostUsd: number | null;
  costRateCard?: ModerationCostRates;
  observation: "scores" | "no_text" | "error";
  errorCode?: ErrorCode;
  retryAfterSeconds?: number;
};
export type MediaModerationResult = {
  decision: "PASS" | "FLAG" | "BLOCK" | "HELD";
  policyVersion: number;
  engines: EngineResult[];
  runs: ModerationRun[];
  categories: {
    engine: Engine;
    category: string;
    decision: "FLAG" | "BLOCK";
  }[];
  immediateBan: boolean;
  errorCode?: ErrorCode;
};
class ModerationError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
  }
}
function fail(code: ErrorCode): never {
  throw new ModerationError(code);
}
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const unit = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
const positive = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const exactKeys = (x: object, fields: readonly string[]) =>
  Object.keys(x).length === fields.length &&
  fields.every((k) => Object.hasOwn(x, k));

export function snapshotModerationPolicy(
  input: ModerationPolicy,
): ModerationPolicy {
  let value: unknown;
  try {
    value = structuredClone(input);
  } catch {
    throw new Error("INVALID_MODERATION_POLICY");
  }
  const invalid = () => {
    throw new Error("INVALID_MODERATION_POLICY");
  };
  if (
    !record(value) ||
    !exactKeys(value, [
      "approved",
      "version",
      "safeSearchScoreVersion",
      "openaiModel",
      "thresholds",
      ...(Object.hasOwn(value, "costRates") ? ["costRates"] : []),
    ]) ||
    value.approved !== true ||
    !positive(value.version) ||
    value.safeSearchScoreVersion !== safeSearchScoreVersion ||
    value.openaiModel !== "omni-moderation-2024-09-26" ||
    !Array.isArray(value.thresholds)
  )
    invalid();
  const policy = value as ModerationPolicy;
  if (Object.hasOwn(policy, "costRates")) {
    try {
      Object.assign(policy, {
        costRates: snapshotModerationCostRates(policy.costRates),
      });
    } catch {
      invalid();
    }
  }
  const seen = new Set<string>();
  for (const t of policy.thresholds) {
    if (
      !record(t) ||
      !exactKeys(t, ["engine", "category", "flag", "block", "immediate_ban"]) ||
      !moderationEngines.includes(t.engine) ||
      !moderationCategories[t.engine].includes(t.category) ||
      !unit(t.flag) ||
      !unit(t.block) ||
      t.flag > t.block ||
      typeof t.immediate_ban !== "boolean" ||
      seen.has(`${t.engine}:${t.category}`)
    )
      invalid();
    // Immediate BAN is limited to a conservative set of severe categories, never general nudity/spoof/medical.
    if (
      t.immediate_ban &&
      !(
        t.engine !== "safesearch" &&
        [
          "sexual/minors",
          "violence/graphic",
          "illicit/violent",
          "hate/threatening",
          "harassment/threatening",
        ].includes(t.category)
      )
    )
      invalid();
    seen.add(`${t.engine}:${t.category}`);
    Object.freeze(t);
  }
  if (seen.size !== Object.values(moderationCategories).flat().length)
    invalid();
  Object.freeze(policy.thresholds);
  return Object.freeze(policy);
}

/** Pure policy evaluation; unavailable scores never become zero/PASS. */
export function evaluateModerationScores(
  engine: Engine,
  scores: Readonly<Record<string, number>>,
  inputPolicy: ModerationPolicy,
): {
  decision: ModerationDecision;
  categories: MediaModerationResult["categories"];
  immediateBan: boolean;
} {
  const policy = snapshotModerationPolicy(inputPolicy);
  if (
    !moderationEngines.includes(engine) ||
    !record(scores) ||
    !exactKeys(scores, moderationCategories[engine]) ||
    Object.values(scores).some((x) => !unit(x))
  )
    return { decision: "ERROR", categories: [], immediateBan: false };
  const categories: MediaModerationResult["categories"] = [];
  let immediateBan = false;
  for (const t of policy.thresholds.filter((t) => t.engine === engine)) {
    const s = scores[t.category]!;
    if (s >= t.block) {
      categories.push({ engine, category: t.category, decision: "BLOCK" });
      immediateBan ||= t.immediate_ban;
    } else if (s >= t.flag)
      categories.push({ engine, category: t.category, decision: "FLAG" });
  }
  return {
    decision: categories.some((c) => c.decision === "BLOCK")
      ? "BLOCK"
      : categories.length
        ? "FLAG"
        : "PASS",
    categories,
    immediateBan,
  };
}

function aiBytes(d: unknown): Buffer {
  if (
    !record(d) ||
    !exactKeys(d, [
      "name",
      "contentType",
      "width",
      "height",
      "sha256",
      "bytes",
    ]) ||
    d.name !== "ai-1024.jpg" ||
    d.contentType !== "image/jpeg" ||
    !positive(d.width) ||
    !positive(d.height) ||
    Math.max(d.width, d.height) > 1024 ||
    !(d.bytes instanceof Uint8Array) ||
    d.bytes.byteLength < 4 ||
    d.bytes.byteLength > 4 * 1024 * 1024 ||
    typeof d.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(d.sha256)
  )
    fail("INVALID_MEDIA");
  const bytes = Buffer.from(d.bytes);
  if (
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9 ||
    createHash("sha256").update(bytes).digest("hex") !== d.sha256
  )
    fail("INVALID_MEDIA");
  // The trusted transform verifies the full JPEG. Check dimensions and reject metadata before egress too.
  let offset = 2;
  let dimensions = false;
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 0xff) fail("INVALID_MEDIA");
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || offset + 2 > bytes.length)
      fail("INVALID_MEDIA");
    if (marker === 0xda) {
      if (!dimensions) fail("INVALID_MEDIA");
      return bytes;
    }
    if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe)
      fail("INVALID_MEDIA");
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length - 2) fail("INVALID_MEDIA");
    if (marker === 0xc0 || marker === 0xc2) {
      if (
        dimensions ||
        length < 8 ||
        bytes.readUInt16BE(offset + 3) !== d.height ||
        bytes.readUInt16BE(offset + 5) !== d.width
      )
        fail("INVALID_MEDIA");
      dimensions = true;
    }
    offset += length;
  }
  return fail("INVALID_MEDIA");
}

function snapshotMedia(
  value: ModerationMedia,
): { frame: number; bytes: Buffer }[] {
  if (!record(value)) fail("INVALID_MEDIA");
  if (value.kind === "photo" && exactKeys(value, ["kind", "image"]))
    return [{ frame: 0, bytes: aiBytes(value.image) }];
  if (
    value.kind !== "video" ||
    !exactKeys(value, ["kind", "measuredDurationSeconds", "frames"]) ||
    typeof value.measuredDurationSeconds !== "number" ||
    !Number.isFinite(value.measuredDurationSeconds) ||
    value.measuredDurationSeconds <= 0 ||
    value.measuredDurationSeconds > 4 ||
    !Array.isArray(value.frames) ||
    value.frames.length !== 3
  )
    fail("INVALID_MEDIA");
  let previous = -1;
  return value.frames.map((f, index) => {
    if (
      !record(f) ||
      !exactKeys(f, ["index", "seconds", "image"]) ||
      f.index !== index ||
      typeof f.seconds !== "number" ||
      !Number.isFinite(f.seconds) ||
      f.seconds <= previous ||
      f.seconds <= 0 ||
      f.seconds >= value.measuredDurationSeconds
    )
      fail("INVALID_MEDIA");
    previous = f.seconds;
    return { frame: index, bytes: aiBytes(f.image) };
  });
}

function openaiScores(
  value: unknown,
  modality: "image" | "text",
  model: string,
): Record<string, number> {
  if (
    !record(value) ||
    value.model !== model ||
    !Array.isArray(value.results) ||
    value.results.length !== 1
  )
    fail("INVALID_RESPONSE");
  const r: unknown = value.results[0];
  if (
    !record(r) ||
    typeof r.flagged !== "boolean" ||
    !record(r.category_scores) ||
    !record(r.categories) ||
    !record(r.category_applied_input_types) ||
    r.type === "error"
  )
    fail("INVALID_RESPONSE");
  const categories =
    modality === "image"
      ? moderationCategories.openai
      : moderationCategories.ocr;
  // Reject a newly introduced or misspelled category rather than silently dropping it.
  for (const field of [
    r.category_scores,
    r.categories,
    r.category_applied_input_types,
  ])
    if (!exactKeys(field, moderationCategories.ocr)) fail("INVALID_RESPONSE");
  const scores: Record<string, number> = {};
  for (const category of moderationCategories.ocr) {
    const s = r.category_scores[category];
    const applied = r.category_applied_input_types[category];
    if (
      !unit(s) ||
      typeof r.categories[category] !== "boolean" ||
      !Array.isArray(applied) ||
      new Set(applied).size !== applied.length ||
      applied.some((x) => !["image", "text"].includes(x))
    )
      fail("INVALID_RESPONSE");
    if (categories.includes(category)) {
      if (!applied.includes(modality)) fail("INVALID_RESPONSE");
      scores[category] = s;
    } else if (
      s !== 0 ||
      r.categories[category] !== false ||
      applied.length !== 0
    )
      fail("INVALID_RESPONSE");
  }
  return scores;
}

function visionResult(value: unknown): Record<string, unknown> {
  if (
    !record(value) ||
    !Array.isArray(value.responses) ||
    value.responses.length !== 1 ||
    !record(value.responses[0])
  )
    fail("INVALID_RESPONSE");
  const r = value.responses[0];
  if (Object.hasOwn(r, "error")) {
    if (!record(r.error) || !Number.isInteger(r.error.code))
      fail("INVALID_RESPONSE");
    if (r.error.code === 8) throw new ModerationError("QUOTA", 60);
    if ([4, 13, 14].includes(r.error.code as number))
      fail("PROVIDER_UNAVAILABLE");
    fail("PROVIDER_REJECTED");
  }
  return r;
}
function safeSearchScores(value: unknown): Record<string, number> {
  const r = visionResult(value).safeSearchAnnotation;
  if (!record(r) || !exactKeys(r, moderationCategories.safesearch))
    fail("INVALID_RESPONSE");
  const result: Record<string, number> = {};
  for (const key of moderationCategories.safesearch) {
    const bucket = r[key];
    if (typeof bucket !== "string" || !Object.hasOwn(likelihood, bucket))
      fail("INVALID_RESPONSE");
    result[key] = likelihood[bucket]!;
  }
  return result;
}
function ocrText(value: unknown): string {
  const r = visionResult(value);
  if (
    Object.keys(r).some(
      (k) => !["fullTextAnnotation", "textAnnotations", "context"].includes(k),
    )
  )
    fail("INVALID_RESPONSE");
  const full = r.fullTextAnnotation;
  const annotations = r.textAnnotations;
  // Vision omits empty annotation fields; distinguish no detections from error/null.
  if (
    full === undefined &&
    (annotations === undefined ||
      (Array.isArray(annotations) && annotations.length === 0))
  )
    return "";
  if (!record(full) || typeof full.text !== "string") fail("INVALID_RESPONSE");
  if (Buffer.byteLength(full.text, "utf8") > 32768) fail("RESOURCE_LIMIT");
  return full.text;
}

const urls = Object.freeze({
  openai: "https://api.openai.com/v1/moderations",
  vision: "https://vision.googleapis.com/v1/images:annotate",
});
function retryAfter(value: string | null): number {
  return value && /^[0-9]{1,4}$/.test(value)
    ? Math.min(3600, Math.max(1, Number(value)))
    : 60;
}
const aborted = (signal: AbortSignal) => {
  if (signal.aborted) fail("ABORTED");
};
async function bodyJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const encoding = response.headers.get("content-encoding");
  if (encoding !== null && encoding !== "identity") fail("INVALID_RESPONSE");
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      response.headers.get("content-type") ?? "",
    )
  )
    fail("INVALID_RESPONSE");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 262144))
    fail("RESOURCE_LIMIT");
  if (!response.body) fail("INVALID_RESPONSE");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      aborted(signal);
      const part = await reader.read();
      aborted(signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 262144) fail("RESOURCE_LIMIT");
      chunks.push(part.value);
    }
    if (length !== null && size !== Number(length)) fail("INVALID_RESPONSE");
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      return fail("INVALID_RESPONSE");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
  }
}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(new ModerationError("ABORTED"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
}

export type MediaModeratorOptions = {
  enabled?: boolean;
  policy?: ModerationPolicy;
  /** Per instance only; reserveQuota must enforce the shared provider quota. */
  maxConcurrentJobs?: number;
  /** Durable per-job attempt positions. Omitted only for a new, unreserved job. */
  attemptStarts?: readonly ModerationAttemptStart[];
  openaiToken?: (signal: AbortSignal) => Promise<string>;
  visionToken?: (signal: AbortSignal) => Promise<string>;
  /** Trusted atomic shared limiter. Reserve BEFORE every provider call, including retries. */
  reserveQuota?: (request: {
    provider: Provider;
    feature: Engine;
    frame: number;
    attempt: number;
    units: 1;
    signal: AbortSignal;
  }) => Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
  fetcher?: typeof fetch;
  attemptTimeoutMs?: number;
  retryDelayMs?: number;
};

/**
 * Internal only. No env, original URLs, DB writes, publication, logs or live keys.
 * Input must originate from the checked image transform / checked video frames.
 * Success is evidence for a later atomic DB commit, never permission to publish.
 */
export function createMediaModerator(options: MediaModeratorOptions = {}): {
  moderate(
    media: ModerationMedia,
    signal?: AbortSignal,
  ): Promise<MediaModerationResult>;
} | null {
  if (options.enabled !== true) return null;
  const policy = snapshotModerationPolicy(options.policy!);
  const attemptStarts = options.attemptStarts?.map((x) => ({ ...x }));
  if (
    attemptStarts &&
    (attemptStarts.length < 3 ||
      attemptStarts.length > 9 ||
      new Set(attemptStarts.map((x) => `${x.engine}:${x.frame}`)).size !==
        attemptStarts.length ||
      attemptStarts.some(
        (x) =>
          !exactKeys(x, ["engine", "frame", "nextAttempt"]) ||
          !moderationEngines.includes(x.engine) ||
          !Number.isInteger(x.frame) ||
          x.frame < 0 ||
          x.frame > 2 ||
          !positive(x.nextAttempt) ||
          x.nextAttempt > 4,
      ))
  )
    throw new Error("INVALID_MODERATION_CONFIG");
  const {
    openaiToken,
    visionToken,
    reserveQuota,
    fetcher = fetch,
    maxConcurrentJobs,
    attemptTimeoutMs = 15000,
    retryDelayMs = 1000,
  } = options;
  if (
    typeof openaiToken !== "function" ||
    typeof visionToken !== "function" ||
    typeof reserveQuota !== "function" ||
    typeof fetcher !== "function" ||
    !positive(maxConcurrentJobs) ||
    maxConcurrentJobs > 32 ||
    !positive(attemptTimeoutMs) ||
    attemptTimeoutMs > 15000 ||
    !positive(retryDelayMs) ||
    retryDelayMs > 2000
  )
    throw new Error("INVALID_MODERATION_CONFIG");
  let active = 0;
  async function request(
    provider: Provider,
    engine: Engine,
    frame: number,
    attempt: number,
    body: unknown,
    signal: AbortSignal,
    usage: ModerationRun["usage"],
  ): Promise<unknown> {
    aborted(signal);
    const quota = await reserveQuota!({
      provider,
      feature: engine,
      frame,
      attempt,
      units: 1,
      signal,
    });
    aborted(signal);
    if (!record(quota) || quota.allowed !== true)
      throw new ModerationError(
        "QUOTA",
        record(quota) && positive(quota.retryAfterSeconds)
          ? Math.min(3600, quota.retryAfterSeconds)
          : 60,
      );
    let token: string;
    try {
      token = await (provider === "openai" ? openaiToken! : visionToken!)(
        signal,
      );
    } catch {
      return fail("CREDENTIALS");
    }
    aborted(signal);
    if (
      typeof token !== "string" ||
      !/^[A-Za-z0-9._~+/-]{8,8192}={0,2}$/.test(token)
    )
      fail("CREDENTIALS");
    if (provider === "openai") usage.openaiRequests++;
    else if (engine === "safesearch") usage.safeSearchImages++;
    else usage.ocrImages++;
    const response = await fetcher(urls[provider], {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
        "accept-encoding": "identity",
      },
      body: JSON.stringify(body),
    });
    try {
      aborted(signal);
      if (response.status === 429)
        throw new ModerationError(
          "QUOTA",
          retryAfter(response.headers.get("retry-after")),
        );
      if (response.status >= 500) fail("PROVIDER_UNAVAILABLE");
      if (response.status !== 200 || response.redirected)
        fail("PROVIDER_REJECTED");
      return await bodyJson(response, signal);
    } finally {
      if (!response.bodyUsed) void response.body?.cancel().catch(() => {});
    }
  }
  async function run(
    engine: Engine,
    frame: number,
    bytes: Buffer,
    outer: AbortSignal,
  ): Promise<ModerationRun[]> {
    const runs: ModerationRun[] = [];
    const first =
      attemptStarts?.find((x) => x.engine === engine && x.frame === frame)
        ?.nextAttempt ?? 1;
    for (let attempt = first; attempt <= 3; attempt++) {
      const start = performance.now();
      const controller = new AbortController();
      const stop = () => controller.abort();
      outer.addEventListener("abort", stop, { once: true });
      if (outer.aborted) stop();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timeout = false;
      const signal = controller.signal;
      const usage = { openaiRequests: 0, safeSearchImages: 0, ocrImages: 0 };
      let error: ModerationError | undefined;
      let scores: Record<string, number> = {};
      let noText = false;
      const modelVersion =
        engine === "openai"
          ? policy.openaiModel
          : engine === "safesearch"
            ? `vision-v1/builtin-stable/unreported/${safeSearchScoreVersion}`
            : `vision-v1/builtin-stable/unreported+${policy.openaiModel}`;
      try {
        scores = await Promise.race([
          (async () => {
            aborted(signal);
            const base64 = bytes.toString("base64");
            if (engine === "openai")
              return openaiScores(
                await request(
                  "openai",
                  engine,
                  frame,
                  attempt,
                  {
                    model: policy.openaiModel,
                    input: [
                      {
                        type: "image_url",
                        image_url: { url: `data:image/jpeg;base64,${base64}` },
                      },
                    ],
                  },
                  signal,
                  usage,
                ),
                "image",
                policy.openaiModel,
              );
            const vision = await request(
              "vision",
              engine,
              frame,
              attempt,
              {
                requests: [
                  {
                    image: { content: base64 },
                    features: [
                      {
                        type:
                          engine === "safesearch"
                            ? "SAFE_SEARCH_DETECTION"
                            : "DOCUMENT_TEXT_DETECTION",
                        model: "builtin/stable",
                      },
                    ],
                  },
                ],
              },
              signal,
              usage,
            );
            if (engine === "safesearch") return safeSearchScores(vision);
            const text = ocrText(vision);
            if (text.trim().length === 0) {
              noText = true;
              return {};
            }
            const result = await request(
              "openai",
              engine,
              frame,
              attempt,
              { model: policy.openaiModel, input: text },
              signal,
              usage,
            );
            return openaiScores(result, "text", policy.openaiModel);
          })(),
          new Promise<never>((_, reject) => {
            const onAbort = () =>
              reject(new ModerationError(timeout ? "TIMEOUT" : "ABORTED"));
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
            timer = setTimeout(() => {
              timeout = true;
              controller.abort();
            }, attemptTimeoutMs);
          }),
        ]);
      } catch (cause) {
        error = outer.aborted
          ? new ModerationError("ABORTED")
          : timeout
            ? new ModerationError("TIMEOUT")
            : cause instanceof ModerationError
              ? cause
              : new ModerationError("PROVIDER_UNAVAILABLE");
      } finally {
        clearTimeout(timer);
        outer.removeEventListener("abort", stop);
        controller.abort();
      }
      const decision = error
        ? "ERROR"
        : noText
          ? "PASS"
          : evaluateModerationScores(engine, scores, policy).decision;
      runs.push({
        engine,
        frame,
        attempt,
        decision,
        modelVersion,
        scores,
        latencyMs: Math.max(0, Math.round(performance.now() - start)),
        usage: { ...usage },
        estimatedCostUsd: estimateModerationCostUsd(policy.costRates, usage),
        ...(policy.costRates ? { costRateCard: policy.costRates } : {}),
        observation: error ? "error" : noText ? "no_text" : "scores",
        ...(error ? { errorCode: error.code } : {}),
        ...(error?.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: error.retryAfterSeconds }),
      });
      if (
        !error ||
        !["TIMEOUT", "PROVIDER_UNAVAILABLE"].includes(error.code) ||
        attempt === 3
      )
        break;
      try {
        await sleep(retryDelayMs * attempt, outer);
      } catch {
        break;
      }
    }
    return runs;
  }
  return {
    async moderate(media, signal = new AbortController().signal) {
      const held = (errorCode: ErrorCode): MediaModerationResult => ({
        decision: "HELD",
        policyVersion: policy.version,
        engines: moderationEngines.map((engine) => ({
          engine,
          decision: "ERROR",
        })),
        runs: [],
        categories: [],
        immediateBan: false,
        errorCode,
      });
      if (signal.aborted) return held("ABORTED");
      if (active >= maxConcurrentJobs!) return held("BUSY");
      active++;
      try {
        const frames = snapshotMedia(media);
        if (
          attemptStarts &&
          (attemptStarts.length !== frames.length * moderationEngines.length ||
            frames.some(({ frame }) =>
              moderationEngines.some(
                (engine) =>
                  !attemptStarts.some(
                    (x) => x.engine === engine && x.frame === frame,
                  ),
              ),
            ))
        )
          fail("INVALID_MEDIA");
        const runs = (
          await Promise.all(
            frames.flatMap(({ frame, bytes }) =>
              moderationEngines.map((engine) =>
                run(engine, frame, bytes, signal),
              ),
            ),
          )
        ).flat();
        const engines: EngineResult[] = [];
        const categories: MediaModerationResult["categories"] = [];
        let immediateBan = false;
        for (const engine of moderationEngines) {
          const finals = frames.map(({ frame }) =>
            runs.filter((r) => r.engine === engine && r.frame === frame).at(-1),
          );
          engines.push({
            engine,
            decision: finals.some((r) => r?.decision === "BLOCK")
              ? "BLOCK"
              : signal.aborted ||
                  finals.some((r) => !r || r.decision === "ERROR")
                ? "ERROR"
                : finals.some((r) => r?.decision === "FLAG")
                  ? "FLAG"
                  : "PASS",
          });
          for (const r of finals) {
            if (
              !r ||
              r.decision === "ERROR" ||
              Object.keys(r.scores).length === 0
            )
              continue;
            const evaluation = evaluateModerationScores(
              engine,
              r.scores,
              policy,
            );
            immediateBan ||= evaluation.immediateBan;
            for (const c of evaluation.categories) {
              const prior = categories.find(
                (x) => x.engine === c.engine && x.category === c.category,
              );
              if (!prior) categories.push(c);
              else if (c.decision === "BLOCK") prior.decision = "BLOCK";
            }
          }
        }
        return {
          decision: resolveModeration(engines),
          policyVersion: policy.version,
          engines,
          runs,
          categories,
          immediateBan,
          ...(signal.aborted ? { errorCode: "ABORTED" as const } : {}),
        };
      } catch (cause) {
        return held(
          cause instanceof ModerationError ? cause.code : "INVALID_MEDIA",
        );
      } finally {
        active--;
      }
    },
  };
}
