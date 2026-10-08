import { afterEach, expect, it, vi } from "vitest";
import { originalKey } from "@koko/contract";
import {
  classifyStreamNotification,
  createStreamProcessingAdapter,
  createStreamWebhookVerifier,
  planStreamPoll,
  streamFrameTimes,
  type StreamProcessingOptions,
  type StreamReference,
  type StreamScope,
} from "../src/stream-processing";

const now = Date.parse("2026-10-06T12:00:00Z");
const s: StreamScope = {
  eventId: "11111111-1111-4111-8111-111111111111",
  postId: "22222222-2222-4222-8222-222222222222",
  assetId: "33333333-3333-4333-8333-333333333333",
  jobId: "44444444-4444-4444-8444-444444444444",
  leaseId: "55555555-5555-4555-8555-555555555555",
  postVersion: 2,
  expiresAt: now + 120000,
};
const operationId = "66666666-6666-4666-8666-666666666666";
const clipOperationId = "77777777-7777-4777-8777-777777777777";
const sourceUid = "a".repeat(32),
  clipUid = "b".repeat(32),
  accountId = "c".repeat(32);
const ref: StreamReference = { uid: sourceUid, operationId, sourceUid: null };
const clipRef: StreamReference = {
  uid: clipUid,
  operationId: clipOperationId,
  sourceUid,
};
const original = { size: 12345, etag: "d".repeat(32) };
const key = originalKey(s.eventId, s.postId, s.assetId);
const origins = ["fixture.example"];
const metadata = (r = ref) => ({
  name: `koko-${r.operationId}`,
  koko_event: s.eventId,
  koko_post: s.postId,
  koko_asset: s.assetId,
  koko_job: s.jobId,
  koko_version: String(s.postVersion),
  koko_operation: r.operationId,
  koko_source: r.sourceUid ?? "original",
});
const video = (r = ref, changes = {}) => ({
  uid: r.uid,
  requireSignedURLs: true,
  allowedOrigins: origins,
  meta: metadata(r),
  status: { state: "ready", pctComplete: "100.000000" },
  readyToStream: true,
  duration: 3.8,
  input: { width: 1280, height: 720 },
  modified: "2026-10-06T11:59:00Z",
  ...(r.sourceUid ? { clippedFrom: r.sourceUid } : {}),
  ...changes,
});
const envelope = (result: unknown) =>
  Response.json({ success: true, errors: [], result });
const base64url = (text: string) =>
  btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const jwt = (changes = {}) =>
  `${base64url('{"alg":"RS256"}')}.${base64url(JSON.stringify({ sub: sourceUid, exp: now / 1000 + 60, nbf: now / 1000 - 5, ...changes }))}.syntheticSignature`;
// Minimal synthetic header fixture. Full decode is intentionally the Cloud Run boundary.
const jpeg = new Uint8Array([
  255, 216, 255, 192, 0, 11, 8, 0, 8, 0, 16, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1,
  0, 0, 63, 0, 1, 2, 255, 217,
]);
function configuration(overrides: StreamProcessingOptions = {}) {
  const head = vi
    .fn<NonNullable<StreamProcessingOptions["originals"]>["head"]>()
    .mockResolvedValue({
      key,
      size: original.size,
      etag: original.etag,
    } as R2Object);
  const isCurrent = vi
    .fn<NonNullable<StreamProcessingOptions["isCurrent"]>>()
    .mockResolvedValue(true);
  const apiToken = vi
    .fn<NonNullable<StreamProcessingOptions["apiToken"]>>()
    .mockResolvedValue("synthetic-api-token");
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname.endsWith("cloudflarestream.com"))
      return new Response(jpeg, { headers: { "content-type": "image/jpeg" } });
    if (url.pathname.endsWith("/token")) return envelope({ token: jwt() });
    if (url.searchParams.has("video_name")) return envelope([video()]);
    if (url.pathname.endsWith("/clip"))
      return envelope(
        video(clipRef, {
          duration: 0,
          readyToStream: false,
          status: { state: "queued" },
        }),
      );
    if (url.pathname.endsWith("/copy")) {
      const body = JSON.parse(String(init?.body));
      return envelope(
        video(ref, {
          meta: body.meta,
          duration: 0,
          readyToStream: false,
          status: { state: "queued" },
        }),
      );
    }
    return envelope(video());
  });
  const config: StreamProcessingOptions = {
    enabled: true,
    accountId,
    originalsBucketName: "koko-dev-originals",
    originalReadAccessKeyId: "e".repeat(32),
    originalReadSecretAccessKey: "f".repeat(64),
    originals: { head },
    customerHost: "customer-fixture.cloudflarestream.com",
    allowedOrigins: origins,
    isCurrent,
    apiToken,
    fetcher,
    clock: () => now,
    timeoutMs: 500,
    ...overrides,
  };
  return {
    adapter: createStreamProcessingAdapter(config)!,
    config,
    fetcher,
    head,
    apiToken,
    isCurrent,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("defaults off with no credential/environment reads", () => {
  expect(createStreamProcessingAdapter()).toBeNull();
  expect(createStreamWebhookVerifier()).toBeNull();
  expect(
    createStreamProcessingAdapter({
      enabled: false,
      get apiToken(): never {
        throw Error("secret");
      },
    }),
  ).toBeNull();
});
it.each([
  { accountId: "bad" },
  { originalsBucketName: "../other" },
  { originalsBucketName: "https://attacker.invalid" },
  { originalReadAccessKeyId: "bad" },
  { customerHost: "customer-fixture.cloudflarestream.com.attacker.invalid" },
  { customerHost: "https://customer-fixture.cloudflarestream.com" },
  { allowedOrigins: [] },
  { allowedOrigins: ["*.example.com"] },
  { allowedOrigins: ["fixture.example", "fixture.example"] },
  { timeoutMs: 15001 },
  { originals: undefined },
  { isCurrent: undefined },
] as StreamProcessingOptions[])(
  "rejects unsafe/incomplete config %o",
  (bad) => {
    expect(() => configuration(bad)).toThrow("INVALID_CONFIG");
  },
);

it("copy signs only fixed original GET, preserves original, and returns no URLs or tokens", async () => {
  const f = configuration();
  const result = await f.adapter.copy(s, operationId, original);
  expect(result.state).toBe("pending");
  expect(result.reference).toEqual(ref);
  expect(f.head).toHaveBeenCalledExactlyOnceWith(key);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  const [input, init] = f.fetcher.mock.calls[0]!;
  expect(String(input)).toBe(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/copy`,
  );
  expect(init?.redirect).toBe("manual");
  expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get("authorization")).toBe(
    "Bearer synthetic-api-token",
  );
  const body = JSON.parse(String(init?.body));
  expect(body.requireSignedURLs).toBe(true);
  expect(body.allowedOrigins).toEqual(origins);
  expect(body.meta).toEqual(metadata());
  const get = new URL(body.input);
  expect(get.origin).toBe(`https://${accountId}.r2.cloudflarestorage.com`);
  expect(get.pathname).toBe(`/koko-dev-originals/${key}`);
  expect(get.searchParams.get("X-Amz-Expires")).toBe("300");
  expect(get.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  expect(get.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  expect(f.isCurrent).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(result)).not.toMatch(
    /https:|synthetic-api-token|X-Amz|Bearer/,
  );
});
it("deployment-selected bucket is exact, never taken from caller payload", async () => {
  const f = configuration({ originalsBucketName: "koko-production-originals" });
  await f.adapter.copy(s, operationId, original);
  const body = JSON.parse(String(f.fetcher.mock.calls[0]![1]?.body));
  expect(new URL(body.input).pathname).toBe(
    `/koko-production-originals/${key}`,
  );
  await expect(
    f.adapter.copy(
      { ...s, bucket: "other" } as StreamScope,
      operationId,
      original,
    ),
  ).rejects.toThrow("INVALID_INPUT");
});
it.each([
  null,
  { key, size: 1, etag: original.etag },
  { key, size: original.size, etag: "0".repeat(32) },
  { key: "other", ...original },
])("HEAD mismatch %o cannot reach provider creation", async (found) => {
  const f = configuration();
  f.head.mockResolvedValue(found as R2Object | null);
  await expect(f.adapter.copy(s, operationId, original)).rejects.toThrow(
    "ORIGINAL_MISMATCH",
  );
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("DB denial/expired lease prevents all external actions", async () => {
  const f = configuration();
  f.isCurrent.mockResolvedValue(false);
  await expect(f.adapter.copy(s, operationId, original)).rejects.toThrow(
    "STALE",
  );
  expect(f.head).not.toHaveBeenCalled();
  expect(f.apiToken).not.toHaveBeenCalled();
  f.isCurrent.mockResolvedValue(true);
  await expect(
    f.adapter.inspect({ ...s, expiresAt: now }, ref),
  ).rejects.toThrow("STALE");
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("lost creation response is ambiguous and is never retried", async () => {
  const f = configuration();
  f.fetcher.mockRejectedValue(new Error("private provider details"));
  await expect(f.adapter.copy(s, operationId, original)).rejects.toThrow(
    "AMBIGUOUS_CREATE",
  );
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it("DB change after successful creation remains ambiguous, not a safe retry", async () => {
  const f = configuration();
  f.isCurrent
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockResolvedValue(false);
  await expect(f.adapter.copy(s, operationId, original)).rejects.toThrow(
    "AMBIGUOUS_CREATE",
  );
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it.each([401, 403, 429])(
  "explicit provider rejection %i is sanitized without retry",
  async (status) => {
    const f = configuration();
    f.fetcher.mockResolvedValue(
      new Response("private token detail", { status }),
    );
    await expect(f.adapter.copy(s, operationId, original)).rejects.toThrow(
      status === 429 ? "QUOTA" : "PROVIDER_REJECTED",
    );
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  },
);
it("clip uses new identity, preserves source, always starts at zero and requires private playback", async () => {
  const f = configuration();
  f.fetcher
    .mockResolvedValueOnce(envelope(video(ref, { duration: 42.5 })))
    .mockResolvedValueOnce(
      envelope(
        video(clipRef, {
          duration: 0,
          status: { state: "queued" },
          readyToStream: false,
        }),
      ),
    );
  const result = await f.adapter.clip(s, clipOperationId, ref, 3.8);
  expect(result.reference).toEqual(clipRef);
  expect(result.state).toBe("pending");
  const request = JSON.parse(String(f.fetcher.mock.calls[1]![1]?.body));
  expect(request).toEqual({
    clippedFromVideoUID: sourceUid,
    startTimeSeconds: 0,
    endTimeSeconds: 3.8,
    requireSignedURLs: true,
    allowedOrigins: origins,
    meta: metadata(clipRef),
  });
  expect(f.fetcher.mock.calls.every((c) => c[1]?.method !== "DELETE")).toBe(
    true,
  );
});
it.each([0, 4, 4.1, 10, NaN])(
  "clip rejects unapproved trim target %s",
  async (target) => {
    const f = configuration();
    await expect(
      f.adapter.clip(s, clipOperationId, ref, target),
    ).rejects.toThrow("INVALID_INPUT");
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it("clip rejects chained source and same operation", async () => {
  const f = configuration();
  await expect(f.adapter.clip(s, operationId, ref)).rejects.toThrow(
    "INVALID_INPUT",
  );
  await expect(f.adapter.clip(s, operationId, clipRef)).rejects.toThrow(
    "INVALID_INPUT",
  );
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([0.25, 3, 3.8, 4])(
  "short fallback duration %s still creates a new clip without exceeding its source",
  async (duration) => {
    const f = configuration();
    f.fetcher.mockResolvedValueOnce(envelope(video(ref, { duration })));
    const result = await f.adapter.clip(s, clipOperationId, ref);
    expect(result.reference).toEqual(clipRef);
    expect(JSON.parse(String(f.fetcher.mock.calls[1]![1]?.body))).toMatchObject(
      {
        startTimeSeconds: 0,
        endTimeSeconds: Math.min(3.8, duration),
        requireSignedURLs: true,
      },
    );
  },
);
it("recovered provider generation verifies old metadata but every authorization check uses current scope", async () => {
  const oldJob = "88888888-8888-4888-8888-888888888888";
  const f = configuration({
    providerGenerations: [{ operationId, jobId: oldJob, postVersion: 1 }],
  });
  const old = video(ref, {
    meta: { ...metadata(), koko_job: oldJob, koko_version: "1" },
  });
  f.fetcher.mockResolvedValueOnce(envelope(old));
  expect((await f.adapter.inspect(s, ref)).reference).toEqual(ref);
  f.fetcher.mockResolvedValueOnce(envelope([old]));
  expect((await f.adapter.reconcile(s, operationId, null)).state).toBe("found");
  for (const [scope] of f.isCurrent.mock.calls) expect(scope).toEqual(s);
  const before = f.fetcher.mock.calls.length;
  await expect(f.adapter.copy(s, operationId, original)).rejects.toThrow(
    "DUPLICATE_OPERATION",
  );
  expect(f.fetcher.mock.calls.length).toBe(before);
});
it("new clip can inspect recovered source generation while writing current-generation metadata", async () => {
  const oldJob = "88888888-8888-4888-8888-888888888888";
  const f = configuration({
    providerGenerations: [{ operationId, jobId: oldJob, postVersion: 1 }],
  });
  f.fetcher.mockResolvedValueOnce(
    envelope(
      video(ref, {
        duration: 3,
        meta: { ...metadata(), koko_job: oldJob, koko_version: "1" },
      }),
    ),
  );
  expect((await f.adapter.clip(s, clipOperationId, ref)).reference).toEqual(
    clipRef,
  );
  const body = JSON.parse(String(f.fetcher.mock.calls[1]![1]?.body));
  expect(body.meta.koko_job).toBe(s.jobId);
  expect(body.meta.koko_version).toBe(String(s.postVersion));
  expect(body.endTimeSeconds).toBe(3);
});
it.each(["job", "version", "post", "asset"])(
  "recovered provider identity still rejects different %s",
  async (field) => {
    const oldJob = "88888888-8888-4888-8888-888888888888";
    const f = configuration({
      providerGenerations: [{ operationId, jobId: oldJob, postVersion: 1 }],
    });
    const meta = {
      ...metadata(),
      koko_job: oldJob,
      koko_version: "1",
      [`koko_${field}`]:
        field === "version" ? "9" : "99999999-9999-4999-8999-999999999999",
    };
    f.fetcher.mockResolvedValueOnce(envelope(video(ref, { meta })));
    await expect(f.adapter.inspect(s, ref)).rejects.toThrow("INVALID_RESPONSE");
  },
);
it("future or same-version different-job provider generation is never accepted", async () => {
  for (const postVersion of [s.postVersion, s.postVersion + 1]) {
    const f = configuration({
      providerGenerations: [
        {
          operationId,
          jobId: "88888888-8888-4888-8888-888888888888",
          postVersion,
        },
      ],
    });
    await expect(f.adapter.inspect(s, ref)).rejects.toThrow("INVALID_INPUT");
  }
});
it.each([
  { requireSignedURLs: false },
  { meta: { ...metadata(), koko_version: "1" } },
  { allowedOrigins: [] },
  { allowedOrigins: ["attacker.invalid"] },
  { uid: clipUid },
  { clippedFrom: clipUid },
  { status: { state: "future-state", pctComplete: "100" } },
  { duration: null },
  { input: { width: -1, height: 1 } },
  { modified: "invalid" },
])("inspect rejects insecure/mismatched provider state %o", async (changes) => {
  const f = configuration();
  f.fetcher.mockResolvedValue(envelope(video(ref, changes)));
  await expect(f.adapter.inspect(s, ref)).rejects.toThrow("INVALID_RESPONSE");
});
it("partial encoding is pending even when readyToStream is true", async () => {
  const f = configuration();
  f.fetcher.mockResolvedValue(
    envelope(video(ref, { status: { state: "ready", pctComplete: "99" } })),
  );
  const result = await f.adapter.inspect(s, ref);
  expect(result.state).toBe("pending");
  expect(result.processingComplete).toBe(false);
  expect(planStreamPoll(result, 1, 12)).toEqual({
    state: "wait",
    retryAfterSeconds: 5,
  });
  expect(planStreamPoll(result, 12, 12)).toEqual({ state: "held" });
});
it("poll is bounded without sleeping, permits complete short video and routes oversized output to clip", async () => {
  const f = configuration();
  const result = await f.adapter.inspect(s, ref);
  expect(planStreamPoll(result, 1, 12)).toEqual({ state: "ready" });
  expect(
    planStreamPoll({ ...result, measuredDurationSeconds: 4.001 }, 1, 12),
  ).toEqual({ state: "clip_required" });
  expect(planStreamPoll({ ...result, state: "error" }, 1, 12)).toEqual({
    state: "held",
  });
  expect(() => planStreamPoll(result, 13, 12)).toThrow("INVALID_INPUT");
});
it("reconciliation uses exact operation name and never re-creates on no match", async () => {
  const f = configuration();
  expect((await f.adapter.reconcile(s, operationId, null)).state).toBe("found");
  const url = new URL(String(f.fetcher.mock.calls[0]![0]));
  expect(url.searchParams.get("video_name")).toBe(`koko-${operationId}`);
  expect(url.searchParams.get("limit")).toBe("2");
  f.fetcher.mockResolvedValue(envelope([]));
  expect(await f.adapter.reconcile(s, operationId, null)).toEqual({
    state: "not_found",
  });
  expect(f.fetcher.mock.calls.every((c) => c[1]?.method === "GET")).toBe(true);
  f.fetcher.mockResolvedValue(envelope([video(), video()]));
  await expect(f.adapter.reconcile(s, operationId, null)).rejects.toThrow(
    "DUPLICATE_OPERATION",
  );
});

it("frames are three distinct valid times and use signed tokens only on fixed customer host", async () => {
  const f = configuration();
  const result = await f.adapter.frames(s, ref);
  expect(result.frames.map((frame) => frame.seconds)).toEqual(
    streamFrameTimes(3.8),
  );
  expect(result.frames.map((frame) => frame.index)).toEqual([0, 1, 2]);
  expect(
    result.frames.every(
      (frame) =>
        frame.bytes.length === jpeg.length &&
        frame.sha256.length === 64 &&
        frame.width === 16 &&
        frame.height === 8,
    ),
  ).toBe(true);
  const frameCalls = f.fetcher.mock.calls.filter((c) =>
    new URL(String(c[0])).host.endsWith("cloudflarestream.com"),
  );
  expect(frameCalls).toHaveLength(3);
  for (const [input, init] of frameCalls) {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    expect(url.hostname).toBe("customer-fixture.cloudflarestream.com");
    expect(url.pathname).toBe(`/${jwt()}/thumbnails/thumbnail.jpg`);
    expect(url.searchParams.get("fit")).toBe("clip");
    expect(url.searchParams.get("width")).toBe("1024");
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.get("origin")).toBe("https://fixture.example");
    expect(init?.redirect).toBe("manual");
  }
  expect(JSON.stringify(result)).not.toMatch(
    /synthetic-api-token|syntheticSignature|X-Amz|https:/,
  );
});
it.each([0, -1, 4.01, NaN, 0.0000001])(
  "invalid frame duration %s rejected",
  (duration) => {
    expect(() => streamFrameTimes(duration)).toThrow();
  },
);
it("frames reject oversized duration before requesting a token", async () => {
  const f = configuration();
  f.fetcher.mockResolvedValue(envelope(video(ref, { duration: 4.001 })));
  await expect(f.adapter.frames(s, ref)).rejects.toThrow("VIDEO_TOO_LONG");
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  { sub: clipUid },
  { exp: now / 1000 + 61 },
  { exp: now / 1000 },
  { nbf: now / 1000 + 1 },
  { nbf: null },
  { nbf: -1 },
  { nbf: now / 1000 - 0.5 },
  { downloadable: true },
  { downloadable: "false" },
  { flags: { original: true } },
])("frames reject mis-scoped token %o", async (claims) => {
  const f = configuration();
  f.fetcher
    .mockResolvedValueOnce(envelope(video()))
    .mockResolvedValueOnce(envelope({ token: jwt(claims) }));
  await expect(f.adapter.frames(s, ref)).rejects.toThrow("INVALID_RESPONSE");
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it("partial frame failure returns no accepted batch, no redirect or API credential forwarding", async () => {
  const f = configuration();
  f.fetcher
    .mockResolvedValueOnce(envelope(video()))
    .mockResolvedValueOnce(envelope({ token: jwt() }))
    .mockResolvedValueOnce(
      new Response(jpeg, { headers: { "content-type": "image/jpeg" } }),
    )
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.invalid" },
      }),
    );
  await expect(f.adapter.frames(s, ref)).rejects.toThrow("INVALID_RESPONSE");
  expect(f.fetcher).toHaveBeenCalledTimes(4);
});
it("oversized frame response is rejected before body allocation", async () => {
  const f = configuration();
  f.fetcher
    .mockResolvedValueOnce(envelope(video()))
    .mockResolvedValueOnce(envelope({ token: jwt() }))
    .mockResolvedValueOnce(
      new Response(jpeg, {
        headers: { "content-type": "image/jpeg", "content-length": "4194305" },
      }),
    );
  await expect(f.adapter.frames(s, ref)).rejects.toThrow("RESOURCE_LIMIT");
});
it("provider changes after frames cannot become accepted evidence", async () => {
  const f = configuration();
  const base = f.fetcher.getMockImplementation()!;
  let reads = 0;
  f.fetcher.mockImplementation((input, init) => {
    if (String(input).endsWith(`/${sourceUid}`) && ++reads === 2)
      return Promise.resolve(
        envelope(video(ref, { modified: "2026-10-06T12:00:00Z" })),
      );
    return base(input, init);
  });
  await expect(f.adapter.frames(s, ref)).rejects.toThrow("STALE");
});

it.each([
  () =>
    new Response(null, {
      status: 307,
      headers: { location: "https://attacker.invalid" },
    }),
  () => new Response("private", { headers: { "content-type": "text/plain" } }),
  () =>
    new Response("{}", {
      headers: {
        "content-type": "application/json",
        "content-length": "65537",
      },
    }),
  () =>
    new Response("x".repeat(65537), {
      headers: { "content-type": "application/json" },
    }),
  () =>
    new Response(Uint8Array.of(255), {
      headers: { "content-type": "application/json" },
    }),
  () =>
    Response.json({
      success: true,
      errors: [{ message: "private" }],
      result: video(),
    }),
])(
  "provider transport/schema failures are bounded and sanitized",
  async (response) => {
    const f = configuration();
    f.fetcher.mockResolvedValue(response());
    await expect(f.adapter.inspect(s, ref)).rejects.toThrow(
      /PROVIDER_FAILED|RESOURCE_LIMIT|INVALID_RESPONSE/,
    );
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  },
);
it("deadline stops hung provider without retry and releases local concurrency", async () => {
  const f = configuration({ timeoutMs: 10 });
  f.fetcher.mockImplementation(() => new Promise(() => {}));
  const pending = f.adapter.inspect(s, ref);
  await expect(f.adapter.inspect(s, ref)).rejects.toThrow("BUSY");
  await expect(pending).rejects.toThrow("TIMEOUT");
  f.fetcher.mockResolvedValue(envelope(video()));
  expect((await f.adapter.inspect(s, ref)).state).toBe("ready");
});
it("abort after creation submission is ambiguous; before it sends nothing", async () => {
  const f = configuration();
  const controller = new AbortController();
  f.fetcher.mockImplementation(async () => {
    controller.abort();
    return envelope(video());
  });
  await expect(
    f.adapter.copy(s, operationId, original, controller.signal),
  ).rejects.toThrow("AMBIGUOUS_CREATE");
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  await expect(f.adapter.inspect(s, ref, AbortSignal.abort())).rejects.toThrow(
    "ABORTED",
  );
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it("late DB guard after timeout cannot request credentials or provider", async () => {
  let resolve!: (allowed: boolean) => void;
  const f = configuration({
    timeoutMs: 5,
    isCurrent: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  await expect(f.adapter.inspect(s, ref)).rejects.toThrow("TIMEOUT");
  resolve(true);
  await Promise.resolve();
  await Promise.resolve();
  expect(f.apiToken).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("lease expiry during credential callback cannot submit provider creation", async () => {
  let currentTime = now;
  const f = configuration({
    clock: () => currentTime,
    apiToken: async () => {
      currentTime = s.expiresAt;
      return "synthetic-api-token";
    },
  });
  await expect(f.adapter.copy(s, operationId, original)).rejects.toThrow(
    "STALE",
  );
  expect(f.fetcher).not.toHaveBeenCalled();
});

const webhookSecret = "synthetic-webhook-secret";
async function request(
  body = JSON.stringify(video()),
  timestamp = Math.floor(now / 1000),
  secret = webhookSecret,
) {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      k,
      new TextEncoder().encode(`${timestamp}.${body}`),
    ),
  );
  const hex = Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
  return new Request("https://fixture.example/internal/stream-webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-signature": `time=${timestamp},sig1=${hex}`,
    },
    body,
  });
}
const verifier = () =>
  createStreamWebhookVerifier({
    enabled: true,
    secret: webhookSecret,
    allowedOrigins: origins,
    clock: () => now,
  })!;
it.each([
  { allowedOrigins: [] },
  { allowedOrigins: ["*.example.com"] },
  { allowedOrigins: ["fixture.example", "fixture.example"] },
  { allowedOrigins: [".."] },
  { allowedOrigins: ["-unsafe.example"] },
  { allowedOrigins: ["https://fixture.example"] },
])(
  "webhook origins share exact deployment config validation %o",
  ({ allowedOrigins }) => {
    expect(() =>
      createStreamWebhookVerifier({
        enabled: true,
        secret: webhookSecret,
        allowedOrigins,
      }),
    ).toThrow("INVALID_CONFIG");
  },
);
it("webhook signature covers exact bytes, returns only bounded normalized metadata", async () => {
  const notification = await verifier()(
    await request(` ${JSON.stringify(video())}\n`),
  );
  expect(notification.eventId).toBe(s.eventId);
  expect(notification.video.processingComplete).toBe(true);
  expect(notification.bodySha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(notification)).not.toMatch(
    /https:|synthetic-webhook-secret|playback|preview/,
  );
});
it.each([-301, 31])("webhook timestamp offset %i rejected", async (delta) => {
  await expect(
    verifier()(await request(undefined, now / 1000 + delta)),
  ).rejects.toThrow("BAD_SIGNATURE");
});
it("webhook rejects wrong secret, duplicate signature fields, body modification", async () => {
  await expect(
    verifier()(await request(undefined, undefined, "wrong-synthetic-secret")),
  ).rejects.toThrow("BAD_SIGNATURE");
  const duplicate = await request();
  duplicate.headers.append(
    "webhook-signature",
    duplicate.headers.get("webhook-signature")!,
  );
  await expect(verifier()(duplicate)).rejects.toThrow("BAD_SIGNATURE");
  const originalRequest = await request();
  const modified = new Request(originalRequest.url, {
    method: "POST",
    headers: originalRequest.headers,
    body: `${JSON.stringify(video())}\n`,
  });
  await expect(verifier()(modified)).rejects.toThrow("BAD_SIGNATURE");
});
it("signed wrong generation, stale order and duplicate notification are not applied", async () => {
  const notification = await verifier()(await request());
  const current = {
    eventId: s.eventId,
    postId: s.postId,
    assetId: s.assetId,
    jobId: s.jobId,
    postVersion: s.postVersion,
    reference: ref,
    accepting: true,
    lastBodySha256: null,
    modifiedAt: null,
  };
  expect(classifyStreamNotification(current, notification)).toBe("apply");
  expect(
    classifyStreamNotification({ ...current, accepting: false }, notification),
  ).toBe("stale");
  expect(
    classifyStreamNotification({ ...current, postVersion: 3 }, notification),
  ).toBe("stale");
  expect(
    classifyStreamNotification(
      { ...current, reference: clipRef },
      notification,
    ),
  ).toBe("stale");
  expect(
    classifyStreamNotification(
      { ...current, lastBodySha256: notification.bodySha256 },
      notification,
    ),
  ).toBe("duplicate");
  expect(
    classifyStreamNotification(
      { ...current, modifiedAt: "2026-10-06T12:00:00Z" },
      notification,
    ),
  ).toBe("stale");
  expect(
    classifyStreamNotification(
      { ...current, modifiedAt: notification.video.modifiedAt },
      notification,
    ),
  ).toBe("conflict");
});
it("webhook never follows payload URLs; unsafe signed state rejected", async () => {
  const fake = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fake);
  try {
    const notification = await verifier()(
      await request(
        JSON.stringify(
          video(ref, { playback: { hls: "http://169.254.169.254/private" } }),
        ),
      ),
    );
    expect(notification.video.state).toBe("ready");
    expect(fake).not.toHaveBeenCalled();
    await expect(
      verifier()(
        await request(JSON.stringify(video(ref, { requireSignedURLs: false }))),
      ),
    ).rejects.toThrow("INVALID_RESPONSE");
  } finally {
    vi.unstubAllGlobals();
  }
});
