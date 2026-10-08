import { expect, it, vi } from "vitest";
import { errors } from "@koko/contract";
import {
  authorizeMediaRequest,
  DerivedImageCache,
  handleMediaDelivery,
  type MediaReadEnv,
  type AuthorizedAsset,
} from "../src/media-delivery";
async function sha(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
async function cacheFixture(original = false) {
  const f = fixture(original),
    bytes = new TextEncoder().encode("0123456789"),
    cache = new DerivedImageCache();
  f.chosen.sha256 = await sha(bytes);
  f.get.mockImplementation(async (key, options) => {
    const range = options?.range as
      { offset: number; length: number } | undefined;
    return {
      key,
      size: 10,
      version: "version",
      etag: "b".repeat(32),
      customMetadata: { sha256: f.chosen.sha256 },
      range,
      body: new ReadableStream({
        start(out) {
          out.enqueue(
            range
              ? bytes.slice(range.offset, range.offset + range.length)
              : bytes,
          );
          out.close();
        },
      }),
    } as unknown as R2ObjectBody;
  });
  return {
    ...f,
    cache,
    run: (req = request("webp-600", original)) =>
      handleMediaDelivery(req, f.env, f.fetcher, cache),
  };
}

it("derived cache saves complete hash-verified bytes, yet every hit runs fresh Auth and policy with no-store", async () => {
  const f = await cacheFixture();
  expect(await (await f.run()).text()).toBe("0123456789");
  expect(f.cache.metrics()).toMatchObject({
    entries: 1,
    storedBytes: 10,
    pendingBytes: 0,
  });
  const hit = await f.run();
  expect(await hit.text()).toBe("0123456789");
  expect(hit.headers.get("cache-control")).toBe("private, no-store");
  expect(f.get).toHaveBeenCalledTimes(1);
  expect(f.calls).toHaveLength(6);
  expect(f.fetcher).toHaveBeenCalledTimes(12);
  expect(f.cache.metrics().hits).toBe(1);
  const range = request();
  range.headers.set("range", "bytes=2-4");
  expect(await (await f.run(range)).text()).toBe("234");
  expect(f.get).toHaveBeenCalledTimes(1);
});
it.each([
  "ACCOUNT_BANNED",
  "NOT_FOUND",
  "PUBLICATION_STOPPED",
  "CONSENT_REQUIRED",
])("cache never bypasses fresh %s denial", async (codeName) => {
  const f = await cacheFixture();
  await (await f.run()).arrayBuffer();
  f.setResult({ code: codeName });
  await code(await f.run(), codeName as keyof typeof errors);
  expect(f.get).toHaveBeenCalledTimes(1);
  expect(f.cache.metrics().hits).toBe(0);
});
it("post generation change and bucket replacement miss the old cache", async () => {
  const f = await cacheFixture();
  await (await f.run()).arrayBuffer();
  f.chosen.post_version++;
  await (await f.run()).arrayBuffer();
  expect(f.get).toHaveBeenCalledTimes(2);
  f.env.DERIVED_BUCKET = { get: f.get };
  await (await f.run()).arrayBuffer();
  expect(f.get).toHaveBeenCalledTimes(3);
});
it("cache namespace excludes user tokens and separates backend/event/post/version/variant/hash", () => {
  const cache = new DerivedImageCache(),
    bucket = {};
  const a: AuthorizedAsset = {
    eventId,
    postId,
    postVersion: 1,
    assetId,
    provider: "r2_delivery",
    purpose: "delivery_600_webp",
    key: asset.object_key,
    sha256: asset.sha256,
    size: 10,
    contentType: "image/webp",
    version: null,
    etag: null,
    streamUid: null,
    durationSeconds: null,
  };
  const key = cache.key("backend", bucket, a);
  for (const patch of [
    { eventId: userId },
    { postId: userId },
    { postVersion: 2 },
    { assetId: userId },
    { purpose: "delivery_1600_webp" },
    { sha256: "c".repeat(64) },
    { size: 11 },
    { key: "another" },
  ])
    expect(cache.key("backend", bucket, { ...a, ...patch })).not.toBe(key);
  expect(cache.key("other-backend", bucket, a)).not.toBe(key);
  expect(cache.key("backend", {}, a)).not.toBe(key);
  expect(key).not.toContain("Bearer");
});
it("originals and partial responses never enter derived cache", async () => {
  const f = await cacheFixture(true);
  await (await f.run()).arrayBuffer();
  await (await f.run()).arrayBuffer();
  expect(f.get).toHaveBeenCalledTimes(2);
  expect(f.cache.metrics().entries).toBe(0);
  const partial = await cacheFixture();
  const req = request();
  req.headers.set("range", "bytes=0-2");
  await (await partial.run(req)).arrayBuffer();
  expect(partial.cache.metrics().entries).toBe(0);
});
it("mismatched actual hash, truncated bodies and cancellation are never cached", async () => {
  const bad = await cacheFixture();
  bad.chosen.sha256 = "a".repeat(64);
  await (await bad.run()).arrayBuffer();
  expect(bad.cache.metrics()).toMatchObject({ entries: 0, pendingBytes: 0 });
  const partial = await cacheFixture();
  controlledBody(partial, new Uint8Array(9), true);
  await expect((await partial.run()).arrayBuffer()).rejects.toThrow(
    "MEDIA_DELIVERY_FAILED",
  );
  expect(partial.cache.metrics().pendingBytes).toBe(0);
  const cancel = await cacheFixture();
  const response = await cancel.run();
  expect(cancel.cache.metrics().pendingBytes).toBe(10);
  await response.body!.cancel();
  expect(cancel.cache.metrics()).toMatchObject({ entries: 0, pendingBytes: 0 });
});
it.each(["cancel", "revoke"])(
  "in-flight cache hit drops its reference on %s",
  async (reason) => {
    const f = await cacheFixture();
    await (await f.run()).arrayBuffer();
    if (reason === "revoke") vi.useFakeTimers();
    try {
      const hit = await f.run();
      expect(f.cache.metrics().hits).toBe(1);
      if (reason === "cancel") await hit.body!.cancel();
      else {
        f.setResult({ code: "NOT_FOUND" });
        await vi.advanceTimersByTimeAsync(5000);
        await expect(hit.arrayBuffer()).rejects.toThrow(
          "MEDIA_DELIVERY_FAILED",
        );
      }
    } finally {
      vi.useRealTimers();
    }
    expect(f.cache.metrics()).toMatchObject({
      entries: 0,
      storedBytes: 0,
      pendingBytes: 0,
    });
  },
);
it("cache TTL is fixed, LRU/count and aggregate pending-plus-stored bytes are bounded", async () => {
  const cache = new DerivedImageCache(),
    one = new Uint8Array([1]),
    hash = await sha(one);
  for (let n = 0; n < 16; n++) {
    const c = cache.capture(String(n), 1, hash)!;
    c.chunk(one);
    await c.complete();
  }
  const active = cache.read("0", null)!;
  await new Response(active).arrayBuffer();
  const next = cache.capture("16", 1, hash)!;
  next.chunk(one);
  await next.complete();
  expect(cache.metrics().entries).toBe(16);
  expect(cache.read("1", null)).toBeNull();
  const pinned = cache.read("0", null)!;
  cache.delete("0");
  expect(cache.metrics().storedBytes).toBe(16);
  await pinned.cancel();
  expect(cache.metrics().storedBytes).toBe(15);
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.now() + 30001);
    expect(cache.read("16", null)).toBeNull();
    expect(cache.metrics().storedBytes).toBe(0);
  } finally {
    vi.useRealTimers();
  }
  const big = new Uint8Array(1024 * 1024),
    bigHash = await sha(big);
  const captures = Array.from({ length: 4 }, (_, i) =>
    cache.capture(`pending-${i}`, big.length, bigHash)!,
  );
  expect(cache.capture("excess", 1, hash)).toBeNull();
  expect(cache.capture("too-large", big.length + 1, bigHash)).toBeNull();
  expect(cache.metrics().pendingBytes).toBe(4 * 1024 * 1024);
  captures.forEach((c) => c.discard());
  expect(cache.metrics().pendingBytes).toBe(0);
});
it("cancelled hash work keeps its reservation until settlement and cannot populate the cache", async () => {
  const cache = new DerivedImageCache(),
    bytes = new Uint8Array([1]);
  const hash = await sha(bytes);
  let resolve!: (value: ArrayBuffer) => void;
  const digest = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(
    () =>
      new Promise<ArrayBuffer>((r) => {
        resolve = r;
      }),
  );
  try {
    const capture = cache.capture("cancel-digest", 1, hash)!;
    capture.chunk(bytes);
    const pending = capture.complete();
    capture.discard();
    expect(cache.metrics().pendingBytes).toBe(1);
    resolve(
      new Uint8Array(hash.match(/../g)!.map((v) => parseInt(v, 16))).buffer,
    );
    await pending;
    expect(cache.metrics()).toMatchObject({ entries: 0, pendingBytes: 0 });
  } finally {
    digest.mockRestore();
  }
});
const eventId = "11111111-1111-4111-8111-111111111111",
  userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  postId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  assetId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const asset = {
  event_id: eventId,
  post_id: postId,
  post_version: 1,
  asset_id: assetId,
  provider: "r2_delivery",
  purpose: "delivery_600_webp",
  object_key: `events/${eventId}/delivery/${assetId}/600.webp`,
  stream_uid: null,
  byte_size: 10,
  object_version: null,
  object_etag: null,
  sha256: "a".repeat(64),
  duration_seconds: null,
};
function request(resource = "webp-600", original = false) {
  return new Request(
    original
      ? `https://api.example.test/admin/posts/${postId}/original?expected_version=1`
      : `https://api.example.test/media/${eventId}/${postId}/${resource}`,
    {
      headers: {
        authorization: "Bearer synthetic-token",
        ...(original ? { "X-Event-ID": eventId } : {}),
      },
    },
  );
}
function fixture(original = false) {
  const chosen = original
    ? {
        ...asset,
        provider: "r2_original",
        purpose: "original",
        object_key: `events/${eventId}/posts/${postId}/original/${assetId}.bin`,
        object_version: "version",
        object_etag: "b".repeat(32),
      }
    : { ...asset };
  let result: unknown = { code: "ok", asset: chosen };
  const calls: Record<string, unknown>[] = [];
  const env: MediaReadEnv = {
    KOKO_MEDIA_DELIVERY_ENABLED: "true",
    KOKO_ADMIN_ORIGINALS_ENABLED: "true",
    SUPABASE_URL: "https://fixture.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    SUPABASE_SECRET_KEY: "sb_secret_fixture",
  };
  const fetcher = vi.fn<typeof fetch>(async (target, init) => {
    const url = new URL(String(target));
    expect(url.origin).toBe("https://fixture.supabase.co");
    expect(init?.redirect).toBe("manual");
    expect(init?.cache).toBe("no-store");
    if (url.pathname === "/auth/v1/user")
      return Response.json({
        id: userId,
        app_metadata: { provider: "google", providers: ["google"] },
      });
    expect(url.pathname).toBe("/rest/v1/rpc/read_media");
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    calls.push(JSON.parse(String(init?.body)));
    return result instanceof Response ? result : Response.json(result);
  });
  const get = vi.fn<R2Bucket["get"]>(async (key, options) => {
    const range = options?.range as
      { offset: number; length: number } | undefined;
    const bytes = new TextEncoder().encode(
      "0123456789".slice(
        range?.offset ?? 0,
        range ? range.offset + range.length : 10,
      ),
    );
    return {
      key,
      version: "version",
      etag: "b".repeat(32),
      size: 10,
      customMetadata: { sha256: asset.sha256 },
      range,
      httpMetadata: {
        contentType: "text/html",
        contentDisposition: "inline",
        cacheControl: "public, max-age=31536000",
      },
      body: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    } as unknown as R2ObjectBody;
  });
  env.ORIGINALS_BUCKET = { get };
  env.DERIVED_BUCKET = { get };
  return {
    env,
    get,
    fetcher,
    calls,
    chosen,
    setResult: (v: unknown) => {
      result = v;
    },
  };
}
async function code(r: Response, name: keyof typeof errors) {
  expect(r.status).toBe(errors[name].status);
  expect(await r.json()).toMatchObject({ code: name });
}
it("private R2 image is streamed only after fresh Auth/policy and then rechecked before emitting", async () => {
  const f = fixture(),
    r = await handleMediaDelivery(request(), f.env, f.fetcher);
  expect(r.status).toBe(200);
  expect(new TextDecoder().decode(await r.arrayBuffer())).toBe("0123456789");
  expect(r.headers.get("content-type")).toBe("image/webp");
  expect(r.headers.get("cache-control")).toBe("private, no-store");
  expect(r.headers.get("set-cookie")).toBeNull();
  expect(f.calls).toHaveLength(3);
  expect(f.get).toHaveBeenCalledWith(asset.object_key, {});
  expect(f.calls[0]).toMatchObject({
    p_event_id: eventId,
    p_user_id: userId,
    p_action: "asset",
    p_post_id: postId,
    p_resource: "webp-600",
    p_input: {},
  });
});
it("operator original is attachment/octet-stream, optimistic version/audit id, never original URL", async () => {
  const f = fixture(true),
    r = await handleMediaDelivery(request("", true), f.env, f.fetcher);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("application/octet-stream");
  expect(r.headers.get("content-disposition")).toBe(
    `attachment; filename="${postId}-original.bin"`,
  );
  expect(r.headers.get("content-security-policy")).toContain("sandbox");
  expect(f.get).toHaveBeenCalledWith(f.chosen.object_key, {
    onlyIf: { etagMatches: "b".repeat(32) },
  });
  expect(f.calls[0]?.p_input).toMatchObject({ expected_version: 1 });
  expect(f.calls[1]?.p_input).toEqual(f.calls[0]?.p_input);
  await r.body?.cancel();
});
it.each([
  ["bytes=2-5", "2345", "bytes 2-5/10"],
  ["bytes=7-", "789", "bytes 7-9/10"],
  ["bytes=-3", "789", "bytes 7-9/10"],
  ["bytes=0-99", "0123456789", "bytes 0-9/10"],
])("valid single Range %s", async (header, expected, contentRange) => {
  const f = fixture(),
    req = request();
  req.headers.set("range", header!);
  const r = await handleMediaDelivery(req, f.env, f.fetcher);
  expect(r.status).toBe(206);
  expect(new TextDecoder().decode(await r.arrayBuffer())).toBe(expected);
  expect(r.headers.get("content-range")).toBe(contentRange);
});
it.each([
  "bytes=10-",
  "bytes=3-2",
  "bytes=-0",
  "bytes=0-1,3-4",
  "bytes=",
  "bytes=9007199254740993-",
  "items=0-1",
])(
  "rejects malformed or unsatisfied Range %s only after auth",
  async (header) => {
    const f = fixture(),
      req = request();
    req.headers.set("range", header);
    const r = await handleMediaDelivery(req, f.env, f.fetcher);
    expect(r.status).toBe(416);
    expect(r.headers.get("content-range")).toBe("bytes */10");
    expect(f.get).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(1);
  },
);
it("If-Range without a server validator ignores Range and sends an authenticated full response", async () => {
  const f = fixture(),
    req = request();
  req.headers.set("range", "bytes=2-3");
  req.headers.set("if-range", "untrusted");
  const r = await handleMediaDelivery(req, f.env, f.fetcher);
  expect(r.status).toBe(200);
  expect(new TextDecoder().decode(await r.arrayBuffer())).toBe("0123456789");
});
it.each([
  "webp-600?token=secret",
  "../original",
  "original",
  "https:evil",
  "hls-child",
  "hls-unsigned",
])("arbitrary resource %s cannot reach storage", async (name) => {
  const f = fixture();
  const r = await handleMediaDelivery(request(name), f.env, f.fetcher);
  expect([400, 404]).toContain(r.status);
  expect(f.get).not.toHaveBeenCalled();
});
it("event header/path mismatch and missing original version cannot reach storage", async () => {
  const f = fixture(),
    req = request();
  req.headers.set("X-Event-ID", postId);
  await code(await handleMediaDelivery(req, f.env, f.fetcher), "INVALID_INPUT");
  const orig = request("", true);
  await code(
    await handleMediaDelivery(
      new Request(orig.url.split("?")[0]!, orig),
      f.env,
      f.fetcher,
    ),
    "INVALID_INPUT",
  );
  expect(f.get).not.toHaveBeenCalled();
});
it.each([undefined, "false", "TRUE"])(
  "default-off flag %s never reads bucket or credentials",
  async (flag) => {
    const f = fixture();
    if (flag === undefined) delete f.env.KOKO_MEDIA_DELIVERY_ENABLED;
    else f.env.KOKO_MEDIA_DELIVERY_ENABLED = flag;
    await code(
      await handleMediaDelivery(request(), f.env, f.fetcher),
      "NOT_FOUND",
    );
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
  },
);
it.each([
  "FORBIDDEN",
  "NOT_FOUND",
  "CONSENT_REQUIRED",
  "ACCOUNT_BANNED",
  "PUBLICATION_STOPPED",
  "STATE_CONFLICT",
] as const)("SQL %s blocks R2", async (name) => {
  const f = fixture();
  f.setResult({ code: name, private: "hidden" });
  await code(await handleMediaDelivery(request(), f.env, f.fetcher), name);
  expect(f.get).not.toHaveBeenCalled();
});
it("Cookie images use path event, retain origin checks and require no CSRF for GET", async () => {
  const f = fixture();
  f.env.KOKO_WEB_ORIGIN = "https://web.example.test";
  f.env.KOKO_CSRF_SECRET = "cc".repeat(32);
  const req = request();
  req.headers.delete("authorization");
  req.headers.set("cookie", "__Host-koko_session=synthetic-token");
  req.headers.set("Origin", f.env.KOKO_WEB_ORIGIN);
  const allowed = await handleMediaDelivery(req, f.env, f.fetcher);
  expect(allowed.status).toBe(200);
  await allowed.body?.cancel();
  req.headers.set("Origin", "https://evil.example.test");
  await code(await handleMediaDelivery(req, f.env, f.fetcher), "FORBIDDEN");
});
it("a hide/revoke during storage fetch cancels bytes before response", async () => {
  const f = fixture(),
    cancel = vi.fn();
  f.get.mockImplementation(async () => {
    f.setResult({ code: "NOT_FOUND" });
    return {
      key: asset.object_key,
      size: 10,
      version: "version",
      etag: "b".repeat(32),
      customMetadata: { sha256: asset.sha256 },
      body: new ReadableStream({ cancel }),
    } as unknown as R2ObjectBody;
  });
  await code(
    await handleMediaDelivery(request(), f.env, f.fetcher),
    "NOT_FOUND",
  );
  expect(cancel).toHaveBeenCalledOnce();
});
it.each([
  { object_key: "events/foreign" },
  { stream_uid: "private" },
  { byte_size: 0 },
  { purpose: "delivery_1600_jpg" },
  { event_id: postId },
  { post_id: assetId },
])("malformed/cross-scope asset %j cannot reach bucket", async (change) => {
  const f = fixture();
  f.setResult({ code: "ok", asset: { ...asset, ...change } });
  await code(
    await handleMediaDelivery(request(), f.env, f.fetcher),
    "INTERNAL_ERROR",
  );
  expect(f.get).not.toHaveBeenCalled();
});
it("mismatching R2 identity cancels body instead of reflecting metadata", async () => {
  const f = fixture(true),
    cancel = vi.fn();
  f.get.mockResolvedValue({
    key: f.chosen.object_key,
    size: 10,
    version: "changed",
    etag: f.chosen.object_etag,
    body: new ReadableStream({ cancel }),
  } as unknown as R2ObjectBody);
  await code(
    await handleMediaDelivery(request("", true), f.env, f.fetcher),
    "INTERNAL_ERROR",
  );
  expect(cancel).toHaveBeenCalledOnce();
});
it("signed child classification is internal and version-bound, raw child is never authorized", async () => {
  const f = fixture();
  f.setResult({
    code: "ok",
    asset: {
      ...asset,
      provider: "stream",
      purpose: "stream_source",
      object_key: null,
      stream_uid: "a".repeat(32),
      byte_size: null,
      duration_seconds: 3.8,
    },
  });
  const raw = await authorizeMediaRequest(
    request("hls-opaque.signature"),
    f.env,
    f.fetcher,
  );
  expect(raw.ok).toBe(false);
  const trusted = await authorizeMediaRequest(
    request("hls-opaque.signature"),
    f.env,
    f.fetcher,
    { postVersion: 1 },
  );
  expect(trusted.ok).toBe(true);
  expect(f.calls[0]).toMatchObject({
    p_resource: "hls-child",
    p_input: { expected_version: 1 },
  });
  expect(
    (await handleMediaDelivery(request("hls"), f.env, f.fetcher)).status,
  ).toBe(404);
  expect(f.get).not.toHaveBeenCalled();
});
it("stalled R2 metadata is bounded and late arriving body cancelled", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(),
      cancel = vi.fn();
    let resolve!: (v: R2ObjectBody) => void;
    f.get.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = handleMediaDelivery(request(), f.env, f.fetcher);
    await vi.advanceTimersByTimeAsync(10000);
    await code(await pending, "INTERNAL_ERROR");
    resolve({ body: new ReadableStream({ cancel }) } as R2ObjectBody);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
function controlledBody(
  f: ReturnType<typeof fixture>,
  bytes: Uint8Array | null,
  close = false,
) {
  const cancel = vi.fn();
  f.get.mockResolvedValue({
    key: f.chosen.object_key,
    size: 10,
    version: "version",
    etag: "b".repeat(32),
    customMetadata: { sha256: f.chosen.sha256 },
    body: new ReadableStream({
      start(out) {
        if (bytes) out.enqueue(bytes);
        if (close) out.close();
      },
      cancel,
    }),
  } as unknown as R2ObjectBody);
  return cancel;
}
it.each([
  "ACCOUNT_BANNED",
  "NOT_FOUND",
  "FORBIDDEN",
  "PUBLICATION_STOPPED",
  "CONSENT_REQUIRED",
])("stops an in-flight R2 body after policy becomes %s", async (reason) => {
  vi.useFakeTimers();
  try {
    const f = fixture(),
      cancel = controlledBody(f, new Uint8Array([1, 2, 3]));
    const r = await handleMediaDelivery(request(), f.env, f.fetcher);
    const reader = r.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
    const rejected = expect(reader.read()).rejects.toThrow(
      "MEDIA_DELIVERY_FAILED",
    );
    f.setResult({ code: reason });
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
it("stops a stalled body within nine seconds if reauthorization hangs", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(),
      cancel = controlledBody(f, null);
    const r = await handleMediaDelivery(request(), f.env, f.fetcher);
    const rejected = expect(r.arrayBuffer()).rejects.toThrow(
      "MEDIA_DELIVERY_FAILED",
    );
    f.fetcher.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(9000);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
it("does not keep an idle original stream alive even when policy remains valid", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(true),
      cancel = controlledBody(f, null);
    const r = await handleMediaDelivery(request("", true), f.env, f.fetcher);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(r.arrayBuffer()).rejects.toThrow("MEDIA_DELIVERY_FAILED");
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
it.each([new Uint8Array(9), new Uint8Array(11)])(
  "rejects R2 actual body length mismatch %#",
  async (bytes) => {
    const f = fixture();
    controlledBody(f, bytes, true);
    const r = await handleMediaDelivery(request(), f.env, f.fetcher);
    await expect(r.arrayBuffer()).rejects.toThrow("MEDIA_DELIVERY_FAILED");
  },
);
it.each(["request", "downstream"])(
  "cancels R2 body on %s cancellation",
  async (kind) => {
    const f = fixture(),
      cancel = controlledBody(f, null),
      abort = new AbortController();
    const r = await handleMediaDelivery(
      new Request(request(), { signal: abort.signal }),
      f.env,
      f.fetcher,
    );
    if (kind === "request") {
      const rejected = expect(r.arrayBuffer()).rejects.toThrow(
        "MEDIA_DELIVERY_FAILED",
      );
      abort.abort();
      await rejected;
    } else await r.body!.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  },
);
