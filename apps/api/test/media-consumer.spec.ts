import { afterEach, expect, it, vi } from "vitest";
import {
  handleMediaProcessingQueue,
  type MediaConsumerDependencies,
  type MediaConsumerEnv,
} from "../src/media-consumer";
import { relayPath, verifyRelay } from "@koko/processing/relay";

const envelope = {
  version: 1,
  kind: "process_media",
  job_id: "11111111-1111-4111-8111-111111111111",
  event_id: "22222222-2222-4222-8222-222222222222",
  post_id: "33333333-3333-4333-8333-333333333333",
  asset_id: "44444444-4444-4444-8444-444444444444",
  post_version: 2,
};
const job = {
  eventId: envelope.event_id,
  postId: envelope.post_id,
  jobId: envelope.job_id,
};
function fixture(
  results: unknown[] = [{ code: "READY", kind: "photo" }, { code: "TERMINAL" }],
) {
  const env: MediaConsumerEnv = {
    KOKO_MEDIA_CONSUMER_ENABLED: "true",
    KOKO_MEDIA_PROCESSING_QUEUE: "koko-media-dev",
    KOKO_EVENT_ID: envelope.event_id,
    SUPABASE_URL: "https://fixture.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    SUPABASE_SECRET_KEY: "sb_secret_fixture",
  };
  const queued = {
    id: "queue-fixture",
    timestamp: new Date(),
    body: { ...envelope },
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
  const batch = {
    queue: env.KOKO_MEDIA_PROCESSING_QUEUE!,
    messages: [queued],
    metadata: { metrics: { backlogCount: 1, backlogBytes: 100 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
  const process = vi.fn(async () => true);
  const prepareVideo = vi.fn(async () => "prepared" as const);
  const dependencies: MediaConsumerDependencies = {
    cloudRun: { process },
    prepareVideo,
  };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toBe(
      "https://fixture.supabase.co/rest/v1/rpc/media_processing_status",
    );
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(init?.cache).toBe("no-store");
    expect(new Headers(init?.headers).get("apikey")).toBe("sb_secret_fixture");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      p_event_id: envelope.event_id,
      p_post_id: envelope.post_id,
      p_job_id: envelope.job_id,
      p_asset_id: envelope.asset_id,
      p_post_version: 2,
    });
    const value = results.shift();
    if (value instanceof Error) throw value;
    return value instanceof Response
      ? value
      : Response.json(value ?? { code: "DEFERRED" });
  });
  return { env, queued, batch, process, prepareVideo, dependencies, fetcher };
}
const run = (f: ReturnType<typeof fixture>) =>
  handleMediaProcessingQueue(f.batch, f.env, f.dependencies, f.fetcher);

it.each(["TERMINAL", "DEFERRED", "READY"])(
  "production relay wiring independently reloads DB %s before ACK",
  async (after) => {
    const f = fixture([
      { code: "READY", kind: "photo" },
      { code: after, ...(after === "READY" ? { kind: "photo" } : {}) },
    ]);
    f.env.KOKO_PROCESSING_RELAY_ENABLED = "true";
    f.env.KOKO_PROCESSING_RELAY_ORIGIN =
      "https://koko-relay-fixture.vercel.app";
    f.env.KOKO_PROCESSING_RELAY_SECRET = "ab".repeat(32);
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith(relayPath)) {
        const req = new Request(String(url), init);
        const text = String(init?.body);
        expect(
          await verifyRelay(
            req,
            f.env.KOKO_PROCESSING_RELAY_ORIGIN!,
            f.env.KOKO_PROCESSING_RELAY_SECRET!,
            text,
          ),
        ).toBe(true);
        expect(JSON.parse(text)).toEqual(job);
        expect(req.headers.has("authorization")).toBe(false);
        expect(req.headers.has("apikey")).toBe(false);
        return Response.json({ stage: "moderation", processComplete: true });
      }
      return f.fetcher(url, init);
    });
    const result = await handleMediaProcessingQueue(
      f.batch,
      f.env,
      { prepareVideo: f.prepareVideo },
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(f.queued.ack).toHaveBeenCalledTimes(after === "TERMINAL" ? 1 : 0);
    expect(f.queued.retry).toHaveBeenCalledTimes(after === "TERMINAL" ? 0 : 1);
    expect(result.processed).toBe(1);
  },
);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it.each([undefined, "false", "TRUE", ""])(
  "flag %s throws before implicit batch ACK",
  async (flag) => {
    const f = fixture();
    if (flag === undefined) delete f.env.KOKO_MEDIA_CONSUMER_ENABLED;
    else f.env.KOKO_MEDIA_CONSUMER_ENABLED = flag;
    await expect(run(f)).rejects.toThrow("MEDIA_CONSUMER_NOT_READY");
    expect(f.queued.ack).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it.each([
  "KOKO_EVENT_ID",
  "KOKO_MEDIA_PROCESSING_QUEUE",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
] as const)("missing %s fails the batch closed", async (key) => {
  const f = fixture();
  delete f.env[key];
  await expect(run(f)).rejects.toThrow("MEDIA_CONSUMER_NOT_READY");
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("wrong queue or overlarge batch never implicitly resolves", async () => {
  const f = fixture();
  f.batch.queue = "other";
  await expect(run(f)).rejects.toThrow("MEDIA_CONSUMER_NOT_READY");
  f.batch.queue = f.env.KOKO_MEDIA_PROCESSING_QUEUE!;
  f.batch.messages = Array.from({ length: 11 }, () => f.queued);
  await expect(run(f)).rejects.toThrow("MEDIA_CONSUMER_NOT_READY");
});
it.each([
  { version: 2 },
  { event_id: "55555555-5555-4555-8555-555555555555" },
  { post_version: 0 },
  { post_version: 3.5 },
  { object_key: "private" },
  { subjectToken: "private" },
  { url: "https://evil.test" },
])(
  "drops malformed/foreign poison envelope %j without providers",
  async (change) => {
    const f = fixture();
    f.queued.body = { ...envelope, ...change };
    expect(await run(f)).toMatchObject({ ignored: 1, retry: 0, processed: 0 });
    expect(f.queued.ack).toHaveBeenCalledOnce();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.process).not.toHaveBeenCalled();
  },
);
it.each(["TERMINAL", "HELD", "SUPERSEDED"])(
  "durable %s evidence ACKs without identity source/provider work",
  async (code) => {
    const f = fixture([{ code }]);
    delete f.dependencies.cloudRun;
    expect(await run(f)).toEqual({
      processed: 0,
      settled: 1,
      ignored: 0,
      retry: 0,
      failed: 0,
    });
    expect(f.queued.ack).toHaveBeenCalledOnce();
    expect(f.prepareVideo).not.toHaveBeenCalled();
  },
);
it.each(["NOT_FOUND", "INVALID_INPUT"])(
  "ignores authoritative missing/poison %s",
  async (code) => {
    const f = fixture([{ code }]);
    expect(await run(f)).toMatchObject({ ignored: 1, settled: 0 });
    expect(f.queued.ack).toHaveBeenCalledOnce();
    expect(f.process).not.toHaveBeenCalled();
  },
);
it("ACK follows successful processing and a separate persisted DB proof", async () => {
  const f = fixture();
  f.process.mockImplementation(async () => {
    expect(f.queued.ack).not.toHaveBeenCalled();
    expect(f.fetcher).toHaveBeenCalledOnce();
    return true;
  });
  expect(await run(f)).toEqual({
    processed: 1,
    settled: 1,
    ignored: 0,
    retry: 0,
    failed: 0,
  });
  expect(f.process).toHaveBeenCalledWith(job);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(f.queued.ack).toHaveBeenCalledOnce();
});
it("HTTP success with only image/processing DB state retries rather than ACK", async () => {
  const f = fixture([
    { code: "READY", kind: "photo" },
    { code: "READY", kind: "photo" },
  ]);
  expect(await run(f)).toMatchObject({ processed: 1, settled: 0, retry: 1 });
  expect(f.queued.ack).not.toHaveBeenCalled();
  expect(f.queued.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
});
it("lost HTTP response after atomic commit still ACKs via DB evidence", async () => {
  const f = fixture();
  f.process.mockRejectedValue(new Error("provider secret must not escape"));
  expect(await run(f)).toEqual({
    processed: 0,
    settled: 1,
    ignored: 0,
    retry: 0,
    failed: 1,
  });
  expect(f.queued.ack).toHaveBeenCalledOnce();
});
it("missing workload identity source remains pending and never fabricates auth", async () => {
  const f = fixture([
    { code: "READY", kind: "photo" },
    { code: "READY", kind: "photo" },
  ]);
  delete f.dependencies.cloudRun;
  expect(await run(f)).toMatchObject({ settled: 0, retry: 1, failed: 1 });
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(f.queued.ack).not.toHaveBeenCalled();
});
it.each([
  { code: "DEFERRED" },
  { code: "READY" },
  { code: "READY", kind: "photo", bytes: "private" },
  { code: "TERMINAL", token: "private" },
  { code: "UNKNOWN" },
  null,
  new Error("secret"),
  new Response(null, {
    status: 302,
    headers: { location: "https://evil.test" },
  }),
])("unknown or withheld DB result cannot start work: %j", async (result) => {
  const f = fixture([result]);
  expect(await run(f)).toMatchObject({ settled: 0, retry: 1, processed: 0 });
  expect(f.process).not.toHaveBeenCalled();
  expect(f.queued.ack).not.toHaveBeenCalled();
});
it("video uses preparation, current DB proof and then Cloud Run; preserves original queue generation", async () => {
  const f = fixture([
    { code: "READY", kind: "video" },
    { code: "READY", kind: "video" },
    { code: "TERMINAL" },
  ]);
  f.process.mockImplementation(async () => {
    expect(f.prepareVideo).toHaveBeenCalledWith(job);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    return true;
  });
  expect(await run(f)).toMatchObject({ settled: 1, retry: 0 });
  expect(f.fetcher).toHaveBeenCalledTimes(3);
  expect(f.queued.body.post_version).toBe(2);
});
it("held Stream preparation uses DB proof without moderation calls", async () => {
  const f = fixture([{ code: "READY", kind: "video" }, { code: "HELD" }]);
  f.dependencies.prepareVideo = vi.fn(async () => "held" as const);
  expect(await run(f)).toMatchObject({ settled: 1, processed: 0 });
  expect(f.process).not.toHaveBeenCalled();
});
it.each(["retry", "stale", "held"] as const)(
  "Stream %s without persisted terminal proof retries",
  async (outcome) => {
    const f = fixture([
      { code: "READY", kind: "video" },
      { code: "READY", kind: "video" },
    ]);
    f.dependencies.prepareVideo = vi.fn(async () => outcome);
    expect(await run(f)).toMatchObject({ settled: 0, retry: 1 });
    expect(f.process).not.toHaveBeenCalled();
  },
);
it("missing Stream preparation cannot fall back to photo processing", async () => {
  const f = fixture([{ code: "READY", kind: "video" }]);
  delete f.dependencies.prepareVideo;
  expect(await run(f)).toMatchObject({ settled: 0, retry: 1 });
  expect(f.process).not.toHaveBeenCalled();
});
it("stalled DB request is bounded and requeued", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.fetcher.mockImplementation(() => new Promise(() => {}));
  const result = run(f);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await result).toMatchObject({ failed: 1, retry: 1 });
  expect(f.queued.ack).not.toHaveBeenCalled();
});
