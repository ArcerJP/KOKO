import { deliveryKey, originalKey, type ApiErrorCode } from "@koko/contract";
import {
  decodeStreamChild,
  serveStream,
  type StreamDeliveryEnv,
} from "./stream-delivery";
import {
  authenticateApiRequest,
  failure,
  object,
  privateHeaders,
  uuid,
  type AccountEnv,
} from "./api-context";

export type MediaReadEnv = AccountEnv &
  StreamDeliveryEnv & {
    KOKO_MEDIA_DELIVERY_ENABLED?: string;
    KOKO_ADMIN_ORIGINALS_ENABLED?: string;
    ORIGINALS_BUCKET?: Pick<R2Bucket, "get">;
    DERIVED_BUCKET?: Pick<R2Bucket, "get">;
  };
export class MediaReadError extends Error {
  constructor(readonly code: ApiErrorCode) {
    super(code);
  }
}
const bad = (): never => {
  throw new MediaReadError("INTERNAL_ERROR");
};
export type ReadMediaInput = {
  action: "feed" | "post" | "asset" | "original";
  postId: string | null;
  resource: string | null;
  input: Record<string, unknown>;
};

/** Fresh Supabase Auth + bounded service RPC. Never follow an upstream redirect. */
export async function readMediaRpc(
  request: Request,
  env: AccountEnv,
  params: ReadMediaInput,
  fetcher: typeof fetch = fetch,
) {
  const deadline = new AbortController(),
    timer = setTimeout(() => deadline.abort(), 10_000);
  const signal = AbortSignal.any([request.signal, deadline.signal]);
  const upstream: typeof fetch = async (target, init) => {
    signal.throwIfAborted();
    const response = await fetcher(target, { ...init, signal });
    signal.throwIfAborted();
    if (
      !response.ok ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        response.headers.get("content-type") ?? "",
      ) ||
      !response.body
    ) {
      void response.body?.cancel().catch(() => {});
      return new Response(null, {
        status: [400, 401, 403].includes(response.status)
          ? response.status
          : 502,
      });
    }
    const reader = response.body.getReader(),
      decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    let text = "",
      size = 0;
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        const next = await reader.read();
        signal.throwIfAborted();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 512 * 1024) {
          abort();
          bad();
        }
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
      return new Response(text, {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    } finally {
      signal.removeEventListener("abort", abort);
      reader.releaseLock();
    }
  };
  try {
    const ctx = await authenticateApiRequest(request, env, upstream);
    if (!ctx.ok) throw new MediaReadError(ctx.code);
    const response = await upstream(
      new URL("/rest/v1/rpc/read_media", ctx.settings.url),
      {
        method: "POST",
        redirect: "manual",
        cache: "no-store",
        headers: {
          apikey: ctx.settings.secretKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          p_event_id: ctx.eventId.toLowerCase(),
          p_user_id: ctx.userId.toLowerCase(),
          p_action: params.action,
          p_post_id: params.postId,
          p_resource: params.resource,
          p_input: params.input,
        }),
      },
    );
    if (response.status !== 200) bad();
    const value: unknown = await response.json();
    if (!object(value)) return bad();
    const codes = [
      "FORBIDDEN",
      "NOT_FOUND",
      "INVALID_INPUT",
      "ACCOUNT_BANNED",
      "CONSENT_REQUIRED",
      "EVENT_CLOSED",
      "PUBLICATION_STOPPED",
      "STATE_CONFLICT",
      "INTERNAL_ERROR",
    ] as const;
    if (codes.includes(value.code as (typeof codes)[number]))
      throw new MediaReadError(value.code as (typeof codes)[number]);
    if (value.code !== "ok") bad();
    signal.throwIfAborted();
    return {
      value,
      eventId: ctx.eventId.toLowerCase(),
      userId: ctx.userId.toLowerCase(),
    };
  } finally {
    clearTimeout(timer);
  }
}
export function mediaFailure(error: unknown) {
  return failure(
    error instanceof MediaReadError ? error.code : "INTERNAL_ERROR",
  );
}
export type AuthorizedAsset = {
  eventId: string;
  postId: string;
  postVersion: number;
  assetId: string;
  provider: "r2_original" | "r2_delivery" | "stream";
  purpose: string;
  key: string | null;
  streamUid: string | null;
  size: number | null;
  version: string | null;
  etag: string | null;
  sha256: string | null;
  contentType: string;
  durationSeconds: number | null;
};
function projectAsset(
  x: unknown,
  eventId: string,
  postId: string,
  original: boolean,
): AuthorizedAsset {
  if (
    !object(x) ||
    x.event_id !== eventId ||
    x.post_id !== postId ||
    typeof x.asset_id !== "string" ||
    !uuid.test(x.asset_id) ||
    !Number.isSafeInteger(x.post_version) ||
    Number(x.post_version) < 1 ||
    typeof x.purpose !== "string"
  )
    return bad();
  let key: string | null = null,
    contentType = "application/octet-stream";
  if (original) {
    if (
      x.provider !== "r2_original" ||
      x.purpose !== "original" ||
      typeof x.object_version !== "string" ||
      !/^[!-~]{1,1024}$/.test(x.object_version) ||
      typeof x.object_etag !== "string" ||
      !/^[a-f0-9]{32}(?:-[1-9][0-9]{0,4})?$/.test(x.object_etag)
    )
      return bad();
    key = originalKey(eventId, postId, x.asset_id);
  } else if (x.provider === "r2_delivery") {
    const match = /^delivery_(600|1600)_(webp|jpg)$/.exec(x.purpose);
    if (
      !match ||
      typeof x.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(x.sha256)
    )
      return bad();
    key = deliveryKey(
      eventId,
      x.asset_id,
      match[1] as "600" | "1600",
      match[2] as "webp" | "jpg",
    );
    contentType = match[2] === "webp" ? "image/webp" : "image/jpeg";
  } else if (x.provider === "stream") {
    if (
      !["stream_source", "stream_clip"].includes(x.purpose) ||
      typeof x.stream_uid !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(x.stream_uid) ||
      x.object_key !== null ||
      typeof x.duration_seconds !== "number" ||
      !Number.isFinite(x.duration_seconds) ||
      x.duration_seconds <= 0 ||
      x.duration_seconds > 4
    )
      return bad();
  } else return bad();
  if (
    key !== null &&
    (x.object_key !== key ||
      x.stream_uid !== null ||
      !Number.isSafeInteger(x.byte_size) ||
      Number(x.byte_size) < 1 ||
      Number(x.byte_size) > 5492189429760)
  )
    return bad();
  return {
    eventId,
    postId,
    postVersion: Number(x.post_version),
    assetId: x.asset_id,
    provider: x.provider as AuthorizedAsset["provider"],
    purpose: x.purpose,
    key,
    streamUid: x.provider === "stream" ? (x.stream_uid as string) : null,
    size: key === null ? null : Number(x.byte_size),
    version: original ? (x.object_version as string) : null,
    etag: original ? (x.object_etag as string) : null,
    sha256:
      typeof x.sha256 === "string" && /^[a-f0-9]{64}$/.test(x.sha256)
        ? x.sha256
        : null,
    contentType,
    durationSeconds:
      x.provider === "stream" ? Number(x.duration_seconds) : null,
  };
}
export type AuthorizedMedia = {
  ok: true;
  eventId: string;
  userId: string;
  postId: string;
  resource: string;
  original: boolean;
  asset: AuthorizedAsset;
  revalidate: () => Promise<boolean>;
};
type Capture = {
  chunk(bytes: Uint8Array): void;
  complete(): Promise<void>;
  discard(): void;
};
/** Isolate-local bytes only: never stores authorization, cookies, user data, originals or Stream tokens. */
export class DerivedImageCache {
  private readonly entries = new Map<
    string,
    { bytes: Uint8Array; expires: number; readers: number; removed: boolean }
  >();
  private readonly buckets = new WeakMap<object, number>();
  private nextBucket = 0;
  private stored = 0;
  private pending = 0;
  private pendingCount = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private readonly limit = 4 * 1024 * 1024;
  private readonly itemLimit = 1024 * 1024;
  private readonly ttl = 30_000;
  private readonly count = 16;
  key(backend: string, bucket: object, a: AuthorizedAsset): string {
    let namespace = this.buckets.get(bucket);
    if (namespace === undefined) {
      namespace = ++this.nextBucket;
      this.buckets.set(bucket, namespace);
    }
    return JSON.stringify([
      backend,
      namespace,
      a.eventId,
      a.postId,
      a.postVersion,
      a.assetId,
      a.provider,
      a.purpose,
      a.key,
      a.sha256,
      a.version,
      a.etag,
      a.size,
      a.contentType,
    ]);
  }
  delete(key: string) {
    const old = this.entries.get(key);
    if (old) {
      old.removed = true;
      if (old.readers === 0) this.stored -= old.bytes.byteLength;
      this.entries.delete(key);
    }
  }
  private sweep() {
    for (const [key, entry] of this.entries)
      if (entry.expires <= Date.now()) this.delete(key);
  }
  private room(size: number) {
    this.sweep();
    while (
      this.entries.size &&
      (this.entries.size + this.pendingCount >= this.count ||
        this.stored + this.pending + size > this.limit)
    ) {
      this.delete(this.entries.keys().next().value!);
      this.evictions++;
    }
    return (
      this.pendingCount < this.count &&
      this.stored + this.pending + size <= this.limit
    );
  }
  /** Aggregate diagnostics only; never identity, URLs, object keys or authentication. */
  metrics() {
    this.sweep();
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      entries: this.entries.size,
      storedBytes: this.stored,
      pendingBytes: this.pending,
    };
  }
  read(
    key: string,
    range: { offset: number; length: number } | null,
  ): ReadableStream<Uint8Array> | null {
    this.sweep();
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    this.hits++;
    entry.readers++;
    this.entries.delete(key);
    this.entries.set(key, entry);
    let data: Uint8Array | null = entry.bytes;
    let held: typeof entry | null = entry;
    const release = () => {
      if (held) {
        data = null;
        held.readers--;
        if (held.removed && held.readers === 0)
          this.stored -= held.bytes.byteLength;
        held = null;
      }
    };
    let position = range?.offset ?? 0;
    const end = range ? position + range.length : data.byteLength;
    return new ReadableStream<Uint8Array>(
      {
        pull(out) {
          if (!data || position >= end) {
            release();
            out.close();
            return;
          }
          const next = Math.min(position + 65536, end);
          out.enqueue(data.slice(position, next));
          position = next;
        },
        cancel() {
          release();
        },
      },
      { highWaterMark: 0 },
    );
  }
  capture(key: string, size: number, sha256: string): Capture | null {
    if (
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > this.itemLimit ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      !this.room(size)
    )
      return null;
    this.pending += size;
    this.pendingCount++;
    let bytes: Uint8Array | null = new Uint8Array(size),
      position = 0;
    let hashing = false,
      reserved = true;
    const release = () => {
      if (!reserved) return;
      reserved = false;
      this.pending -= size;
      this.pendingCount--;
    };
    const discard = () => {
      if (bytes) {
        bytes.fill(0);
        bytes = null;
      }
      // A cancelled digest may still hold an internal copy until it settles.
      if (!hashing) release();
    };
    return {
      chunk(value) {
        if (bytes && position + value.byteLength <= size) {
          bytes.set(value, position);
          position += value.byteLength;
        } else discard();
      },
      complete: async () => {
        if (hashing) return;
        if (!bytes || position !== size) {
          discard();
          return;
        }
        hashing = true;
        try {
          const digest = Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                bytes as Uint8Array<ArrayBuffer>,
              ),
            ),
            (b) => b.toString(16).padStart(2, "0"),
          ).join("");
          if (!bytes || digest !== sha256) {
            discard();
            return;
          }
          const saved = bytes;
          bytes = null;
          release();
          this.delete(key);
          if (this.room(size)) {
            this.entries.set(key, {
              bytes: saved,
              expires: Date.now() + this.ttl,
              readers: 0,
              removed: false,
            });
            this.stored += size;
          }
        } catch {
          discard();
        } finally {
          hashing = false;
          release();
        }
      },
      discard,
    };
  }
}
const derivedImages = new DerivedImageCache();
/** verifiedChild is INTERNAL ONLY: the Stream adapter must verify its opaque child signature before calling. */
export async function authorizeMediaRequest(
  request: Request,
  env: MediaReadEnv,
  fetcher: typeof fetch = fetch,
  verifiedChild?: { postVersion: number },
): Promise<AuthorizedMedia | { ok: false; response: Response }> {
  try {
    if (request.method !== "GET")
      return {
        ok: false,
        response: new Response(null, {
          status: 405,
          headers: { ...privateHeaders, allow: "GET" },
        }),
      };
    const url = new URL(request.url),
      media = /^\/media\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname),
      originalMatch = /^\/admin\/posts\/([^/]+)\/original$/.exec(url.pathname);
    const original = originalMatch !== null;
    if (
      (!media && !originalMatch) ||
      (original
        ? env.KOKO_ADMIN_ORIGINALS_ENABLED
        : env.KOKO_MEDIA_DELIVERY_ENABLED) !== "true"
    )
      throw new MediaReadError("NOT_FOUND");
    const eventId = (
        original ? request.headers.get("X-Event-ID") : media![1]
      )?.toLowerCase(),
      postId = (original ? originalMatch![1] : media![2])!.toLowerCase();
    const resource = original ? "original" : media![3]!;
    if (
      !eventId ||
      !uuid.test(eventId) ||
      !uuid.test(postId) ||
      (request.headers.has("X-Event-ID") &&
        request.headers.get("X-Event-ID")!.toLowerCase() !== eventId)
    )
      throw new MediaReadError("INVALID_INPUT");
    if (
      request.body !== null ||
      [...url.searchParams.keys()].some(
        (k) =>
          !original ||
          k !== "expected_version" ||
          url.searchParams.getAll(k).length !== 1,
      )
    )
      throw new MediaReadError("INVALID_INPUT");
    let input: Record<string, unknown> = {};
    if (original) {
      const version = url.searchParams.get("expected_version");
      if (
        !version ||
        !/^[1-9][0-9]{0,9}$/.test(version) ||
        Number(version) > 2147483647
      )
        throw new MediaReadError("INVALID_INPUT");
      input = {
        expected_version: Number(version),
        request_id: crypto.randomUUID(),
      };
    } else if (verifiedChild) {
      if (
        !/^hls-[A-Za-z0-9_.-]{1,1000}$/.test(resource) ||
        !Number.isSafeInteger(verifiedChild.postVersion) ||
        verifiedChild.postVersion < 1
      )
        throw new MediaReadError("INVALID_INPUT");
      input = { expected_version: verifiedChild.postVersion };
    } else if (
      !/^(?:(?:review-)?(?:webp|jpg)-(?:600|1600)|hls|(?:review-)?thumbnail|mp4)$/.test(
        resource,
      )
    )
      throw new MediaReadError("NOT_FOUND");
    const headers = new Headers(request.headers);
    headers.set("X-Event-ID", eventId);
    const scoped = new Request(request, { headers });
    const params: ReadMediaInput = {
      action: original ? "original" : "asset",
      postId,
      resource: original ? null : verifiedChild ? "hls-child" : resource,
      input,
    };
    const result = await readMediaRpc(scoped, env, params, fetcher),
      asset = projectAsset(result.value.asset, eventId, postId, original);
    if (!original && asset.provider !== "stream") {
      const mediaName = /^(?:review-)?(webp|jpg)-(600|1600)$/.exec(resource);
      if (
        !mediaName ||
        asset.purpose !== `delivery_${mediaName[2]}_${mediaName[1]}`
      )
        bad();
    }
    if (
      !original &&
      asset.provider === "stream" &&
      !(
        verifiedChild ||
        ["hls", "thumbnail", "review-thumbnail", "mp4"].includes(resource)
      )
    )
      bad();
    if (verifiedChild && asset.postVersion !== verifiedChild.postVersion) bad();
    return {
      ok: true,
      eventId,
      userId: result.userId,
      postId,
      resource,
      original,
      asset,
      async revalidate() {
        try {
          const fresh = await readMediaRpc(scoped, env, params, fetcher);
          return (
            fresh.userId === result.userId &&
            JSON.stringify(
              projectAsset(fresh.value.asset, eventId, postId, original),
            ) === JSON.stringify(asset)
          );
        } catch {
          return false;
        }
      },
    };
  } catch (error) {
    return { ok: false, response: mediaFailure(error) };
  }
}
function rangeOf(
  header: string | null,
  size: number,
): { offset: number; length: number } | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || header.length > 60)
    throw new Error("RANGE");
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new Error("RANGE");
    return {
      offset: Math.max(0, size - suffix),
      length: Math.min(size, suffix),
    };
  }
  const start = Number(match[1]),
    end = match[2] === "" ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= size ||
    end < start
  )
    throw new Error("RANGE");
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}
async function boundedObjectGet(
  bucket: Pick<R2Bucket, "get">,
  key: string,
  options: R2GetOptions,
) {
  let expired = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const pending = bucket.get(key, options).then((value) => {
    if (expired && value && "body" in value)
      void value.body.cancel().catch(() => {});
    return value;
  });
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new MediaReadError("INTERNAL_ERROR"));
        }, 10_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
/** No whole-object buffer/size cutoff: idle and policy deadlines also protect long originals. */
function guardedObjectBody(
  source: ReadableStream<Uint8Array>,
  length: number,
  signal: AbortSignal,
  revalidate: () => Promise<boolean>,
  capture?: Capture | null,
  discardCached?: () => void,
) {
  const reader = source.getReader();
  let stopped = false,
    bytes = 0,
    destination: ReadableStreamDefaultController<Uint8Array>;
  let idleTimer: ReturnType<typeof setTimeout> | undefined,
    policyTimer: ReturnType<typeof setTimeout> | undefined,
    checkTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (policyTimer !== undefined) clearTimeout(policyTimer);
    if (checkTimer !== undefined) clearTimeout(checkTimer);
    signal.removeEventListener("abort", abort);
  };
  const abort = () => {
    if (stopped) return;
    stopped = true;
    capture?.discard();
    discardCached?.();
    cleanup();
    void reader.cancel().catch(() => {});
    destination.error(new Error("MEDIA_DELIVERY_FAILED"));
  };
  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(abort, 30_000);
  };
  async function watch() {
    if (stopped) return;
    const valid = await Promise.race([
      revalidate().catch(() => false),
      new Promise<boolean>((resolve) => {
        checkTimer = setTimeout(() => resolve(false), 4000);
      }),
    ]);
    if (checkTimer !== undefined) clearTimeout(checkTimer);
    if (stopped) return;
    if (!valid) abort();
    else policyTimer = setTimeout(() => void watch(), 5000);
  }
  return new ReadableStream<Uint8Array>(
    {
      start(out) {
        destination = out;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else {
          armIdle();
          // Fail closed in at most 5s + 4s when authorization expires or cannot be checked.
          policyTimer = setTimeout(() => void watch(), 5000);
        }
      },
      async pull(out) {
        try {
          if (stopped) return;
          armIdle();
          const next = await reader.read();
          if (stopped) return;
          if (next.done) {
            if (bytes !== length) return abort();
            await capture?.complete();
            if (stopped) return;
            stopped = true;
            cleanup();
            out.close();
          } else {
            bytes += next.value.byteLength;
            if (bytes > length) return abort();
            capture?.chunk(next.value);
            out.enqueue(next.value);
          }
        } catch {
          abort();
        }
      },
      cancel() {
        if (stopped) return;
        stopped = true;
        capture?.discard();
        discardCached?.();
        cleanup();
        void reader.cancel().catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
}
/** Streams approved R2 bytes without reflecting object metadata or ever publishing a raw URL. */
export async function handleMediaDelivery(
  request: Request,
  env: MediaReadEnv,
  fetcher: typeof fetch = fetch,
  cache: DerivedImageCache = derivedImages,
): Promise<Response> {
  let child: Awaited<ReturnType<typeof decodeStreamChild>>;
  try {
    child = await decodeStreamChild(request, env);
  } catch {
    return failure("NOT_FOUND");
  }
  const gate = await authorizeMediaRequest(
    request,
    env,
    fetcher,
    child ? { postVersion: child.v } : undefined,
  );
  if (!gate.ok) return gate.response;
  const { asset } = gate;
  if (asset.provider === "stream")
    return serveStream(request, env, gate, child, fetcher);
  const bucket =
    asset.provider === "r2_original"
      ? env.ORIGINALS_BUCKET
      : env.DERIVED_BUCKET;
  if (!bucket) return failure("INTERNAL_ERROR");
  let range: ReturnType<typeof rangeOf>, body: ReadableStream | undefined;
  let capture: Capture | null = null;
  try {
    range = rangeOf(
      request.headers.has("if-range") ? null : request.headers.get("range"),
      asset.size!,
    );
  } catch {
    return new Response(null, {
      status: 416,
      headers: { ...privateHeaders, "content-range": `bytes */${asset.size}` },
    });
  }
  try {
    if (!(await gate.revalidate())) return failure("NOT_FOUND");
    const cacheKey =
      !gate.original && asset.provider === "r2_delivery"
        ? cache.key(env.SUPABASE_URL!, bucket, asset)
        : null;
    body = cacheKey ? (cache.read(cacheKey, range) ?? undefined) : undefined;
    if (!body) {
      const value = await boundedObjectGet(bucket, asset.key!, {
        ...(range ? { range } : {}),
        ...(asset.etag ? { onlyIf: { etagMatches: asset.etag } } : {}),
      });
      if (!value || !("body" in value)) throw new MediaReadError("NOT_FOUND");
      body = value.body;
      if (
        value.key !== asset.key ||
        value.size !== asset.size ||
        (asset.version && value.version !== asset.version) ||
        (asset.etag && value.etag !== asset.etag) ||
        (asset.provider === "r2_delivery" &&
          value.customMetadata?.sha256 !== asset.sha256) ||
        (range &&
          (!value.range ||
            !("offset" in value.range) ||
            value.range.offset !== range.offset ||
            !("length" in value.range) ||
            value.range.length !== range.length))
      )
        bad();
      if (
        !range &&
        value.range &&
        (!("offset" in value.range) ||
          value.range.offset !== 0 ||
          !("length" in value.range) ||
          value.range.length !== asset.size)
      )
        bad();
      if (cacheKey && !range)
        capture = cache.capture(cacheKey, asset.size!, asset.sha256!);
    }
    if (request.signal.aborted || !(await gate.revalidate())) {
      capture?.discard();
      if (cacheKey) cache.delete(cacheKey);
      throw new MediaReadError("NOT_FOUND");
    }
    const headers = new Headers({
      "cache-control": "private, no-store",
      "content-type": asset.contentType,
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      "accept-ranges": "bytes",
      "content-length": String(range?.length ?? asset.size),
    });
    if (gate.original) {
      headers.set(
        "content-disposition",
        `attachment; filename="${asset.postId}-original.bin"`,
      );
      headers.set("content-security-policy", "sandbox; default-src 'none'");
    }
    if (range)
      headers.set(
        "content-range",
        `bytes ${range.offset}-${range.offset + range.length - 1}/${asset.size}`,
      );
    const response = new Response(
      guardedObjectBody(
        body,
        range?.length ?? asset.size!,
        request.signal,
        gate.revalidate,
        capture,
        cacheKey ? () => cache.delete(cacheKey) : undefined,
      ),
      { status: range ? 206 : 200, headers },
    );
    body = undefined;
    return response;
  } catch (error) {
    capture?.discard();
    if (body) void body.cancel().catch(() => {});
    return mediaFailure(error);
  }
}
