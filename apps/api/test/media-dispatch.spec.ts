import { afterEach, expect, it, vi } from "vitest";
import {
  handleMediaDispatchScheduled,
  mediaDispatchCron,
  type MediaDispatchEnv,
} from "../src/media-dispatch";
import worker from "../src/index";

const job = {
  job_id: "11111111-1111-4111-8111-111111111111",
  event_id: "22222222-2222-4222-8222-222222222222",
  post_id: "33333333-3333-4333-8333-333333333333",
  asset_id: "44444444-4444-4444-8444-444444444444",
  post_version: 2,
  attempt: 1,
};
const claimed = { code: "ok", jobs: [job], exhausted: false };
const settled = { code: "ok", settled: 1, stale: 0 };
const queueReceipt = {
  metadata: { metrics: { backlogCount: 1, backlogBytes: 300 } },
};
function fixture(result: unknown = claimed, ack: unknown = settled) {
  const sendBatch = vi
    .fn<NonNullable<MediaDispatchEnv["MEDIA_PROCESSING_QUEUE"]>["sendBatch"]>()
    .mockResolvedValue(queueReceipt);
  const env: MediaDispatchEnv = {
    KOKO_MEDIA_DISPATCH_ENABLED: "true",
    MEDIA_PROCESSING_QUEUE: { sendBatch },
    SUPABASE_URL: "https://fixture.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    SUPABASE_SECRET_KEY: "sb_secret_fixture",
  };
  const calls: Record<string, unknown>[] = [];
  const fetcher = vi.fn<typeof fetch>(async (target, init) => {
    const url = new URL(String(target));
    expect(url.origin).toBe("https://fixture.supabase.co");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get("apikey")).toBe(
      env.SUPABASE_SECRET_KEY,
    );
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    const input: Record<string, unknown> = JSON.parse(String(init?.body));
    calls.push(input);
    const isClaim = url.pathname.endsWith("/claim_media_dispatch");
    expect(url.pathname).toBe(
      `/rest/v1/rpc/${isClaim ? "claim_media_dispatch" : "settle_media_dispatch"}`,
    );
    const value = isClaim ? result : ack;
    if (value instanceof Error) throw value;
    return value instanceof Response ? value : Response.json(value);
  });
  return { env, sendBatch, fetcher, calls };
}
const run = (f: ReturnType<typeof fixture>, cron = mediaDispatchCron) =>
  handleMediaDispatchScheduled({ cron }, f.env, f.fetcher);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([undefined, "", "false", "TRUE"])(
  "default-off flag %s makes no external calls",
  async (flag) => {
    const f = fixture();
    if (flag === undefined) delete f.env.KOKO_MEDIA_DISPATCH_ENABLED;
    else f.env.KOKO_MEDIA_DISPATCH_ENABLED = flag;
    expect(await run(f)).toBeNull();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.sendBatch).not.toHaveBeenCalled();
  },
);
it("ignores other cron and does not expose an HTTP dispatch route", async () => {
  const f = fixture();
  expect(await run(f, "*/5 * * * *")).toBeNull();
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(
    (
      await worker.fetch(
        new Request("https://fixture.test/internal/media-dispatch"),
        {} as Env,
      )
    ).status,
  ).toBe(404);
});
it.each([
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "MEDIA_PROCESSING_QUEUE",
] as const)("fails closed for missing %s before claim", async (key) => {
  const f = fixture();
  delete f.env[key];
  expect(await run(f)).toMatchObject({ failed: true, claimed: 0 });
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("sends stable allowlisted envelope, waits before ack, and returns only safe aggregates", async () => {
  const f = fixture({
    ...claimed,
    jobs: [
      {
        ...job,
        private: "sb_secret_private",
        object_key: "secret",
        payload: { token: "private" },
      },
    ],
  });
  f.sendBatch.mockImplementationOnce(async () => {
    expect(f.calls).toHaveLength(1);
    return queueReceipt;
  });
  expect(await run(f)).toEqual({
    claimed: 1,
    sent: 1,
    retry: 0,
    invalid: 0,
    settled: 1,
    stale: 0,
    exhausted: false,
    failed: false,
  });
  expect(f.calls).toEqual([
    { p_limit: 10 },
    { p_claims: [{ job_id: job.job_id, attempt: 1, outcome: "sent" }] },
  ]);
  expect(f.sendBatch).toHaveBeenCalledWith([
    {
      body: {
        version: 1,
        kind: "process_media",
        job_id: job.job_id,
        event_id: job.event_id,
        post_id: job.post_id,
        asset_id: job.asset_id,
        post_version: job.post_version,
      },
      contentType: "json",
    },
  ]);
});
it("empty claim does not enqueue or settle and preserves exhaustion warning", async () => {
  const f = fixture({ code: "ok", jobs: [], exhausted: true });
  expect(await run(f)).toMatchObject({
    exhausted: true,
    claimed: 0,
    failed: false,
  });
  expect(f.calls).toHaveLength(1);
  expect(f.sendBatch).not.toHaveBeenCalled();
});
it("maximum batch uses one send and one settlement with bounded message bytes", async () => {
  const jobs = Array.from({ length: 10 }, (_, i) => ({
    ...job,
    job_id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  }));
  const f = fixture(
    { ...claimed, jobs },
    { code: "ok", settled: 10, stale: 0 },
  );
  expect(await run(f)).toMatchObject({
    claimed: 10,
    sent: 10,
    settled: 10,
    failed: false,
  });
  expect(f.sendBatch).toHaveBeenCalledTimes(1);
  expect(f.calls).toHaveLength(2);
  expect(JSON.stringify(f.sendBatch.mock.calls[0]![0]).length).toBeLessThan(
    4096,
  );
});
it("late claim response after timeout is discarded without queue delivery or settlement", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let finish!: (value: Response) => void;
  f.fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = run(f);
  await vi.advanceTimersByTimeAsync(5001);
  expect(await pending).toMatchObject({ failed: true, claimed: 0 });
  finish(Response.json(claimed));
  await vi.advanceTimersByTimeAsync(1);
  expect(f.sendBatch).not.toHaveBeenCalled();
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it("ack timeout preserves unknown DB outcome and does not resend", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const original = f.fetcher.getMockImplementation()!;
  f.fetcher
    .mockImplementationOnce(original)
    .mockImplementationOnce(() => new Promise(() => {}));
  const pending = run(f);
  await vi.advanceTimersByTimeAsync(5001);
  expect(await pending).toMatchObject({ failed: true, sent: 1, settled: 0 });
  expect(f.sendBatch).toHaveBeenCalledTimes(1);
});
it("invalid payload is retried without blocking valid work or leaking contents", async () => {
  const poison = {
    ...job,
    job_id: "55555555-5555-4555-8555-555555555555",
    asset_id: "private-url",
  };
  const f = fixture(
    { ...claimed, jobs: [job, poison] },
    { code: "ok", settled: 2, stale: 0 },
  );
  expect(await run(f)).toMatchObject({
    claimed: 2,
    sent: 1,
    retry: 1,
    invalid: 1,
    settled: 2,
  });
  expect(f.sendBatch.mock.calls[0]![0]).toHaveLength(1);
  expect(f.calls[1]).toEqual({
    p_claims: [
      { job_id: job.job_id, attempt: 1, outcome: "sent" },
      { job_id: poison.job_id, attempt: 1, outcome: "retry" },
    ],
  });
});
it.each([
  { asset_id: null },
  { post_id: null },
  { event_id: "bad" },
  { post_version: 0 },
  { post_version: 1.5 },
  { post_version: 2147483648 },
  { post_version: "2" },
])(
  "invalid message %j is retained for bounded retry, not sent",
  async (patch) => {
    const f = fixture({ ...claimed, jobs: [{ ...job, ...patch }] });
    expect(await run(f)).toMatchObject({ invalid: 1, sent: 0, retry: 1 });
    expect(f.sendBatch).not.toHaveBeenCalled();
  },
);
it.each([
  null,
  {},
  { ...claimed, exhausted: 1 },
  { ...claimed, jobs: null },
  { ...claimed, jobs: [job, job] },
  { ...claimed, jobs: Array(11).fill(job) },
  ...[0, 9, 1.5, "1", null].map((attempt) => ({
    ...claimed,
    jobs: [{ ...job, attempt }],
  })),
  { ...claimed, jobs: [{ ...job, job_id: "bad" }] },
])(
  "rejects invalid claim envelope %j before sending/settling",
  async (value) => {
    const f = fixture(value);
    expect(await run(f)).toMatchObject({ failed: true, claimed: 0 });
    expect(f.calls).toHaveLength(1);
    expect(f.sendBatch).not.toHaveBeenCalled();
  },
);
it("send rejection is ambiguous, retries same IDs, never marks sent", async () => {
  const f = fixture();
  f.sendBatch.mockRejectedValueOnce(new Error("sb_secret_private"));
  expect(await run(f)).toMatchObject({
    sent: 0,
    retry: 1,
    failed: true,
    settled: 1,
  });
  expect(f.calls[1]).toEqual({
    p_claims: [{ job_id: job.job_id, attempt: 1, outcome: "retry" }],
  });
});
it("send timeout settles retry; late send success cannot perform a second ack", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let finish!: () => void;
  f.sendBatch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(queueReceipt);
      }),
  );
  const pending = run(f);
  await vi.advanceTimersByTimeAsync(10001);
  expect(await pending).toMatchObject({
    failed: true,
    retry: 1,
    settled: 1,
    sent: 0,
  });
  finish();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1]).toMatchObject({ p_claims: [{ outcome: "retry" }] });
});
it("DB ack failure allows future duplicate envelope, not an immediate resend", async () => {
  const first = fixture(claimed, new Error("private"));
  expect(await run(first)).toMatchObject({ failed: true, sent: 1, settled: 0 });
  expect(first.sendBatch).toHaveBeenCalledTimes(1);
  const second = fixture({ ...claimed, jobs: [{ ...job, attempt: 2 }] });
  await run(second);
  expect(second.sendBatch.mock.calls[0]).toEqual(first.sendBatch.mock.calls[0]);
});
it.each([
  {},
  { code: "ok", settled: 2, stale: 0 },
  { code: "ok", settled: 0, stale: 0 },
  { code: "ok", settled: -1, stale: 2 },
  { code: "ok", settled: 0.5, stale: 0.5 },
])(
  "invalid settlement %j is reported as unknown, never resent immediately",
  async (value) => {
    const f = fixture(claimed, value);
    expect(await run(f)).toMatchObject({ failed: true, sent: 1, settled: 0 });
    expect(f.sendBatch).toHaveBeenCalledTimes(1);
  },
);
it("stale lease acknowledgement is visible and not counted as settled", async () => {
  expect(
    await run(fixture(claimed, { code: "ok", settled: 0, stale: 1 })),
  ).toMatchObject({ sent: 1, settled: 0, stale: 1 });
});
it.each([301, 401, 500])(
  "RPC status %i never forwards upstream detail",
  async (status) => {
    const f = fixture(
      new Response("sb_secret_private", {
        status,
        headers: {
          location: "https://other.test",
          "content-type": "application/json",
        },
      }),
    );
    expect(await run(f)).toMatchObject({ failed: true, claimed: 0 });
    expect(f.sendBatch).not.toHaveBeenCalled();
  },
);
it.each(["wrong type", "oversize", "bad json", "bad utf8"])(
  "rejects RPC %s",
  async (kind) => {
    const body =
      kind === "oversize"
        ? "x".repeat(65537)
        : kind === "bad utf8"
          ? new Uint8Array([0xff])
          : "not json";
    const f = fixture(
      new Response(body, {
        headers: {
          "content-type":
            kind === "wrong type" ? "text/html" : "application/json",
        },
      }),
    );
    expect(await run(f)).toMatchObject({ failed: true, claimed: 0 });
    expect(f.sendBatch).not.toHaveBeenCalled();
  },
);
it.each(["fetch", "body"])(
  "bounds an uncooperative RPC %s and makes no late send",
  async (where) => {
    vi.useFakeTimers();
    const f = fixture();
    f.fetcher.mockImplementationOnce(() =>
      where === "fetch"
        ? new Promise(() => {})
        : Promise.resolve(
            new Response(
              new ReadableStream({ pull: () => new Promise(() => {}) }),
              { headers: { "content-type": "application/json" } },
            ),
          ),
    );
    const pending = run(f);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await pending).toMatchObject({ failed: true, claimed: 0 });
    expect(f.sendBatch).not.toHaveBeenCalled();
  },
);
it("scheduled router separates dispatcher cron from enabled R2 recovery and logs aggregates only", async () => {
  const f = fixture();
  vi.stubGlobal("fetch", f.fetcher);
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  await worker.scheduled(
    { cron: mediaDispatchCron } as ScheduledController,
    {
      ...f.env,
      KOKO_UPLOADS_ENABLED: "true",
      KOKO_UPLOAD_RECOVERY_ENABLED: "true",
    } as unknown as Env,
  );
  expect(log).toHaveBeenCalledExactlyOnceWith("media_outbox_dispatch", {
    claimed: 1,
    sent: 1,
    retry: 0,
    invalid: 0,
    settled: 1,
    stale: 0,
    exhausted: false,
    failed: false,
  });
});
