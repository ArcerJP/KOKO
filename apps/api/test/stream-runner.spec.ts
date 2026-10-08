import { afterEach, expect, it, vi } from "vitest";
import { createInternalRpc, type InternalRpc } from "../src/internal-rpc";
import {
  runStreamPreparation,
  type StreamRunnerEnv,
} from "../src/stream-runner";
import {
  createStreamProcessingAdapter,
  StreamProcessingError,
  type StreamObservation,
} from "../src/stream-processing";
const job = {
  eventId: "11111111-1111-4111-8111-111111111111",
  postId: "22222222-2222-4222-8222-222222222222",
  jobId: "33333333-3333-4333-8333-333333333333",
};
const assetId = "44444444-4444-4444-8444-444444444444",
  leaseId = "55555555-5555-4555-8555-555555555555",
  operationId = "66666666-6666-4666-8666-666666666666",
  clipOperationId = "77777777-7777-4777-8777-777777777777";
const sourceUid = "a".repeat(32),
  clipUid = "b".repeat(32),
  etag = "c".repeat(32);
const sourceOp = {
  operationId,
  uid: null,
  sourceUid: null,
  providerJobId: job.jobId,
  providerPostVersion: 3,
};
const clipOp = {
  operationId: clipOperationId,
  uid: null,
  sourceUid,
  providerJobId: job.jobId,
  providerPostVersion: 3,
};
function observation(clip = false): StreamObservation {
  return {
    reference: {
      operationId: clip ? clipOperationId : operationId,
      uid: clip ? clipUid : sourceUid,
      sourceUid: clip ? sourceUid : null,
    },
    state: "ready",
    requireSignedURLs: true,
    readyToStream: true,
    processingComplete: true,
    measuredDurationSeconds: 3.8,
    width: 1280,
    height: 720,
    modifiedAt: new Date(Date.now() - 1000).toISOString(),
  };
}
type Adapter = NonNullable<ReturnType<typeof createStreamProcessingAdapter>>;
function fixture() {
  const env: StreamRunnerEnv = {
    KOKO_STREAM_PROCESSING_ENABLED: "true",
    SUPABASE_URL: "https://fixture.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    SUPABASE_SECRET_KEY: "sb_secret_fixture",
    R2_ACCOUNT_ID: "d".repeat(32),
    KOKO_STREAM_API_TOKEN: "synthetic-stream-token",
    KOKO_STREAM_CUSTOMER_HOST: "customer-fixture.cloudflarestream.com",
    KOKO_STREAM_PLAYBACK_ORIGIN: "https://app.example.test",
    KOKO_STREAM_R2_READ_ACCESS_KEY_ID: "e".repeat(32),
    KOKO_STREAM_R2_READ_SECRET_ACCESS_KEY: "f".repeat(64),
  };
  const scope = {
      ...job,
      assetId,
      leaseId,
      postVersion: 3,
      expiresAt: Date.now() + 120000,
    },
    plan = {
      scope,
      original: { size: 100, etag, objectVersion: "v1" },
      originalScope: "client_trimmed",
    };
  const claimed: Record<string, unknown> = {
    code: "CLAIMED",
    plan,
    state: {},
    pollCount: 0,
    deadline: Date.now() + 1800000,
  };
  const actions: { name: string; input: Record<string, unknown> }[] = [];
  const overrides: Record<string, Record<string, unknown>> = {};
  const rpc = vi.fn<InternalRpc>(async (name, input) => {
    expect(name).toBe("manage_stream_processing");
    const x = input as Record<string, unknown>;
    expect(x.p_event_id).toBe(job.eventId);
    expect(x.p_post_id).toBe(job.postId);
    expect(x.p_job_id).toBe(job.jobId);
    actions.push({
      name: String(x.p_action),
      input: x.p_input as Record<string, unknown>,
    });
    if (overrides[String(x.p_action)]) return overrides[String(x.p_action)]!;
    switch (x.p_action) {
      case "claim":
        return claimed;
      case "reserve":
        return {
          code: "RESERVED",
          operation:
            (x.p_input as { operation: string }).operation === "source"
              ? sourceOp
              : clipOp,
        };
      case "observe":
        return { code: "OBSERVED" };
      case "check":
        return { code: "CURRENT" };
      case "finish":
        return { code: "PREPARED" };
      case "hold":
        return { code: "HELD" };
      case "poll":
        return { code: "WAIT" };
      default:
        throw Error("unexpected RPC");
    }
  });
  const adapter: Adapter = {
    copy: vi.fn<Adapter["copy"]>().mockResolvedValue(observation()),
    clip: vi.fn<Adapter["clip"]>().mockResolvedValue(observation(true)),
    inspect: vi
      .fn<Adapter["inspect"]>()
      .mockImplementation(async (_s, r) => observation(r.sourceUid !== null)),
    reconcile: vi
      .fn<Adapter["reconcile"]>()
      .mockResolvedValue({ state: "found", video: observation() }),
    frames: vi.fn<Adapter["frames"]>(),
  };
  const head = vi.fn<R2Bucket["head"]>().mockResolvedValue({
    key: `events/${job.eventId}/posts/${job.postId}/original/${assetId}.bin`,
    version: "v1",
    etag,
    size: 100,
  } as R2Object);
  env.ORIGINALS_BUCKET = { head };
  const fetcher = vi.fn<typeof fetch>(async (_target, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({
      success: true,
      errors: [],
      result: {
        uid: sourceUid,
        requireSignedURLs: true,
        allowedOrigins: ["app.example.test"],
        meta: body.meta,
        status: { state: "ready", pctComplete: "100" },
        readyToStream: true,
        duration: 3.8,
        input: { width: 1280, height: 720 },
        modified: new Date(Date.now() - 1000).toISOString(),
      },
    });
  });
  const run = () =>
    runStreamPreparation(job, env, fetcher, { rpc, adapter: () => adapter });
  return {
    env,
    plan,
    claimed,
    actions,
    overrides,
    rpc,
    adapter,
    head,
    fetcher,
    run,
  };
}
afterEach(() => vi.useRealTimers());
it("fresh source reserves once, observes then finishes without publishing", async () => {
  const f = fixture();
  expect(await f.run()).toBe("prepared");
  expect(f.actions.map((x) => x.name)).toEqual([
    "claim",
    "reserve",
    "observe",
    "finish",
  ]);
  expect(f.adapter.copy).toHaveBeenCalledWith(f.plan.scope, operationId, {
    size: 100,
    etag,
  });
  expect(f.adapter.clip).not.toHaveBeenCalled();
});
it("fallback waits for source then independently reserves and observes clip", async () => {
  const f = fixture();
  f.plan.originalScope = "full_video_fallback";
  expect(await f.run()).toBe("prepared");
  expect(f.actions.map((x) => x.name)).toEqual([
    "claim",
    "reserve",
    "observe",
    "reserve",
    "observe",
    "finish",
  ]);
  expect(f.adapter.clip).toHaveBeenCalledWith(
    f.plan.scope,
    clipOperationId,
    observation().reference,
    3.8,
  );
});
it.each(["PREPARED", "STALE", "BUSY", "INVALID_INPUT"])(
  "claim %s never touches provider",
  async (code) => {
    const f = fixture();
    f.claimed.code = code;
    expect(await f.run()).toBe(
      code === "PREPARED" ? "prepared" : code === "STALE" ? "stale" : "retry",
    );
    expect(f.adapter.copy).not.toHaveBeenCalled();
  },
);
it.each([undefined, "false", "TRUE"])(
  "flag %s disables all RPC/provider calls",
  async (flag) => {
    const f = fixture();
    if (flag === undefined) delete f.env.KOKO_STREAM_PROCESSING_ENABLED;
    else f.env.KOKO_STREAM_PROCESSING_ENABLED = flag;
    expect(await f.run()).toBe("retry");
    expect(f.rpc).not.toHaveBeenCalled();
  },
);
it.each(["event", "job", "lease", "expiry", "version", "original", "extra"])(
  "invalid plan %s fails closed",
  async (variant) => {
    const f = fixture();
    if (variant === "event") f.plan.scope.eventId = crypto.randomUUID();
    if (variant === "job") f.plan.scope.jobId = crypto.randomUUID();
    if (variant === "lease") f.plan.scope.leaseId = "bad";
    if (variant === "expiry") f.plan.scope.expiresAt = Date.now() - 1;
    if (variant === "version") f.plan.scope.postVersion = 1.5;
    if (variant === "original") f.plan.original.etag = "bad";
    if (variant === "extra") f.claimed.plan = { ...f.plan, secret: "raw" };
    expect(await f.run()).toBe("retry");
    expect(f.adapter.copy).not.toHaveBeenCalled();
  },
);
it.each([
  { state: null },
  { state: { unknown: {} } },
  { pollCount: -1 },
  { pollCount: 61 },
  { deadline: "later" },
])("malformed claimed state %o is rejected", async (value) => {
  const f = fixture();
  Object.assign(f.claimed, value);
  expect(await f.run()).toBe("retry");
  expect(f.adapter.copy).not.toHaveBeenCalled();
});
it.each(["deadline", "polls"])(
  "finite %s exhaustion holds without provider work",
  async (field) => {
    const f = fixture();
    if (field === "deadline") f.claimed.deadline = Date.now() - 1;
    else f.claimed.pollCount = 60;
    expect(await f.run()).toBe("held");
    expect(f.actions.at(-1)).toEqual({
      name: "hold",
      input: { plan: f.plan, errorCode: "STREAM_TIMEOUT" },
    });
    expect(f.adapter.copy).not.toHaveBeenCalled();
  },
);
it("known UID is inspected, not copied", async () => {
  const f = fixture();
  f.claimed.state = { source: { ...sourceOp, uid: sourceUid } };
  expect(await f.run()).toBe("prepared");
  expect(f.adapter.inspect).toHaveBeenCalled();
  expect(f.adapter.copy).not.toHaveBeenCalled();
  expect(f.actions.some((x) => x.name === "reserve")).toBe(false);
});
it("ambiguous reserved operation is reconciled read-only; absence only polls", async () => {
  const f = fixture();
  f.claimed.state = { source: sourceOp };
  vi.mocked(f.adapter.reconcile).mockResolvedValue({ state: "not_found" });
  expect(await f.run()).toBe("retry");
  expect(f.adapter.reconcile).toHaveBeenCalledWith(
    f.plan.scope,
    operationId,
    null,
  );
  expect(f.adapter.copy).not.toHaveBeenCalled();
  expect(f.actions.at(-1)?.name).toBe("poll");
});
it("race returning EXISTING also reconciles instead of repeating create", async () => {
  const f = fixture();
  f.overrides.reserve = { code: "EXISTING", operation: sourceOp };
  expect(await f.run()).toBe("prepared");
  expect(f.adapter.reconcile).toHaveBeenCalled();
  expect(f.adapter.copy).not.toHaveBeenCalled();
});
it.each([
  { state: "pending", processingComplete: false },
  { state: "ready", processingComplete: false },
  { state: "ready", readyToStream: false },
] as const)(
  "partial source %o polls without publication/clip",
  async (change) => {
    const f = fixture();
    vi.mocked(f.adapter.copy).mockResolvedValue({
      ...observation(),
      ...change,
    });
    expect(await f.run()).toBe("retry");
    expect(f.actions.at(-1)?.name).toBe("poll");
    expect(f.adapter.clip).not.toHaveBeenCalled();
  },
);
it.each(["error", "too-long"])(
  "terminal source %s uses fixed hold",
  async (condition) => {
    const f = fixture();
    vi.mocked(f.adapter.copy).mockResolvedValue(
      condition === "error"
        ? { ...observation(), state: "error", processingComplete: false }
        : { ...observation(), measuredDurationSeconds: 4.001 },
    );
    expect(await f.run()).toBe("held");
    expect(f.actions.at(-1)?.input.errorCode).toBe(
      condition === "error" ? "STREAM_PROCESSING_FAILED" : "VIDEO_TOO_LONG",
    );
  },
);
it.each(["AMBIGUOUS_CREATE", "TIMEOUT", "PROVIDER_FAILED"] as const)(
  "%s preserves reservation then bounded polls",
  async (code) => {
    const f = fixture();
    vi.mocked(f.adapter.copy).mockRejectedValue(
      new StreamProcessingError(code),
    );
    expect(await f.run()).toBe("retry");
    expect(f.actions.at(-1)?.name).toBe("poll");
    expect(f.adapter.copy).toHaveBeenCalledTimes(1);
  },
);
it("STALE adapter result does not reschedule a mutate action", async () => {
  const f = fixture();
  vi.mocked(f.adapter.copy).mockRejectedValue(
    new StreamProcessingError("STALE"),
  );
  expect(await f.run()).toBe("stale");
  expect(f.actions.at(-1)?.name).toBe("reserve");
});
it("observe conflict never permits finish", async () => {
  const f = fixture();
  f.overrides.observe = { code: "OUTDATED" };
  expect(await f.run()).toBe("retry");
  expect(f.actions.some((x) => x.name === "finish")).toBe(false);
});
it("poll EXHAUSTED switches to hold", async () => {
  const f = fixture();
  vi.mocked(f.adapter.copy).mockRejectedValue(new Error("no raw reflection"));
  f.overrides.poll = { code: "EXHAUSTED" };
  expect(await f.run()).toBe("held");
});
it.each([
  null,
  { operationId, uid: sourceUid, sourceUid: null },
  { ...sourceOp, providerPostVersion: 4 },
  { ...sourceOp, providerJobId: "bad" },
])("invalid provider generation %o is never executed", async (source) => {
  const f = fixture();
  f.claimed.state = { source };
  expect(await f.run()).toBe("retry");
  expect(f.adapter.copy).not.toHaveBeenCalled();
  expect(f.adapter.inspect).not.toHaveBeenCalled();
});
it("real adapter path checks immutable HEAD and RPC scope independent of JSON field order", async () => {
  const f = fixture();
  f.plan.scope = Object.fromEntries(
    Object.entries(f.plan.scope).reverse(),
  ) as typeof f.plan.scope;
  expect(
    await runStreamPreparation(job, f.env, f.fetcher, { rpc: f.rpc }),
  ).toBe("prepared");
  expect(f.head).toHaveBeenCalledTimes(2);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(
    new URL(JSON.parse(String(f.fetcher.mock.calls[0]![1]?.body)).input)
      .pathname,
  ).toBe(
    `/koko-dev-originals/events/${job.eventId}/posts/${job.postId}/original/${assetId}.bin`,
  );
  expect(
    f.actions.filter((x) => x.name === "check").length,
  ).toBeGreaterThanOrEqual(2);
});
it.each([
  "http://app.example.test",
  "https://user@app.example.test",
  "https://app.example.test/path",
  "https://app.example.test:444",
  "https://app.example.test?query=1",
])("unsafe configured origin %s never calls provider", async (origin) => {
  const f = fixture();
  f.env.KOKO_STREAM_PLAYBACK_ORIGIN = origin;
  expect(
    await runStreamPreparation(job, f.env, f.fetcher, { rpc: f.rpc }),
  ).toBe("retry");
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("R2 generation mismatch stops before provider POST", async () => {
  const f = fixture();
  f.head.mockResolvedValue({ version: "other" } as R2Object);
  expect(
    await runStreamPreparation(job, f.env, f.fetcher, { rpc: f.rpc }),
  ).toBe("retry");
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("R2 HEAD has bounded wait even when binding never settles", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.head.mockImplementation(() => new Promise(() => {}));
  const pending = runStreamPreparation(job, f.env, f.fetcher, { rpc: f.rpc });
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toBe("retry");
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("RPC only uses fixed service endpoint and projects a bounded JSON envelope", async () => {
  const f = fixture();
  const fetcher = vi.fn<typeof fetch>(async (target, init) => {
    expect(String(target)).toBe(
      "https://fixture.supabase.co/rest/v1/rpc/manage_stream_processing",
    );
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("apikey")).toBe("sb_secret_fixture");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    return Response.json({ code: "STALE" });
  });
  expect(
    await createInternalRpc(f.env, fetcher)("manage_stream_processing", {}),
  ).toEqual({ code: "STALE" });
});
it.each([
  new Response("secret", {
    status: 302,
    headers: { location: "https://evil.test" },
  }),
  new Response("secret", { headers: { "content-type": "text/html" } }),
  Response.json({ wrong: "secret" }),
  Response.json(["secret"]),
])("RPC invalid envelope is sanitized", async (response) => {
  const f = fixture();
  await expect(
    createInternalRpc(f.env, vi.fn<typeof fetch>().mockResolvedValue(response))(
      "media_processing_status",
      {},
    ),
  ).rejects.toThrow("INTERNAL_RPC_FAILED");
});
it("RPC oversized body is canceled without raw error output", async () => {
  const f = fixture(),
    cancel = vi.fn();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(65537));
        },
        cancel,
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  await expect(
    createInternalRpc(f.env, fetcher)("manage_stream_processing", {}),
  ).rejects.toThrow("INTERNAL_RPC_FAILED");
  expect(cancel).toHaveBeenCalled();
});
it("RPC late response after timeout is canceled", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    cancel = vi.fn();
  let resolve: ((r: Response) => void) | undefined;
  const fetcher = vi.fn<typeof fetch>(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = expect(
    createInternalRpc(f.env, fetcher)("manage_stream_processing", {}),
  ).rejects.toThrow("INTERNAL_RPC_FAILED");
  await vi.advanceTimersByTimeAsync(5000);
  await pending;
  resolve!(
    new Response(new ReadableStream({ cancel }), {
      headers: { "content-type": "application/json" },
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(cancel).toHaveBeenCalled();
});
it("RPC caller abort does not wait for timeout", async () => {
  const f = fixture(),
    controller = new AbortController(),
    fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
  const pending = expect(
    createInternalRpc(f.env, fetcher)(
      "manage_stream_processing",
      {},
      controller.signal,
    ),
  ).rejects.toThrow("INTERNAL_RPC_FAILED");
  controller.abort();
  await pending;
});
