import { originalKey, videoTrimTargetsSeconds } from "@koko/contract";
import { AwsClient } from "aws4fetch";

/** Internal DB claim. Never accept this object as browser/webhook authorization. */
export type StreamScope = Readonly<{
  eventId: string;
  postId: string;
  assetId: string;
  jobId: string;
  leaseId: string;
  postVersion: number;
  expiresAt: number;
}>;
export type StreamReference = Readonly<{
  uid: string;
  operationId: string;
  sourceUid: string | null;
}>;
export type StreamObservation = {
  reference: StreamReference;
  state: "pending" | "ready" | "error";
  requireSignedURLs: true;
  readyToStream: boolean;
  processingComplete: boolean;
  measuredDurationSeconds: number | null;
  width: number | null;
  height: number | null;
  modifiedAt: string;
};
export type StreamFrame = {
  index: number;
  seconds: number;
  contentType: "image/jpeg";
  width: number;
  height: number;
  sha256: string;
  bytes: Uint8Array;
};
type Failure =
  | "INVALID_CONFIG"
  | "INVALID_INPUT"
  | "STALE"
  | "TIMEOUT"
  | "ABORTED"
  | "BUSY"
  | "ORIGINAL_MISMATCH"
  | "PROVIDER_REJECTED"
  | "PROVIDER_FAILED"
  | "INVALID_RESPONSE"
  | "RESOURCE_LIMIT"
  | "AMBIGUOUS_CREATE"
  | "NOT_READY"
  | "VIDEO_TOO_LONG"
  | "BAD_SIGNATURE"
  | "DUPLICATE_OPERATION"
  | "QUOTA";
export class StreamProcessingError extends Error {
  constructor(readonly code: Failure) {
    super(code);
    this.name = "StreamProcessingError";
  }
}
function fail(code: Failure): never {
  throw new StreamProcessingError(code);
}
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const exact = (x: object, keys: readonly string[]) =>
  Object.keys(x).length === keys.length &&
  keys.every((k) => Object.hasOwn(x, k));
const id = (x: unknown): x is string =>
  typeof x === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    x,
  );
const uid = (x: unknown): x is string =>
  typeof x === "string" && /^[a-f0-9]{32}$/.test(x);
const positive = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const finitePositive = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x) && x > 0;
const validOrigins = (origins: readonly string[]) =>
  origins.length >= 1 &&
  origins.length <= 5 &&
  new Set(origins).size === origins.length &&
  origins.every(
    (x) =>
      typeof x === "string" &&
      x.length <= 253 &&
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(x),
  );
const uuidFields = [
  "eventId",
  "postId",
  "assetId",
  "jobId",
  "leaseId",
] as const;
function scope(input: StreamScope): StreamScope {
  let x: unknown;
  try {
    x = structuredClone(input);
  } catch {
    return fail("INVALID_INPUT");
  }
  if (
    !object(x) ||
    !exact(x, [...uuidFields, "postVersion", "expiresAt"]) ||
    uuidFields.some((k) => !id(x[k])) ||
    !positive(x.postVersion) ||
    !positive(x.expiresAt)
  )
    fail("INVALID_INPUT");
  return Object.freeze(x) as StreamScope;
}
function reference(input: StreamReference): StreamReference {
  if (
    !object(input) ||
    !exact(input, ["uid", "operationId", "sourceUid"]) ||
    !uid(input.uid) ||
    !id(input.operationId) ||
    (input.sourceUid !== null &&
      (!uid(input.sourceUid) || input.sourceUid === input.uid))
  )
    fail("INVALID_INPUT");
  return Object.freeze({ ...input });
}
const operationName = (operationId: string) => `koko-${operationId}`;
function metadata(
  s: StreamScope,
  operationId: string,
  sourceUid: string | null,
) {
  return {
    name: operationName(operationId),
    koko_event: s.eventId,
    koko_post: s.postId,
    koko_asset: s.assetId,
    koko_job: s.jobId,
    koko_version: String(s.postVersion),
    koko_operation: operationId,
    koko_source: sourceUid ?? "original",
  };
}
const digest = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
function stop(signal: AbortSignal) {
  if (signal.aborted) fail("ABORTED");
}

async function bounded<T>(
  ms: number,
  outer: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  outer?.addEventListener("abort", abort, { once: true });
  if (outer?.aborted) abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        stop(controller.signal);
        return operation(controller.signal);
      }),
      new Promise<never>((_, reject) => {
        const onAbort = () =>
          reject(new StreamProcessingError(expired ? "TIMEOUT" : "ABORTED"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
        timer = setTimeout(() => {
          expired = true;
          controller.abort();
        }, ms);
      }),
    ]);
  } catch (error) {
    if (error instanceof StreamProcessingError) throw error;
    return fail("PROVIDER_FAILED");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    outer?.removeEventListener("abort", abort);
    controller.abort();
  }
}

async function readBytes(
  response: Response | Request,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  const encoding = response.headers.get("content-encoding");
  if (
    (encoding !== null && encoding !== "identity") ||
    (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > limit))
  )
    fail("RESOURCE_LIMIT");
  const reader = response.body?.getReader();
  if (!reader) fail("INVALID_RESPONSE");
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      stop(signal);
      const chunk = await reader.read();
      stop(signal);
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > limit) fail("RESOURCE_LIMIT");
      chunks.push(chunk.value);
    }
    if (length !== null && Number(length) !== size) fail("INVALID_RESPONSE");
    const all = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      all.set(c, offset);
      offset += c.length;
    }
    return all;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}
function json(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
  } catch {
    return fail("INVALID_RESPONSE");
  }
}
function observation(
  value: unknown,
  s: Pick<
    StreamScope,
    "eventId" | "postId" | "assetId" | "jobId" | "postVersion"
  >,
  ref: StreamReference,
  allowedOrigins: readonly string[],
): StreamObservation {
  if (
    !object(value) ||
    value.uid !== ref.uid ||
    value.requireSignedURLs !== true ||
    !object(value.meta) ||
    !object(value.status) ||
    !Array.isArray(value.allowedOrigins) ||
    value.allowedOrigins.length !== allowedOrigins.length ||
    allowedOrigins.some(
      (origin) => !(value.allowedOrigins as unknown[]).includes(origin),
    ) ||
    (ref.sourceUid === null
      ? value.clippedFrom !== undefined &&
        value.clippedFrom !== null &&
        value.clippedFrom !== ""
      : value.clippedFrom !== ref.sourceUid)
  )
    fail("INVALID_RESPONSE");
  const expected = metadata(s as StreamScope, ref.operationId, ref.sourceUid);
  for (const [key, wanted] of Object.entries(expected))
    if (value.meta[key] !== wanted) fail("INVALID_RESPONSE");
  if (
    typeof value.modified !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(
      value.modified,
    ) ||
    !Number.isFinite(Date.parse(value.modified))
  )
    fail("INVALID_RESPONSE");
  const state = value.status.state;
  if (
    ![
      "pendingupload",
      "downloading",
      "queued",
      "inprogress",
      "ready",
      "error",
    ].includes(state as string)
  )
    fail("INVALID_RESPONSE");
  const percentage = value.status.pctComplete;
  if (
    percentage !== undefined &&
    (typeof percentage !== "string" ||
      !/^(?:100(?:\.0+)?|[0-9]{1,2}(?:\.[0-9]+)?)$/.test(percentage))
  )
    fail("INVALID_RESPONSE");
  const ready = value.readyToStream === true;
  if (
    value.readyToStream !== undefined &&
    typeof value.readyToStream !== "boolean"
  )
    fail("INVALID_RESPONSE");
  const complete = state === "ready" && Number(percentage) === 100 && ready;
  const duration = finitePositive(value.duration) ? value.duration : null;
  const width =
    object(value.input) && positive(value.input.width)
      ? value.input.width
      : null;
  const height =
    object(value.input) && positive(value.input.height)
      ? value.input.height
      : null;
  if (
    complete &&
    (duration === null ||
      duration > 36000 ||
      width === null ||
      height === null ||
      width > 16384 ||
      height > 16384)
  )
    fail("INVALID_RESPONSE");
  return {
    reference: ref,
    state: state === "error" ? "error" : complete ? "ready" : "pending",
    requireSignedURLs: true,
    readyToStream: ready,
    processingComplete: complete,
    measuredDurationSeconds: duration,
    width,
    height,
    modifiedAt: value.modified,
  };
}

export function planStreamPoll(
  video: StreamObservation,
  attempt: number,
  maxAttempts: number,
):
  | { state: "wait"; retryAfterSeconds: number }
  | { state: "ready" | "clip_required" | "held" } {
  if (
    !positive(attempt) ||
    !positive(maxAttempts) ||
    maxAttempts > 60 ||
    attempt > maxAttempts
  )
    fail("INVALID_INPUT");
  if (video.state === "error") return { state: "held" };
  if (
    video.state === "ready" &&
    video.processingComplete &&
    video.readyToStream &&
    video.requireSignedURLs === true &&
    finitePositive(video.measuredDurationSeconds)
  )
    return {
      state: video.measuredDurationSeconds <= 4 ? "ready" : "clip_required",
    };
  return attempt === maxAttempts
    ? { state: "held" }
    : {
        state: "wait",
        retryAfterSeconds: Math.min(60, 5 * 2 ** Math.min(attempt - 1, 4)),
      };
}
export function streamFrameTimes(duration: number): readonly number[] {
  if (!finitePositive(duration) || duration > 4) fail("VIDEO_TOO_LONG");
  const times = [duration / 6, duration / 2, (duration * 5) / 6].map(
    (x) => Math.round(x * 1e6) / 1e6,
  );
  if (times.some((x) => x <= 0 || x >= duration) || new Set(times).size !== 3)
    fail("INVALID_INPUT");
  return Object.freeze(times);
}
function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (
    bytes.length < 12 ||
    bytes[0] !== 255 ||
    bytes[1] !== 216 ||
    bytes.at(-2) !== 255 ||
    bytes.at(-1) !== 217
  )
    fail("INVALID_RESPONSE");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 255) fail("INVALID_RESPONSE");
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || offset + 2 > bytes.length || marker === 218)
      fail("INVALID_RESPONSE");
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length - 2)
      fail("INVALID_RESPONSE");
    if (marker === 192 || marker === 194) {
      if (length < 8) fail("INVALID_RESPONSE");
      const height = view.getUint16(offset + 3);
      const width = view.getUint16(offset + 5);
      if (!width || !height || Math.max(width, height) > 1024)
        fail("RESOURCE_LIMIT");
      return { width, height };
    }
    offset += length;
  }
  return fail("INVALID_RESPONSE");
}

export type StreamAction = {
  action: "copy" | "clip" | "inspect" | "reconcile" | "frames";
  operationId: string;
  uid: string | null;
  sourceUid: string | null;
};
export type StreamProcessingOptions = {
  enabled?: boolean;
  accountId?: string;
  originalsBucketName?: string;
  originalReadAccessKeyId?: string;
  originalReadSecretAccessKey?: string;
  originals?: Pick<R2Bucket, "head">;
  /** Deployment-selected exact hostname, never a payload URL. */
  customerHost?: string;
  /** Exact site hostnames; no wildcard or empty list. Server-side requests use the first origin. */
  allowedOrigins?: readonly string[];
  /** Service-verified original provider generations for read-only recovery of durable operations.
   * These are NOT authorization scopes: isCurrent always receives the current job/lease/version. */
  providerGenerations?: readonly {
    operationId: string;
    jobId: string;
    postVersion: number;
  }[];
  apiToken?: (signal: AbortSignal) => Promise<string>;
  /** Read DB lease/version/BAN/deletion/stops and durable operation reservation, not client booleans. */
  isCurrent?: (
    scope: StreamScope,
    action: StreamAction,
    signal: AbortSignal,
  ) => Promise<boolean>;
  fetcher?: typeof fetch;
  clock?: () => number;
  timeoutMs?: number;
};

/** Provider primitives only: no global routes, Queue ACK, DB completion, publication or deletion. */
export function createStreamProcessingAdapter(
  options: StreamProcessingOptions = {},
) {
  if (options.enabled !== true) return null;
  const {
    accountId,
    originalsBucketName,
    originalReadAccessKeyId,
    originalReadSecretAccessKey,
    originals,
    customerHost,
    apiToken,
    isCurrent,
    fetcher = fetch,
    clock = Date.now,
    timeoutMs = 15000,
  } = options;
  const allowedOrigins = options.allowedOrigins
    ? [...options.allowedOrigins]
    : [];
  const generations = options.providerGenerations
    ? structuredClone(options.providerGenerations)
    : [];
  if (
    generations.length > 2 ||
    new Set(generations.map((g) => g.operationId)).size !==
      generations.length ||
    generations.some(
      (g) =>
        !object(g) ||
        !exact(g, ["operationId", "jobId", "postVersion"]) ||
        !id(g.operationId) ||
        !id(g.jobId) ||
        !positive(g.postVersion) ||
        g.postVersion > 2147483647,
    )
  )
    fail("INVALID_CONFIG");
  function evidenceScope(s: StreamScope, operationId: string): StreamScope {
    const generation = generations.find((g) => g.operationId === operationId);
    if (!generation) return s;
    if (
      generation.postVersion > s.postVersion ||
      (generation.postVersion === s.postVersion && generation.jobId !== s.jobId)
    )
      fail("INVALID_INPUT");
    return {
      ...s,
      jobId: generation.jobId,
      postVersion: generation.postVersion,
    };
  }
  if (
    !uid(accountId) ||
    !originalsBucketName ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(originalsBucketName) ||
    !uid(originalReadAccessKeyId) ||
    !/^[a-f0-9]{64}$/.test(originalReadSecretAccessKey ?? "") ||
    !originals ||
    typeof originals.head !== "function" ||
    !customerHost ||
    !/^customer-[a-z0-9]{1,64}\.cloudflarestream\.com$/.test(customerHost) ||
    !validOrigins(allowedOrigins) ||
    typeof apiToken !== "function" ||
    typeof isCurrent !== "function" ||
    typeof fetcher !== "function" ||
    typeof clock !== "function" ||
    !positive(timeoutMs) ||
    timeoutMs > 15000
  )
    fail("INVALID_CONFIG");
  const apiBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream`;
  const storageOrigin = `https://${accountId}.r2.cloudflarestorage.com`;
  const signer = new AwsClient({
    accessKeyId: originalReadAccessKeyId,
    secretAccessKey: originalReadSecretAccessKey!,
    service: "s3",
    region: "auto",
    retries: 0,
  });
  const head = originals.head.bind(originals);
  let active = false;
  async function check(
    s: StreamScope,
    action: StreamAction,
    signal: AbortSignal,
  ) {
    stop(signal);
    if (
      !Number.isFinite(clock()) ||
      clock() >= s.expiresAt ||
      (await isCurrent!(s, Object.freeze({ ...action }), signal)) !== true
    )
      fail("STALE");
    stop(signal);
    if (clock() >= s.expiresAt) fail("STALE");
  }
  async function api(
    s: StreamScope,
    path: string,
    body: object | undefined,
    signal: AbortSignal,
    submitted?: () => void,
  ): Promise<unknown> {
    stop(signal);
    const token = await apiToken!(signal);
    stop(signal);
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{8,1024}$/.test(token))
      fail("INVALID_CONFIG");
    if (!Number.isFinite(clock()) || clock() >= s.expiresAt) fail("STALE");
    submitted?.();
    const response = await fetcher(apiBase + path, {
      method: body ? "POST" : "GET",
      redirect: "manual",
      cache: "no-store",
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "accept-encoding": "identity",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    try {
      stop(signal);
      if (response.status === 429) fail("QUOTA");
      if (response.status >= 400 && response.status < 500)
        fail("PROVIDER_REJECTED");
      if (
        response.status !== 200 ||
        response.redirected ||
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      )
        fail("PROVIDER_FAILED");
      const value = json(await readBytes(response, 65536, signal));
      if (
        !object(value) ||
        value.success !== true ||
        !Array.isArray(value.errors) ||
        value.errors.length !== 0 ||
        !Object.hasOwn(value, "result")
      )
        fail("INVALID_RESPONSE");
      return value.result;
    } finally {
      if (!response.bodyUsed) void response.body?.cancel().catch(() => {});
    }
  }
  async function execute<T>(
    input: StreamScope,
    action: StreamAction,
    fn: (
      s: StreamScope,
      signal: AbortSignal,
      submitted: () => void,
    ) => Promise<T>,
    outer?: AbortSignal,
  ): Promise<T> {
    if (active) fail("BUSY");
    if (
      !id(action.operationId) ||
      (action.uid !== null && !uid(action.uid)) ||
      (action.sourceUid !== null && !uid(action.sourceUid))
    )
      fail("INVALID_INPUT");
    const s = scope(input);
    const a = Object.freeze({ ...action });
    active = true;
    let submitted = false;
    try {
      return await bounded(timeoutMs, outer, async (signal) => {
        await check(s, a, signal);
        const result = await fn(s, signal, () => {
          stop(signal);
          submitted = true;
        });
        await check(s, a, signal);
        return result;
      });
    } catch (error) {
      // Once a creation may have reached the provider, even local stale/abort is ambiguous.
      if (
        submitted &&
        !(
          error instanceof StreamProcessingError &&
          ["PROVIDER_REJECTED", "QUOTA"].includes(error.code)
        )
      )
        fail("AMBIGUOUS_CREATE");
      if (error instanceof StreamProcessingError) throw error;
      return fail("PROVIDER_FAILED");
    } finally {
      active = false;
    }
  }
  async function inspectInternal(
    s: StreamScope,
    ref: StreamReference,
    signal: AbortSignal,
  ) {
    return observation(
      await api(s, `/${ref.uid}`, undefined, signal),
      evidenceScope(s, ref.operationId),
      ref,
      allowedOrigins,
    );
  }
  return {
    async copy(
      input: StreamScope,
      operationId: string,
      original: { size: number; etag: string },
      signal?: AbortSignal,
    ): Promise<StreamObservation> {
      if (generations.some((g) => g.operationId === operationId))
        fail("DUPLICATE_OPERATION");
      if (
        !object(original) ||
        !exact(original, ["size", "etag"]) ||
        !positive(original.size) ||
        typeof original.etag !== "string" ||
        !/^[a-f0-9]{32}(?:-[1-9][0-9]{0,4})?$/.test(original.etag)
      )
        fail("INVALID_INPUT");
      const source = { ...original };
      return execute(
        input,
        { action: "copy", operationId, uid: null, sourceUid: null },
        async (s, activeSignal, submitted) => {
          const key = originalKey(s.eventId, s.postId, s.assetId);
          const found = await head(key);
          stop(activeSignal);
          if (
            !found ||
            found.key !== key ||
            found.size !== source.size ||
            found.etag !== source.etag
          )
            fail("ORIGINAL_MISMATCH");
          const now = Math.floor(clock() / 1000) * 1000;
          const url = new URL(`/${originalsBucketName}/${key}`, storageOrigin);
          url.searchParams.set("X-Amz-Expires", "300");
          const signed = await signer.sign(url, {
            method: "GET",
            redirect: "manual",
            aws: {
              signQuery: true,
              datetime: new Date(now).toISOString().replace(/[:-]|\.000/g, ""),
            },
          });
          await check(
            s,
            { action: "copy", operationId, uid: null, sourceUid: null },
            activeSignal,
          );
          const result = await api(
            s,
            "/copy",
            {
              input: signed.url,
              requireSignedURLs: true,
              allowedOrigins,
              meta: metadata(s, operationId, null),
            },
            activeSignal,
            submitted,
          );
          if (!object(result) || !uid(result.uid)) fail("INVALID_RESPONSE");
          return observation(
            result,
            s,
            { uid: result.uid, operationId, sourceUid: null },
            allowedOrigins,
          );
        },
        signal,
      );
    },
    async clip(
      input: StreamScope,
      operationId: string,
      source: StreamReference,
      target: number = 3.8,
      signal?: AbortSignal,
    ): Promise<StreamObservation> {
      if (generations.some((g) => g.operationId === operationId))
        fail("DUPLICATE_OPERATION");
      const ref = reference(source);
      if (
        ref.sourceUid !== null ||
        ref.operationId === operationId ||
        !videoTrimTargetsSeconds.includes(target as 3.8 | 3.5 | 3)
      )
        fail("INVALID_INPUT");
      return execute(
        input,
        { action: "clip", operationId, uid: ref.uid, sourceUid: ref.uid },
        async (s, activeSignal, submitted) => {
          const current = await inspectInternal(s, ref, activeSignal);
          if (!current.processingComplete || current.state !== "ready")
            fail("NOT_READY");
          if (!finitePositive(current.measuredDurationSeconds))
            fail("INVALID_INPUT");
          await check(
            s,
            { action: "clip", operationId, uid: ref.uid, sourceUid: ref.uid },
            activeSignal,
          );
          const result = await api(
            s,
            "/clip",
            {
              clippedFromVideoUID: ref.uid,
              startTimeSeconds: 0,
              // Full-video fallback still creates its independently tracked clip when the original
              // is already short. Never request a timestamp beyond the measured source duration.
              endTimeSeconds: Math.min(
                target,
                current.measuredDurationSeconds!,
              ),
              requireSignedURLs: true,
              allowedOrigins,
              meta: metadata(s, operationId, ref.uid),
            },
            activeSignal,
            submitted,
          );
          if (!object(result) || !uid(result.uid) || result.uid === ref.uid)
            fail("INVALID_RESPONSE");
          return observation(
            result,
            s,
            { uid: result.uid, operationId, sourceUid: ref.uid },
            allowedOrigins,
          );
        },
        signal,
      );
    },
    async inspect(
      input: StreamScope,
      inputReference: StreamReference,
      signal?: AbortSignal,
    ): Promise<StreamObservation> {
      const ref = reference(inputReference);
      return execute(
        input,
        {
          action: "inspect",
          operationId: ref.operationId,
          uid: ref.uid,
          sourceUid: ref.sourceUid,
        },
        (s, activeSignal) => inspectInternal(s, ref, activeSignal),
        signal,
      );
    },
    async reconcile(
      input: StreamScope,
      operationId: string,
      sourceUid: string | null,
      signal?: AbortSignal,
    ): Promise<
      { state: "not_found" } | { state: "found"; video: StreamObservation }
    > {
      return execute(
        input,
        { action: "reconcile", operationId, uid: null, sourceUid },
        async (s, activeSignal) => {
          const result = await api(
            s,
            `?video_name=${encodeURIComponent(operationName(operationId))}&limit=2`,
            undefined,
            activeSignal,
          );
          if (!Array.isArray(result) || result.length > 2)
            fail("INVALID_RESPONSE");
          if (result.length === 0) return { state: "not_found" } as const;
          if (result.length > 1) fail("DUPLICATE_OPERATION");
          const video: unknown = result[0];
          if (!object(video) || !uid(video.uid)) fail("INVALID_RESPONSE");
          return {
            state: "found",
            video: observation(
              video,
              evidenceScope(s, operationId),
              { uid: video.uid, operationId, sourceUid },
              allowedOrigins,
            ),
          } as const;
        },
        signal,
      );
    },
    /** Private in-memory frames. Cloud Run must decode/strip metadata before feeding AI. */
    async frames(
      input: StreamScope,
      inputReference: StreamReference,
      signal?: AbortSignal,
    ): Promise<{ video: StreamObservation; frames: StreamFrame[] }> {
      const ref = reference(inputReference);
      return execute(
        input,
        {
          action: "frames",
          operationId: ref.operationId,
          uid: ref.uid,
          sourceUid: ref.sourceUid,
        },
        async (s, activeSignal) => {
          const video = await inspectInternal(s, ref, activeSignal);
          if (
            !video.processingComplete ||
            video.state !== "ready" ||
            !video.measuredDurationSeconds
          )
            fail("NOT_READY");
          const times = streamFrameTimes(video.measuredDurationSeconds);
          const now = Math.floor(clock() / 1000);
          const issued = await api(
            s,
            `/${ref.uid}/token`,
            { exp: now + 60, nbf: now - 5, downloadable: false },
            activeSignal,
          );
          if (
            !object(issued) ||
            typeof issued.token !== "string" ||
            issued.token.length > 8192 ||
            !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
              issued.token,
            )
          )
            fail("INVALID_RESPONSE");
          const payloadPart = issued.token.split(".")[1]!;
          let claims: unknown;
          try {
            claims = json(
              Uint8Array.from(
                atob(payloadPart.replaceAll("-", "+").replaceAll("_", "/")),
                (c) => c.charCodeAt(0),
              ),
            );
          } catch {
            return fail("INVALID_RESPONSE");
          }
          if (
            !object(claims) ||
            claims.sub !== ref.uid ||
            !positive(claims.exp) ||
            claims.exp > now + 60 ||
            claims.exp <= now ||
            (claims.downloadable !== undefined &&
              claims.downloadable !== false) ||
            claims.flags !== undefined ||
            (claims.nbf !== undefined &&
              (!positive(claims.nbf) || claims.nbf > now))
          )
            fail("INVALID_RESPONSE");
          const frames: StreamFrame[] = [];
          for (const [index, seconds] of times.entries()) {
            await check(
              s,
              {
                action: "frames",
                operationId: ref.operationId,
                uid: ref.uid,
                sourceUid: ref.sourceUid,
              },
              activeSignal,
            );
            if (clock() / 1000 >= claims.exp) fail("STALE");
            const url = new URL(
              `/${issued.token}/thumbnails/thumbnail.jpg`,
              `https://${customerHost}`,
            );
            url.searchParams.set("time", `${seconds}s`);
            url.searchParams.set("width", "1024");
            url.searchParams.set("height", "1024");
            url.searchParams.set("fit", "clip");
            const response = await fetcher(url, {
              method: "GET",
              redirect: "manual",
              cache: "no-store",
              signal: activeSignal,
              headers: {
                accept: "image/jpeg",
                "accept-encoding": "identity",
                origin: `https://${allowedOrigins[0]}`,
              },
            });
            try {
              stop(activeSignal);
              if (
                response.status !== 200 ||
                response.redirected ||
                response.headers
                  .get("content-type")
                  ?.split(";")[0]
                  ?.trim()
                  .toLowerCase() !== "image/jpeg"
              )
                fail("INVALID_RESPONSE");
              const bytes = await readBytes(
                response,
                4 * 1024 * 1024,
                activeSignal,
              );
              frames.push({
                index,
                seconds,
                contentType: "image/jpeg",
                ...jpegDimensions(bytes),
                sha256: await digest(bytes),
                bytes,
              });
            } finally {
              if (!response.bodyUsed)
                void response.body?.cancel().catch(() => {});
            }
          }
          // Re-read provider state as well as DB after all reads; do not return a partially accepted batch.
          const after = await inspectInternal(s, ref, activeSignal);
          if (
            after.modifiedAt !== video.modifiedAt ||
            after.measuredDurationSeconds !== video.measuredDurationSeconds ||
            after.state !== "ready"
          )
            fail("STALE");
          return { video: after, frames };
        },
        signal,
      );
    },
  };
}

export type VerifiedStreamNotification = {
  bodySha256: string;
  sentAt: number;
  eventId: string;
  postId: string;
  assetId: string;
  jobId: string;
  postVersion: number;
  video: StreamObservation;
};
/** Signature proves provider origin, not KOKO ownership. Persist only after atomic DB comparison. */
export function createStreamWebhookVerifier(
  options: {
    enabled?: boolean;
    secret?: string;
    allowedOrigins?: readonly string[];
    clock?: () => number;
    timeoutMs?: number;
  } = {},
) {
  if (options.enabled !== true) return null;
  const { secret, clock = Date.now, timeoutMs = 5000 } = options;
  const allowedOrigins = options.allowedOrigins
    ? [...options.allowedOrigins]
    : [];
  if (
    typeof secret !== "string" ||
    !/^[\x21-\x7e]{16,256}$/.test(secret) ||
    !positive(timeoutMs) ||
    timeoutMs > 5000 ||
    typeof clock !== "function" ||
    !validOrigins(allowedOrigins)
  )
    fail("INVALID_CONFIG");
  return async (request: Request): Promise<VerifiedStreamNotification> =>
    bounded(timeoutMs, request.signal, async (signal) => {
      if (
        request.method !== "POST" ||
        !/^application\/json(?:\s*;|$)/i.test(
          request.headers.get("content-type") ?? "",
        )
      )
        fail("BAD_SIGNATURE");
      const signature = request.headers.get("webhook-signature");
      const match = /^time=([0-9]{1,12}),sig1=([a-f0-9]{64})$/.exec(
        signature ?? "",
      );
      const now = Math.floor(clock() / 1000);
      if (
        !match ||
        !Number.isSafeInteger(now) ||
        now - Number(match[1]) > 300 ||
        Number(match[1]) - now > 30
      )
        fail("BAD_SIGNATURE");
      const body = await readBytes(request, 65536, signal);
      const prefix = new TextEncoder().encode(`${match[1]}.`);
      const signed = new Uint8Array(prefix.length + body.length);
      signed.set(prefix);
      signed.set(body, prefix.length);
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const received = Uint8Array.from(match[2]!.match(/.{2}/g)!, (x) =>
        parseInt(x, 16),
      );
      if (!(await crypto.subtle.verify("HMAC", key, received, signed)))
        fail("BAD_SIGNATURE");
      stop(signal);
      const value = json(body);
      if (!object(value) || !object(value.meta) || !uid(value.uid))
        fail("INVALID_RESPONSE");
      const m = value.meta;
      if (
        !id(m.koko_event) ||
        !id(m.koko_post) ||
        !id(m.koko_asset) ||
        !id(m.koko_job) ||
        !id(m.koko_operation) ||
        typeof m.koko_version !== "string" ||
        !/^[1-9][0-9]{0,9}$/.test(m.koko_version) ||
        !(m.koko_source === "original" || uid(m.koko_source))
      )
        fail("INVALID_RESPONSE");
      const identity = {
        eventId: m.koko_event,
        postId: m.koko_post,
        assetId: m.koko_asset,
        jobId: m.koko_job,
        postVersion: Number(m.koko_version),
      };
      const ref = reference({
        uid: value.uid,
        operationId: m.koko_operation,
        sourceUid: m.koko_source === "original" ? null : m.koko_source,
      });
      return {
        ...identity,
        bodySha256: await digest(body),
        sentAt: Number(match[1]),
        video: observation(value, identity, ref, allowedOrigins),
      };
    });
}

/** Run inside the caller's locked DB transaction; input must be the DB row, not webhook metadata. */
export function classifyStreamNotification(
  current: {
    eventId: string;
    postId: string;
    assetId: string;
    jobId: string;
    postVersion: number;
    reference: StreamReference;
    accepting: boolean;
    lastBodySha256: string | null;
    modifiedAt: string | null;
  },
  notification: VerifiedStreamNotification,
): "apply" | "duplicate" | "stale" | "conflict" {
  if (
    !current.accepting ||
    current.eventId !== notification.eventId ||
    current.postId !== notification.postId ||
    current.assetId !== notification.assetId ||
    current.jobId !== notification.jobId ||
    current.postVersion !== notification.postVersion ||
    current.reference.uid !== notification.video.reference.uid ||
    current.reference.operationId !==
      notification.video.reference.operationId ||
    current.reference.sourceUid !== notification.video.reference.sourceUid
  )
    return "stale";
  if (current.lastBodySha256 === notification.bodySha256) return "duplicate";
  if (current.modifiedAt !== null) {
    const before = Date.parse(current.modifiedAt);
    const after = Date.parse(notification.video.modifiedAt);
    if (!Number.isFinite(before) || !Number.isFinite(after)) return "conflict";
    if (after < before) return "stale";
    if (after === before) return "conflict";
  }
  return "apply";
}
