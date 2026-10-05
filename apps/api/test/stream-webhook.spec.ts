import { afterEach, expect, it, vi } from "vitest";
import {
  handleStreamWebhook,
  streamWebhookPath,
  type StreamWebhookEnv,
} from "../src/stream-webhook";
const ids = {
  event: "11111111-1111-4111-8111-111111111111",
  post: "22222222-2222-4222-8222-222222222222",
  asset: "33333333-3333-4333-8333-333333333333",
  job: "44444444-4444-4444-8444-444444444444",
  operation: "55555555-5555-4555-8555-555555555555",
};
const secret = "synthetic-stream-webhook-secret",
  uid = "a".repeat(32);
const message = {
  version: 1,
  kind: "process_media",
  event_id: ids.event,
  post_id: ids.post,
  asset_id: ids.asset,
  job_id: ids.job,
  post_version: 3,
};
function video(change: Record<string, unknown> = {}) {
  return {
    uid,
    requireSignedURLs: true,
    allowedOrigins: ["fixture.example"],
    meta: {
      name: `koko-${ids.operation}`,
      koko_event: ids.event,
      koko_post: ids.post,
      koko_asset: ids.asset,
      koko_job: ids.job,
      koko_version: "3",
      koko_operation: ids.operation,
      koko_source: "original",
    },
    status: { state: "ready", pctComplete: "100" },
    readyToStream: true,
    duration: 3.8,
    input: { width: 1280, height: 720 },
    modified: new Date(Date.now() - 1000).toISOString(),
    ...change,
  };
}
async function request(
  value: unknown = video(),
  options: {
    secret?: string;
    time?: number;
    headers?: Record<string, string>;
    url?: string;
    raw?: string;
  } = {},
) {
  const body = options.raw ?? JSON.stringify(value),
    time = options.time ?? Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(options.secret ?? secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${time}.${body}`),
    ),
  );
  const hex = Array.from(signature, (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return new Request(
    options.url ?? `https://fixture.example${streamWebhookPath}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-signature": `time=${time},sig1=${hex}`,
        ...options.headers,
      },
      body,
    },
  );
}
function fixture(result: unknown = { code: "READY", message }) {
  const sendBatch = vi
    .fn<NonNullable<StreamWebhookEnv["MEDIA_PROCESSING_QUEUE"]>["sendBatch"]>()
    .mockResolvedValue({
      metadata: { metrics: { backlogCount: 1, backlogBytes: 300 } },
    });
  const env: StreamWebhookEnv = {
    KOKO_STREAM_WEBHOOK_ENABLED: "true",
    KOKO_STREAM_WEBHOOK_SECRET: secret,
    KOKO_EVENT_ID: ids.event,
    R2_ACCOUNT_ID: "c".repeat(32),
    KOKO_STREAM_PLAYBACK_ORIGIN: "https://fixture.example",
    SUPABASE_URL: "https://fixture.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    SUPABASE_SECRET_KEY: "sb_secret_fixture",
    MEDIA_PROCESSING_QUEUE: { sendBatch },
  };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe(
      "https://fixture.supabase.co/rest/v1/rpc/resolve_stream_webhook",
    );
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(init?.cache).toBe("no-store");
    expect(new Headers(init?.headers).get("apikey")).toBe("sb_secret_fixture");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      p_event_id: ids.event,
      p_post_id: ids.post,
      p_asset_id: ids.asset,
      p_provider_job_id: ids.job,
      p_provider_post_version: 3,
      p_operation_id: ids.operation,
      p_stream_uid: uid,
      p_source_uid: null,
    });
    if (result instanceof Error) throw result;
    return result instanceof Response ? result : Response.json(result);
  });
  const run = async (r?: Request) =>
    handleStreamWebhook(r ?? (await request()), env, fetcher);
  return { env, fetcher, sendBatch, run };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([undefined, "false", "TRUE", ""])(
  "default OFF flag %s does not inspect signed payload",
  async (flag) => {
    const f = fixture();
    if (flag === undefined) delete f.env.KOKO_STREAM_WEBHOOK_ENABLED;
    else f.env.KOKO_STREAM_WEBHOOK_ENABLED = flag;
    expect((await f.run()).status).toBe(404);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.sendBatch).not.toHaveBeenCalled();
  },
);
it.each([
  "KOKO_EVENT_ID",
  "R2_ACCOUNT_ID",
  "KOKO_STREAM_WEBHOOK_SECRET",
  "KOKO_STREAM_PLAYBACK_ORIGIN",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "MEDIA_PROCESSING_QUEUE",
] as const)("missing %s fails closed without external work", async (key) => {
  const f = fixture();
  delete f.env[key];
  expect((await f.run()).status).toBe(503);
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([
  { origin: "https://evil.test" },
  { cookie: "session=private" },
  { authorization: "Bearer private" },
  { "x-filler": "x".repeat(8192) },
])(
  "browser credentials / oversized headers rejected before DB",
  async (headers) => {
    const f = fixture();
    expect((await f.run(await request(undefined, { headers }))).status).toBe(
      400,
    );
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it.each([
  "http://fixture.example/internal/stream-webhook",
  "https://fixture.example/other",
  "https://fixture.example/internal/stream-webhook?uid=private",
])("route restricted %s", async (url) => {
  const f = fixture();
  expect((await f.run(await request(undefined, { url }))).status).toBe(400);
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each(["GET", "PUT", "DELETE"])(
  "method %s does not invoke verifier/DB",
  async (method) => {
    const f = fixture();
    expect(
      (
        await f.run(
          new Request(`https://fixture.example${streamWebhookPath}`, {
            method,
          }),
        )
      ).status,
    ).toBe(400);
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it("verified notification sends DB hint only; raw playback URLs never requested or exposed", async () => {
  const f = fixture();
  const response = await f.run(
    await request(
      video({
        playback: { hls: "http://169.254.169.254/private" },
        preview: "private-provider-url",
      }),
    ),
  );
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ accepted: true });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(f.sendBatch).toHaveBeenCalledWith([
    { body: message, contentType: "json" },
  ]);
  expect(f.fetcher).toHaveBeenCalledOnce();
});
it("signed callback replay is a duplicate-safe existing job hint, not another upload/job", async () => {
  const f = fixture();
  const first = await request();
  const second = first.clone();
  expect((await f.run(first)).status).toBe(202);
  expect((await f.run(second)).status).toBe(202);
  expect(f.sendBatch.mock.calls[0]).toEqual(f.sendBatch.mock.calls[1]);
});
it.each([
  {
    status: { state: "error", errorReasonText: "private provider diagnostic" },
    readyToStream: false,
    duration: 0,
    input: {},
  },
  { status: { state: "ready", pctComplete: "39" }, readyToStream: true },
  { duration: 30 },
])(
  "error/partial/long video still supplies only a recheck hint %j",
  async (change) => {
    const f = fixture();
    const response = await f.run(await request(video(change)));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(f.sendBatch).toHaveBeenCalledWith([
      { body: message, contentType: "json" },
    ]);
  },
);
it("valid foreign event is acknowledged without DB or Queue disclosure", async () => {
  const f = fixture();
  const body = video();
  body.meta = {
    ...body.meta,
    koko_event: "66666666-6666-4666-8666-666666666666",
  };
  expect((await f.run(await request(body))).status).toBe(202);
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.sendBatch).not.toHaveBeenCalled();
});
it.each([-301, 31])(
  "outdated/future signature timestamp %s cannot touch DB",
  async (delta) => {
    const f = fixture();
    expect(
      (
        await f.run(
          await request(undefined, {
            time: Math.floor(Date.now() / 1000) + delta,
          }),
        )
      ).status,
    ).toBe(401);
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it("wrong signature and duplicate signature fields cannot reach DB", async () => {
  const f = fixture();
  expect(
    (
      await f.run(
        await request(undefined, { secret: "other-synthetic-secret" }),
      )
    ).status,
  ).toBe(401);
  const duplicated = await request();
  duplicated.headers.append(
    "webhook-signature",
    duplicated.headers.get("webhook-signature")!,
  );
  expect((await f.run(duplicated)).status).toBe(401);
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([
  { raw: "x".repeat(65537) },
  { headers: { "content-encoding": "gzip" } },
  { headers: { "content-length": "100000" } },
  { headers: { "content-type": "text/plain" } },
])("unbounded/encoded/nonJSON input is refused", async (options) => {
  const f = fixture();
  expect((await f.run(await request(undefined, options))).status).toBe(401);
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("ignored DB scope has same public response without sending a message", async () => {
  const f = fixture({ code: "IGNORED" });
  const response = await f.run();
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ accepted: true });
  expect(f.sendBatch).not.toHaveBeenCalled();
});
it("uses current retry job/version from DB rather than provider's old generation", async () => {
  const current = {
    ...message,
    job_id: "77777777-7777-4777-8777-777777777777",
    post_version: 5,
  };
  const f = fixture({ code: "READY", message: current });
  expect((await f.run()).status).toBe(202);
  expect(f.sendBatch).toHaveBeenCalledWith([
    { body: current, contentType: "json" },
  ]);
});
it.each([
  { code: "READY", message: { ...message, uid } },
  { code: "READY", message: { ...message, event_id: ids.job } },
  { code: "READY", message: { ...message, asset_id: ids.job } },
  { code: "READY", message: { ...message, post_version: 2 } },
  { code: "IGNORED", uid },
  { code: "UNKNOWN" },
  new Error("provider private text"),
  new Response(null, {
    status: 302,
    headers: { location: "https://evil.test" },
  }),
])(
  "untrusted/malformed DB result never escapes or dispatches %j",
  async (result) => {
    const f = fixture(result);
    const response = await f.run();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "WEBHOOK_UNAVAILABLE" });
    expect(f.sendBatch).not.toHaveBeenCalled();
  },
);
it("Queue failure yields retryable generic response", async () => {
  const f = fixture();
  f.sendBatch.mockRejectedValue(new Error("private queue exception"));
  const response = await f.run();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: "WEBHOOK_UNAVAILABLE" });
});
it("Queue send timeout does not claim exact once; caller may retry safely", async () => {
  const r = await request();
  vi.useFakeTimers();
  const f = fixture();
  f.sendBatch.mockImplementation(() => new Promise(() => {}));
  const pending = f.run(r);
  await vi.advanceTimersByTimeAsync(0);
  await vi.waitFor(() => expect(f.sendBatch).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(10000);
  expect((await pending).status).toBe(503);
});
