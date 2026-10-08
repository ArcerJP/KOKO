import { afterEach, expect, it, vi } from "vitest";
import {
  consumeStageThreeOutbox,
  handleStageThreeOutboxScheduled,
  stageThreeOutboxCron,
  type StageThreeOutboxEnv,
} from "../src/stage-three-outbox";
import type { InternalRpc } from "../src/internal-rpc";
const claim = {
  job_id: "11111111-1111-4111-8111-111111111111",
  event_id: "22222222-2222-4222-8222-222222222222",
  lease_id: "33333333-3333-4333-8333-333333333333",
  kind: "notify" as const,
  attempt: 1,
};
const post = "44444444-4444-4444-8444-444444444444",
  webhook = "123456789012345678",
  token = "synthetic_".repeat(7);
const receipt = {
  id: "234567890123456789",
  webhook_id: webhook,
  channel_id: "345678901234567890",
};
function fixture() {
  const env: StageThreeOutboxEnv = {
    KOKO_OPERATIONAL_OUTBOX_ENABLED: "true",
    KOKO_DISCORD_NOTIFICATIONS_ENABLED: "true",
    KOKO_EVENT_ID: claim.event_id,
    KOKO_DISCORD_WEBHOOK_URL: `https://discord.com/api/webhooks/${webhook}/${token}`,
    KOKO_ADMIN_ORIGIN: "https://app.example.test",
    SUPABASE_URL: "https://fixture.supabase.co",
    SUPABASE_SECRET_KEY: "sb_secret_fixture",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
  };
  const notification: Record<string, unknown> = {
    job_id: claim.job_id,
    event_id: claim.event_id,
    post_id: post,
    category: "block",
    display_name: "Synthetic",
    report_count: null,
  };
  const responses: Record<string, Record<string, unknown>> = {
    claim: { code: "CLAIMED", jobs: [{ ...claim }], held: 0 },
    prepare: { code: "SEND", notification },
  };
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const rpc = vi.fn<InternalRpc>(async (name, input) => {
    expect(name).toBe("stage_three_outbox");
    const data = input as Record<string, unknown>;
    expect(data.p_event_id).toBe(claim.event_id);
    if (data.p_action !== "claim") expect(data.p_job_id).toBe(claim.job_id);
    const action = String(data.p_action),
      params = data.p_input as Record<string, unknown>;
    calls.push({ action, input: params });
    if (responses[action]) return responses[action]!;
    if (action === "settle")
      return {
        code: (
          {
            delivered: "DONE",
            retry: "RETRY",
            ambiguous: "AMBIGUOUS",
            rejected: "HELD",
          } as Record<string, string>
        )[String(params.outcome)],
      };
    throw new Error("unexpected RPC");
  });
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(receipt));
  const run = () =>
    handleStageThreeOutboxScheduled(
      { cron: stageThreeOutboxCron },
      env,
      fetcher,
      { rpc },
    );
  return { env, notification, responses, calls, rpc, fetcher, run };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it.each([undefined, "", "false", "TRUE"])(
  "default off %s makes no calls",
  async (flag) => {
    const f = fixture();
    if (flag === undefined) delete f.env.KOKO_OPERATIONAL_OUTBOX_ENABLED;
    else f.env.KOKO_OPERATIONAL_OUTBOX_ENABLED = flag;
    expect(await f.run()).toBe(null);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it("other cron makes no calls", async () => {
  const f = fixture();
  expect(
    await handleStageThreeOutboxScheduled(
      { cron: "*/5 * * * *" },
      f.env,
      f.fetcher,
      { rpc: f.rpc },
    ),
  ).toBe(null);
  expect(f.rpc).not.toHaveBeenCalled();
});
it("DB flag disabled makes no provider call", async () => {
  const f = fixture();
  f.responses.claim = { code: "DISABLED" };
  expect((await f.run())?.claimed).toBe(0);
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("minimal private notification, wait confirmation and separate apikey scope", async () => {
  const f = fixture();
  expect((await f.run())?.done).toBe(1);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = f.fetcher.mock.calls[0]!;
  expect(String(url)).toBe(
    `https://discord.com/api/v10/webhooks/${webhook}/${token}?wait=true`,
  );
  expect(init?.method).toBe("POST");
  expect(init?.redirect).toBe("manual");
  expect(init?.cache).toBe("no-store");
  expect(new Headers(init?.headers).has("apikey")).toBe(false);
  expect(new Headers(init?.headers).has("authorization")).toBe(false);
  const body = JSON.parse(String(init?.body));
  expect(Object.keys(body).sort()).toEqual([
    "allowed_mentions",
    "content",
    "flags",
  ]);
  expect(body.allowed_mentions).toEqual({ parse: [] });
  expect(body.flags).toBe(4);
  expect(body.content).toContain(`投稿ID: ${post}`);
  expect(body.content).toContain("表示名: Synthetic");
  expect(body.content).toContain("block");
  expect(body.content).toContain("<https://app.example.test/manage>");
  expect(body.content).not.toContain("post_id=");
  expect(body.content).toContain(claim.job_id);
  expect(body.content.length).toBeLessThan(2000);
  expect(f.calls.map((c) => c.action)).toEqual(["claim", "prepare", "settle"]);
  expect(f.calls[2]!.input).toEqual({
    lease_id: claim.lease_id,
    outcome: "delivered",
    retry_seconds: 0,
  });
  expect(JSON.stringify(await f.run())).not.toMatch(
    /Synthetic|sb_secret|http|11111111/,
  );
});
it("display name is escaped; cannot add mention, URL, Markdown, bidi or fake lines", async () => {
  const f = fixture();
  f.notification.display_name =
    "@everyone <@123>\n[click](https://evil.test)\u202e `*#";
  expect((await f.run())?.done).toBe(1);
  const body = JSON.parse(String(f.fetcher.mock.calls[0]![1]?.body));
  const line = body.content
    .split("\n")
    .find((x: string) => x.startsWith("表示名:"));
  expect(line).not.toMatch(/@|https:|evil\.test|`|\*|\[|\u202e/);
  expect(line).toContain("＠everyone");
  expect(body.allowed_mentions.parse).toEqual([]);
});
it.each([
  "flag",
  "block",
  "ai_error",
  "stream_failure",
  "processing_error",
  "report",
  "ban",
  "appeal",
])("category %s has no media/provider/raw data", async (category) => {
  const f = fixture();
  f.notification.category = category;
  if (category === "report") f.notification.report_count = 2;
  if (category === "ban") f.notification.post_id = null;
  expect((await f.run())?.done).toBe(1);
  const body = JSON.parse(String(f.fetcher.mock.calls[0]![1]?.body));
  expect(body.content).toContain(category);
  expect(body).not.toHaveProperty("embeds");
  expect(body).not.toHaveProperty("files");
  if (category === "ban")
    expect(body.content).toContain("<https://app.example.test/manage>");
  if (category === "report") expect(body.content).toContain("通報: 2件目");
});
it.each([
  "http://discord.com/api/webhooks/123456789012345678/" + token,
  "https://discord.com.evil.test/api/webhooks/123456789012345678/" + token,
  "https://discordapp.com/api/webhooks/123456789012345678/" + token,
  "https://user@discord.com/api/webhooks/123456789012345678/" + token,
  "https://discord.com:444/api/webhooks/123456789012345678/" + token,
  "https://discord.com/api/webhooks/123456789012345678/" +
    token +
    "?thread_id=123",
  "https://discord.com/api/webhooks/123456789012345678/" + token + "#hash",
  "https://discord.com/api/webhooks/123456789012345678/short",
  "https://discord.com/api/webhooks/123/" + token,
  "https://discord.com/api/v9/webhooks/123456789012345678/" + token,
  "https://discord.com/api/webhooks/123456789012345678/" + token + "/messages",
])("unsafe webhook never claimed or sent %s", async (url) => {
  const f = fixture();
  f.env.KOKO_DISCORD_WEBHOOK_URL = url;
  f.responses.claim = { code: "CLAIMED", jobs: [], held: 0 };
  const result = await f.run();
  expect(result?.notification_unavailable).toBe(true);
  expect(f.calls[0]!.input.notify).toBe(false);
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([
  "http://app.example.test",
  "https://user@app.example.test",
  "https://app.example.test:444",
  "https://app.example.test/admin",
  "https://app.example.test?x=1",
  "https://app.example.test#x",
  "https://127.0.0.1",
  "https://localhost",
])("unsafe admin origin %s makes no provider calls", async (origin) => {
  const f = fixture();
  f.env.KOKO_ADMIN_ORIGIN = origin;
  expect(await consumeStageThreeOutbox(claim, f.env, f.rpc, f.fetcher)).toBe(
    "failed",
  );
  expect(f.rpc).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("notification disabled does not claim notification", async () => {
  const f = fixture();
  delete f.env.KOKO_DISCORD_NOTIFICATIONS_ENABLED;
  f.responses.claim = { code: "CLAIMED", jobs: [], held: 0 };
  await f.run();
  expect(f.calls[0]!.input.notify).toBe(false);
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("both configured v10 and generated unversioned endpoint supported", async () => {
  const f = fixture();
  f.env.KOKO_DISCORD_WEBHOOK_URL = f.env.KOKO_DISCORD_WEBHOOK_URL!.replace(
    "/api/",
    "/api/v10/",
  );
  expect((await f.run())?.done).toBe(1);
});
it.each([200, 204, 301, 302, 307, 308, 500, 502, 503])(
  "no confirmed receipt on HTTP %i is ambiguous, never immediate retry",
  async (status) => {
    const f = fixture();
    f.fetcher.mockResolvedValue(
      status === 204
        ? new Response(null, { status })
        : Response.json({ unexpected: "raw" }, { status }),
    );
    expect((await f.run())?.ambiguous).toBe(1);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.calls[2]!.input.outcome).toBe("ambiguous");
  },
);
it.each([400, 401, 403, 404, 405, 413])(
  "definitive client rejection HTTP %i is held",
  async (status) => {
    const f = fixture();
    f.fetcher.mockResolvedValue(
      new Response("provider private error", { status }),
    );
    const r = await f.run();
    expect(r?.held).toBe(1);
    expect(JSON.stringify(r)).not.toContain("private");
  },
);
it("429 with explicit Retry-After is bounded by SQL backoff", async () => {
  const f = fixture();
  f.fetcher.mockResolvedValue(
    Response.json({ retry_after: 3.2 }, { status: 429 }),
  );
  expect((await f.run())?.retry).toBe(1);
  expect(f.calls[2]!.input).toMatchObject({
    outcome: "retry",
    retry_seconds: 4,
  });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it.each([-1, 0, 86401, "1", null])(
  "bad 429 delay %s is ambiguous",
  async (retry_after) => {
    const f = fixture();
    f.fetcher.mockResolvedValue(
      Response.json({ retry_after }, { status: 429 }),
    );
    expect((await f.run())?.ambiguous).toBe(1);
  },
);
it.each([
  { id: "bad", webhook_id: webhook, channel_id: receipt.channel_id },
  { ...receipt, webhook_id: "987654321098765432" },
  { ...receipt, channel_id: null },
  null,
  [],
])("invalid receipt %o is ambiguous", async (data) => {
  const f = fixture();
  f.fetcher.mockResolvedValue(Response.json(data));
  expect((await f.run())?.ambiguous).toBe(1);
});
it("network exception is ambiguous, message never logged or rethrown", async () => {
  const f = fixture();
  f.fetcher.mockRejectedValue(new Error("raw secret"));
  const r = await f.run();
  expect(r?.ambiguous).toBe(1);
  expect(JSON.stringify(r)).not.toContain("secret");
});
it("invalid/oversized body cancels and becomes ambiguous", async () => {
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
  expect((await f.run())?.ambiguous).toBe(1);
  expect(cancel).toHaveBeenCalled();
});
it("invalid UTF-8 is ambiguous", async () => {
  const f = fixture();
  f.fetcher.mockResolvedValue(
    new Response(new Uint8Array([0xff]), {
      headers: { "content-type": "application/json" },
    }),
  );
  expect((await f.run())?.ambiguous).toBe(1);
});
it("uncooperative fetch stops at 10 seconds and cancels late body", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let release!: (value: Response) => void;
  const cancel = vi.fn();
  f.fetcher.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.run();
  await vi.advanceTimersByTimeAsync(10001);
  expect((await pending)?.ambiguous).toBe(1);
  expect(f.calls[2]!.input.outcome).toBe("ambiguous");
  release(new Response(new ReadableStream({ cancel })));
  await vi.advanceTimersByTimeAsync(0);
  expect(cancel).toHaveBeenCalled();
});
it("stalled response body stops at deadline and cancels", async () => {
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
  expect((await pending)?.ambiguous).toBe(1);
  expect(cancel).toHaveBeenCalled();
});
it.each([
  { job_id: "bad" },
  { event_id: "55555555-5555-4555-8555-555555555555" },
  { post_id: "bad" },
  { post_id: null },
  { category: "capacity" },
  { category: "block", report_count: 1 },
  { category: "report", report_count: 3 },
  { display_name: 12 },
  { display_name: "x".repeat(257) },
  { url: "https://bad" },
])("invalid minimal notification %o never sends", async (change) => {
  const f = fixture();
  Object.assign(f.notification, change);
  expect((await f.run())?.ambiguous).toBe(1);
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.calls[2]!.input.outcome).toBe("ambiguous");
});
it.each(["STALE", "DISABLED"])("fresh prepare %s avoids send", async (code) => {
  const f = fixture();
  f.responses.prepare = { code };
  expect((await f.run())?.stale).toBe(1);
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each(["revoke_delivery", "delete_assets"] as const)(
  "%s consumer has no provider/physical deletion adapter",
  async (kind) => {
    const f = fixture();
    f.responses.claim = {
      code: "CLAIMED",
      jobs: [{ ...claim, kind }],
      held: 0,
    };
    f.responses.prepare = {
      code: kind === "delete_assets" ? "HELD" : "DONE",
      result:
        kind === "delete_assets"
          ? "RETENTION_UNKNOWN"
          : "APPLICATION_GATE_CHECKED",
    };
    const r = await f.run();
    expect(r?.[kind === "delete_assets" ? "held" : "done"]).toBe(1);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.calls.map((c) => c.action)).toEqual(["claim", "prepare"]);
  },
);
it("RPC outage after confirmed send is not automatically retried", async () => {
  const f = fixture();
  const orig = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async (...args) => {
    if ((args[1] as { p_action: string }).p_action === "settle")
      throw new Error("raw");
    return orig(...args);
  });
  expect((await f.run())?.failed).toBe(1);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  { code: "CLAIMED", jobs: [claim, claim], held: 0 },
  { code: "CLAIMED", jobs: Array(11).fill(claim), held: 0 },
  { code: "CLAIMED", jobs: [{ ...claim, event_id: post }], held: 0 },
  { code: "CLAIMED", jobs: [{ ...claim, attempt: 0 }], held: 0 },
  { code: "CLAIMED", jobs: [{ ...claim, kind: "export" }], held: 0 },
  { code: "CLAIMED", jobs: [{ ...claim, extra: true }], held: 0 },
  { code: "CLAIMED", jobs: [], held: 11 },
])("invalid claim batch %o performs no provider IO", async (value) => {
  const f = fixture();
  f.responses.claim = value;
  expect((await f.run())?.failed).toBe(1);
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("malformed direct consumer claim does not invoke RPC", async () => {
  const f = fixture();
  expect(
    await consumeStageThreeOutbox(
      null as unknown as typeof claim,
      f.env,
      f.rpc,
      f.fetcher,
    ),
  ).toBe("failed");
  expect(f.rpc).not.toHaveBeenCalled();
});
it("two concurrent workers maximum", async () => {
  const f = fixture(),
    jobs = Array.from({ length: 10 }, (_, i) => ({
      ...claim,
      job_id: `11111111-1111-4111-8111-${String(i + 1).padStart(12, "0")}`,
    }));
  let active = 0,
    max = 0;
  const rpc = vi.fn<InternalRpc>(async (_name, input) => {
    const x = input as { p_action: string; p_job_id: string };
    if (x.p_action === "claim") return { code: "CLAIMED", jobs, held: 0 };
    if (x.p_action === "prepare")
      return {
        code: "SEND",
        notification: { ...f.notification, job_id: x.p_job_id },
      };
    return { code: "DONE" };
  });
  f.fetcher.mockImplementation(async () => {
    active++;
    max = Math.max(max, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return Response.json(receipt);
  });
  const r = await handleStageThreeOutboxScheduled(
    { cron: stageThreeOutboxCron },
    f.env,
    f.fetcher,
    { rpc },
  );
  expect(r?.done).toBe(10);
  expect(max).toBe(2);
});
it("real fixed RPC transport only sends secret to Supabase", async () => {
  const f = fixture(),
    fetcher = vi.fn<typeof fetch>(async (target, init) => {
      const url = new URL(String(target));
      if (url.hostname === "discord.com") {
        expect(new Headers(init?.headers).has("apikey")).toBe(false);
        return Response.json(receipt);
      }
      expect(url.origin).toBe("https://fixture.supabase.co");
      expect(url.pathname).toBe("/rest/v1/rpc/stage_three_outbox");
      expect(new Headers(init?.headers).get("apikey")).toBe(
        "sb_secret_fixture",
      );
      const x = JSON.parse(String(init?.body));
      return Response.json(
        x.p_action === "settle" ? { code: "DONE" } : f.responses[x.p_action],
      );
    });
  const r = await handleStageThreeOutboxScheduled(
    { cron: stageThreeOutboxCron },
    f.env,
    fetcher,
  );
  expect(r?.done).toBe(1);
  expect(fetcher).toHaveBeenCalledTimes(4);
});
it("capacity notification is minimal, contains measured bytes, and has no owner/media identity", async () => {
  const f = fixture();
  f.notification.category = "capacity";
  f.notification.post_id = null;
  f.notification.display_name = "イベント容量監視";
  f.notification.capacity = {
    observed_bytes: 1234,
    limit_bytes: 1000,
    observed_at: "2026-10-06T00:00:00Z",
  };
  expect((await f.run())?.done).toBe(1);
  const body = JSON.parse(String(f.fetcher.mock.calls[0]![1]?.body));
  expect(body.content).toContain("1234 bytes");
  expect(body.content).toContain("1000 bytes");
  expect(body.content).toContain("請求上限・自動停止ではありません");
  expect(body.content).toContain("対象投稿なし");
  expect(body).not.toHaveProperty("embeds");
});
