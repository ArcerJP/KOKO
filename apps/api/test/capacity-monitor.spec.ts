import { afterEach, expect, it, vi } from "vitest";
import {
  handleCapacityMonitorScheduled,
  capacityMonitorCron,
  type CapacityMonitorEnv,
} from "../src/capacity-monitor";
import type { InternalRpc } from "../src/internal-rpc";
const event = "11111111-1111-4111-8111-111111111111",
  lease = "22222222-2222-4222-8222-222222222222",
  account = "a".repeat(32),
  token = "synthetic_analytics_".repeat(3);
function fixture() {
  const env: CapacityMonitorEnv = {
    KOKO_CAPACITY_MONITOR_ENABLED: "true",
    KOKO_CAPACITY_ANALYTICS_TOKEN: token,
    KOKO_EVENT_ID: event,
    R2_ACCOUNT_ID: account,
    SUPABASE_URL: "https://fixture.supabase.co",
    SUPABASE_SECRET_KEY: "sb_secret_fixture",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
  };
  const end = Math.floor(Date.now() / 1000) * 1000;
  const plan: Record<string, unknown> = {
    event_id: event,
    account_id: account,
    epoch: Math.floor(end / 3600000),
    policy_version: 1,
    limit_bytes: 1000,
    lease_id: lease,
    window_start: new Date(end - 86400000).toISOString().replace(".000Z", "Z"),
    window_end: new Date(end).toISOString().replace(".000Z", "Z"),
  };
  const row = (bucketName: string) => ({
    max: { payloadSize: 100, metadataSize: 10, objectCount: 2 },
    dimensions: { datetime: plan.window_end, bucketName },
  });
  const original = row("koko-dev-originals"),
    derived = row("koko-dev-derived");
  const data: { data: unknown; errors?: unknown } = {
    data: {
      viewer: { accounts: [{ originals: [original], derived: [derived] }] },
    },
  };
  const responses: Record<string, Record<string, unknown>> = {
    claim: { code: "CLAIMED", plan },
    finish: { code: "OBSERVED" },
    fail: { code: "RETRY" },
  };
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const rpc = vi.fn<InternalRpc>(async (name, input) => {
    expect(name).toBe("manage_capacity_monitor");
    const x = input as {
      p_event_id: string;
      p_action: string;
      p_input: Record<string, unknown>;
    };
    expect(x.p_event_id).toBe(event);
    calls.push({ action: x.p_action, input: x.p_input });
    return responses[x.p_action]!;
  });
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(data));
  const run = () =>
    handleCapacityMonitorScheduled(
      { cron: capacityMonitorCron },
      env,
      fetcher,
      { rpc },
    );
  return {
    env,
    plan,
    data,
    original,
    derived,
    responses,
    calls,
    rpc,
    fetcher,
    run,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it.each([undefined, "false", "TRUE", ""])("default off %s", async (flag) => {
  const f = fixture();
  if (flag === undefined) delete f.env.KOKO_CAPACITY_MONITOR_ENABLED;
  else f.env.KOKO_CAPACITY_MONITOR_ENABLED = flag;
  expect(await f.run()).toBeNull();
  expect(f.rpc).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("other cron never probes", async () => {
  const f = fixture();
  expect(
    await handleCapacityMonitorScheduled(
      { cron: "0 * * * *" },
      f.env,
      f.fetcher,
      { rpc: f.rpc },
    ),
  ).toBeNull();
  expect(f.rpc).not.toHaveBeenCalled();
});
it.each([
  "KOKO_EVENT_ID",
  "R2_ACCOUNT_ID",
  "KOKO_CAPACITY_ANALYTICS_TOKEN",
] as const)("no %s means no RPC/probe", async (name) => {
  const f = fixture();
  delete f.env[name];
  expect(await f.run()).toEqual({ state: "unconfigured" });
  expect(f.rpc).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each(["bad", "A".repeat(32), "a".repeat(33), "../bad"])(
  "bad configured account %s makes no calls",
  async (value) => {
    const f = fixture();
    f.env.R2_ACCOUNT_ID = value;
    expect(await f.run()).toEqual({ state: "unconfigured" });
    expect(f.rpc).not.toHaveBeenCalled();
  },
);
it.each(["short", "injected\r\nheader", "a".repeat(257)])(
  "bad token format never sends %s",
  async (value) => {
    const f = fixture();
    f.env.KOKO_CAPACITY_ANALYTICS_TOKEN = value;
    expect(await f.run()).toEqual({ state: "unconfigured" });
    expect(f.rpc).not.toHaveBeenCalled();
  },
);
it.each(["DISABLED", "WAIT", "DONE", "UNKNOWN"])(
  "claim %s makes no provider query",
  async (code) => {
    const f = fixture();
    f.responses.claim = { code };
    expect((await f.run())?.state).toBe(
      code === "DISABLED"
        ? "unconfigured"
        : code === "UNKNOWN"
          ? "unknown"
          : "idle",
    );
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it("fixed account, fixed two buckets and tiny latest-only GraphQL query", async () => {
  const f = fixture();
  expect(await f.run()).toEqual({ state: "observed" });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = f.fetcher.mock.calls[0]!;
  expect(String(url)).toBe("https://api.cloudflare.com/client/v4/graphql");
  expect(init?.method).toBe("POST");
  expect(init?.redirect).toBe("manual");
  expect(init?.cache).toBe("no-store");
  expect(new Headers(init?.headers).get("authorization")).toBe(
    `Bearer ${token}`,
  );
  expect(new Headers(init?.headers).has("apikey")).toBe(false);
  const body = JSON.parse(String(init?.body));
  expect(body.variables).toEqual({
    accountTag: account,
    startDate: f.plan.window_start,
    endDate: f.plan.window_end,
  });
  expect(body.query.match(/limit: 1/g)).toHaveLength(2);
  expect(body.query).toContain('bucketName: "koko-dev-originals"');
  expect(body.query).toContain('bucketName: "koko-dev-derived"');
  expect(body.query).not.toContain("sum");
  expect(f.calls.map((c) => c.action)).toEqual(["claim", "finish"]);
  const s = f.calls[1]!.input.samples as unknown[];
  expect(s).toHaveLength(2);
  expect(s[0]).toMatchObject({
    bucket: "koko-dev-originals",
    payload_bytes: 100,
    metadata_bytes: 10,
    object_count: 2,
  });
});
it("approved threshold crossing queues alert but doesn't send webhook here", async () => {
  const f = fixture();
  f.responses.finish = { code: "ALERTED" };
  expect(await f.run()).toEqual({ state: "alert_enqueued" });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it.each(["STALE", "DISABLED"])(
  "changed authorization before finish %s is stale",
  async (code) => {
    const f = fixture();
    f.responses.finish = { code };
    expect(await f.run()).toEqual({ state: "stale" });
    expect(f.calls.map((c) => c.action)).toEqual(["claim", "finish"]);
  },
);
it.each([
  { event_id: lease },
  { account_id: "b".repeat(32) },
  { epoch: 0 },
  { epoch: 1.1 },
  { policy_version: 0 },
  { policy_version: "1" },
  { limit_bytes: 0 },
  { limit_bytes: Number.MAX_SAFE_INTEGER + 1 },
  { lease_id: "bad" },
  { window_start: "bad" },
  { window_end: "2020-01-01T00:00:00Z" },
  { window_end: "2026-02-30T00:00:00Z" },
  { extra: "raw" },
])("invalid plan %o makes no provider call", async (change) => {
  const f = fixture();
  Object.assign(f.plan, change);
  expect(await f.run()).toEqual({ state: "unknown" });
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("future plan / wrong 24h window never probes", async () => {
  for (const part of ["window_start", "window_end"]) {
    const f = fixture();
    f.plan[part] = new Date(Date.now() + 60000).toISOString();
    expect(await f.run()).toEqual({ state: "unknown" });
    expect(f.fetcher).not.toHaveBeenCalled();
  }
});
it.each([
  null,
  {},
  [],
  { viewer: {} },
  { viewer: { accounts: [] } },
  { viewer: { accounts: [{}, {}] } },
  { viewer: { accounts: [{}] } },
  { viewer: { accounts: [{ originals: [], derived: [] }] } },
  { viewer: { accounts: [{ originals: [{}, {}], derived: [] }] } },
])("missing observations %o are unknown not zero", async (data) => {
  const f = fixture();
  f.data.data = data;
  expect(await f.run()).toEqual({ state: "unknown" });
  expect(f.calls.map((c) => c.action)).toEqual(["claim", "fail"]);
});
it.each([[{ message: "permission denied raw" }], "error", {}])(
  "GraphQL errors %o reject even with partial data",
  async (errors) => {
    const f = fixture();
    f.data.errors = errors;
    const result = await f.run();
    expect(result).toEqual({ state: "unknown" });
    expect(JSON.stringify(result)).not.toContain("permission");
    expect(f.calls.some((c) => c.action === "finish")).toBe(false);
  },
);
it.each([null, []])(
  "null/empty GraphQL errors %o with valid data is acceptable",
  async (errors) => {
    const f = fixture();
    f.data.errors = errors;
    expect(await f.run()).toEqual({ state: "observed" });
  },
);
it.each([-1, 0.1, Number.MAX_SAFE_INTEGER + 1, "100", null])(
  "invalid payload byte %s never accepted",
  async (value) => {
    const f = fixture();
    f.original.max.payloadSize = value as number;
    expect(await f.run()).toEqual({ state: "unknown" });
  },
);
it.each([-1, 0.5, "2", null])(
  "invalid count %s never accepted",
  async (value) => {
    const f = fixture();
    f.original.max.objectCount = value as number;
    expect(await f.run()).toEqual({ state: "unknown" });
  },
);
it("sum overflow of individually safe values rejected", async () => {
  const f = fixture();
  f.original.max.payloadSize = Number.MAX_SAFE_INTEGER;
  expect(await f.run()).toEqual({ state: "unknown" });
});
it("zero actual measurements are distinct from missing samples", async () => {
  const f = fixture();
  for (const x of [f.original, f.derived])
    x.max = { payloadSize: 0, metadataSize: 0, objectCount: 0 };
  expect(await f.run()).toEqual({ state: "observed" });
});
it.each(["foreign", "koko-dev-derived", "eu_koko-dev-originals"])(
  "wrong bucket identity %s rejects",
  async (bucket) => {
    const f = fixture();
    f.original.dimensions.bucketName = bucket;
    expect(await f.run()).toEqual({ state: "unknown" });
  },
);
it.each([
  "bad",
  "2026-02-30T00:00:00Z",
  "2026-01-01T00:00:00+09:00",
  "2026-01-01",
  "2020-01-01T00:00:00Z",
])("invalid/stale timestamp %s rejects", async (date) => {
  const f = fixture();
  f.original.dimensions.datetime = date;
  expect(await f.run()).toEqual({ state: "unknown" });
});
it("future and >2h-stale actual observation rejects", async () => {
  for (const delta of [1000, -7201000]) {
    const f = fixture();
    f.original.dimensions.datetime = new Date(
      Date.parse(String(f.plan.window_end)) + delta,
    ).toISOString();
    expect(await f.run()).toEqual({ state: "unknown" });
  }
});
it.each([301, 302, 401, 403, 429, 500, 503])(
  "provider HTTP %i never marked zero or immediately retried",
  async (status) => {
    const f = fixture();
    f.fetcher.mockResolvedValue(new Response("raw", { status }));
    expect(await f.run()).toEqual({ state: "unknown" });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.calls.map((c) => c.action)).toEqual(["claim", "fail"]);
  },
);
it("oversized/malformed body canceled", async () => {
  const f = fixture(),
    cancel = vi.fn();
  f.fetcher.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("x".repeat(32769)));
        },
        cancel,
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  expect(await f.run()).toEqual({ state: "unknown" });
  expect(cancel).toHaveBeenCalled();
});
it("network exception safely records failure without raw error", async () => {
  const f = fixture();
  f.fetcher.mockRejectedValue(new Error("secret raw response"));
  const r = await f.run();
  expect(r).toEqual({ state: "unknown" });
  expect(JSON.stringify(r)).not.toContain("secret");
  expect(f.calls[1]!.input).toEqual({ plan: f.plan });
});
it("uncooperative fetch timeout and late body cancellation", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let release!: (response: Response) => void;
  const cancel = vi.fn();
  f.fetcher.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.run();
  await vi.advanceTimersByTimeAsync(10001);
  expect(await pending).toEqual({ state: "unknown" });
  release(new Response(new ReadableStream({ cancel })));
  await vi.advanceTimersByTimeAsync(0);
  expect(cancel).toHaveBeenCalled();
});
it("stalled body deadline remains bounded", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    cancel = vi.fn();
  f.fetcher.mockResolvedValue(
    new Response(new ReadableStream({ cancel }), {
      headers: { "content-type": "application/json" },
    }),
  );
  const pending = f.run();
  await vi.advanceTimersByTimeAsync(10001);
  expect(await pending).toEqual({ state: "unknown" });
  expect(cancel).toHaveBeenCalled();
});
it("RPC failure before claim does not measure", async () => {
  const f = fixture();
  f.rpc.mockRejectedValue(new Error("raw"));
  expect(await f.run()).toEqual({ state: "unknown" });
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("fixed RPC transport separates service secret and Analytics token", async () => {
  const f = fixture();
  const fetcher = vi.fn<typeof fetch>(async (target, init) => {
    const url = new URL(String(target));
    if (url.hostname === "api.cloudflare.com") {
      expect(new Headers(init?.headers).has("apikey")).toBe(false);
      return Response.json(f.data);
    }
    expect(url.href).toBe(
      "https://fixture.supabase.co/rest/v1/rpc/manage_capacity_monitor",
    );
    expect(new Headers(init?.headers).get("apikey")).toBe("sb_secret_fixture");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    const x = JSON.parse(String(init?.body));
    return Response.json(f.responses[x.p_action]);
  });
  expect(
    await handleCapacityMonitorScheduled(
      { cron: capacityMonitorCron },
      f.env,
      fetcher,
    ),
  ).toEqual({ state: "observed" });
  expect(fetcher).toHaveBeenCalledTimes(3);
});
