import assert from "node:assert/strict";
import { test } from "node:test";
const { structuredClone, Response, ReadableStream } = globalThis;
import {
  createModerationDatabase,
  snapshotModerationPlan,
} from "../dist/moderation-db.js";
import { job, url, key, json } from "./processing-fixture.mjs";
import { moderationPlan, held, costRates } from "./moderation-fixture.mjs";
const harness = (response, options = {}) => {
  const calls = [];
  const database = createModerationDatabase({
    enabled: true,
    supabaseUrl: url,
    secretKey: key,
    fetcher: async (endpoint, init) => {
      calls.push({ endpoint, ...init, parsed: JSON.parse(init.body) });
      return typeof response === "function" ? response() : json(response);
    },
    ...options,
  });
  return { database, calls };
};

test("preprocessing failure has separate fixed-code lease protocol, without AI scores or secret exception", async () => {
  const h = harness({ code: "HELD" }),
    p = moderationPlan();
  assert.deepEqual(await h.database.fail(p, "DECODE_FAILED"), { code: "HELD" });
  assert.deepEqual(h.calls[0].parsed.p_input, {
    plan: p,
    reason: "DECODE_FAILED",
  });
  assert.equal(h.calls[0].parsed.p_action, "fail");
  for (const reason of ["secret body", "DB_TIMEOUT", null])
    await assert.rejects(h.database.fail(p, reason), /INVALID_INPUT/);
  assert.equal(h.calls.length, 1);
  await assert.rejects(
    harness({ code: "HELD", message: "secret" }).database.fail(
      p,
      "DECODE_FAILED",
    ),
    /DB_FAILED/,
  );
  assert.deepEqual(await harness({ code: "HELD" }).database.claim(job), {
    code: "HELD",
  });
});
test("moderation DB default OFF and fixed provider config", () => {
  assert.equal(createModerationDatabase({ secretKey: "secret" }), null);
  for (const supabaseUrl of [
    "https://evil.test",
    url + "/anything",
    url + "?q=x",
    "http://abcdefghijklmnopqrst.supabase.co",
  ])
    assert.throws(
      () =>
        createModerationDatabase({
          enabled: true,
          supabaseUrl,
          secretKey: key,
        }),
      /INVALID_DB_CONFIG/,
    );
});
const costEvidence = (card) => ({
  ...held(),
  runs: [
    {
      engine: "safesearch",
      frame: 0,
      attempt: 1,
      decision: "ERROR",
      modelVersion: "vision-v1/builtin-stable/unreported/likelihood-ordinal-v1",
      scores: {},
      latencyMs: 1,
      usage: { openaiRequests: 0, safeSearchImages: 1, ocrImages: 0 },
      estimatedCostUsd: 0.0015,
      costRateCard: card,
      observation: "error",
      errorCode: "TIMEOUT",
    },
  ],
});
test("DB client forwards canonical priced proof and never treats a failed call as an invoice", async () => {
  const p = moderationPlan();
  p.policy.costRates = costRates();
  const evidence = costEvidence(
    Object.fromEntries(Object.entries(costRates()).reverse()),
  );
  const h = harness({ code: "RECORDED" });
  assert.deepEqual(await h.database.finish(p, evidence), { code: "RECORDED" });
  assert.deepEqual(
    h.calls[0].parsed.p_input.result.runs[0].costRateCard,
    p.policy.costRates,
  );
  assert.equal(
    h.calls[0].parsed.p_input.result.runs[0].estimatedCostUsd,
    0.0015,
  );
});
for (const [name, change] of [
  ["amount", (p, r) => (r.runs[0].estimatedCostUsd = 0)],
  ["amount string", (p, r) => (r.runs[0].estimatedCostUsd = "0.0015")],
  ["null fiction", (p, r) => (r.runs[0].estimatedCostUsd = null)],
  ["missing card", (p, r) => delete r.runs[0].costRateCard],
  ["unexpected card", (p) => delete p.policy.costRates],
  ["version", (p, r) => (r.runs[0].costRateCard.version = 2)],
  [
    "rate",
    (p, r) => {
      r.runs[0].costRateCard.microUsdPerUnit.safeSearchImages = 3000;
      r.runs[0].estimatedCostUsd = 0.003;
    },
  ],
  [
    "source",
    (p, r) => (r.runs[0].costRateCard.sources.vision = "https://evil.test"),
  ],
])
  test(`DB client rejects cost ${name} without RPC`, async () => {
    const p = moderationPlan();
    p.policy.costRates = costRates();
    const r = costEvidence(costRates());
    change(p, r);
    const h = harness({ code: "RECORDED" });
    await assert.rejects(h.database.finish(p, r), /INVALID_INPUT/);
    assert.equal(h.calls.length, 0);
  });
test("DB client retains card evidence when a used rate is unknown", async () => {
  const p = moderationPlan();
  p.policy.costRates = costRates();
  p.policy.costRates.microUsdPerUnit.safeSearchImages = null;
  const r = costEvidence(p.policy.costRates);
  r.runs[0].estimatedCostUsd = null;
  assert.deepEqual(await harness({ code: "RECORDED" }).database.finish(p, r), {
    code: "RECORDED",
  });
});
test("claim snapshots exact event/job policy/media; no client controlled URL", async () => {
  const p = moderationPlan();
  const h = harness({ code: "CLAIMED", plan: p });
  const got = await h.database.claim(job);
  assert.equal(got.code, "CLAIMED");
  assert.ok(Object.isFrozen(got.plan.media.imageReceipt.deliveries));
  assert.equal(
    h.calls[0].endpoint,
    url + "/rest/v1/rpc/manage_media_moderation",
  );
  assert.equal(h.calls[0].headers.apikey, key);
  assert.equal(h.calls[0].redirect, "manual");
  assert.equal(h.calls[0].credentials, "omit");
  assert.deepEqual(h.calls[0].parsed, {
    p_event_id: job.eventId,
    p_post_id: job.postId,
    p_job_id: job.jobId,
    p_action: "claim",
    p_input: {},
  });
  p.policy.thresholds[0].flag = 1;
  assert.equal(got.plan.policy.thresholds[0].flag, 0.5);
});
for (const [name, modify] of [
  ["foreign job", (p) => (p.jobId = p.leaseId)],
  ["expired", (p) => (p.expiresAt = Date.now() - 1)],
  ["far expiry", (p) => (p.expiresAt = Date.now() + 1000000)],
  ["unapproved", (p) => (p.policy.approved = false)],
  ["missing category", (p) => p.policy.thresholds.pop()],
  ["missing attempt", (p) => p.attemptStarts.pop()],
  ["repeat attempt", (p) => (p.attemptStarts[0] = p.attemptStarts[1])],
  ["invalid version", (p) => (p.original.objectVersion = "\n")],
  [
    "bad receipt",
    (p) => (p.media.imageReceipt.originalSha256 = "f".repeat(64)),
  ],
  ["raw secret", (p) => (p.original.url = "https://secret.test")],
  [
    "unbound derivative",
    (p) => (p.media.imageReceipt.deliveries[0].eventId = p.leaseId),
  ],
])
  test(`invalid claim ${name} never passes validation`, async () => {
    const p = moderationPlan();
    modify(p);
    const h = harness({ code: "CLAIMED", plan: p });
    await assert.rejects(h.database.claim(job), /DB_FAILED/);
  });
test("strict video evidence and recovery exhausted positions", () => {
  const p = moderationPlan("video");
  p.attemptStarts[0].nextAttempt = 4;
  assert.equal(snapshotModerationPlan(p).media.streamUid, "a".repeat(32));
  for (const modify of [
    (x) => (x.media.processingComplete = false),
    (x) => (x.media.sourceUid = x.media.streamUid),
    (x) => (x.media.frameTimes = [1, 1, 2]),
    (x) => (x.media.streamUid = "https://evil.test"),
  ]) {
    const bad = structuredClone(p);
    modify(bad);
    assert.throws(() => snapshotModerationPlan(bad), /INVALID_INPUT/);
  }
});
test("reserve preserves stable keys and refuses duplicate/unknown quota", async () => {
  const p = moderationPlan();
  const request = { provider: "vision", engine: "ocr", frame: 0, attempt: 2 };
  for (const [response, allowed] of [
    [{ code: "RESERVED", allowed: true }, true],
    [{ code: "RESERVED_ALREADY", allowed: false }, false],
    [{ code: "QUOTA_UNCONFIGURED", allowed: false }, false],
    [{ code: "STALE" }, false],
  ]) {
    const h = harness(response);
    assert.equal((await h.database.reserve(p, request)).allowed, allowed);
    assert.deepEqual(h.calls[0].parsed.p_input, { plan: p, ...request });
  }
  assert.deepEqual(
    await harness({
      code: "QUOTA",
      allowed: false,
      retryAfterSeconds: 12,
    }).database.reserve(p, request),
    { allowed: false, retryAfterSeconds: 12 },
  );
  await assert.rejects(
    harness({ code: "RESERVED_ALREADY", allowed: true }).database.reserve(
      p,
      request,
    ),
    /DB_FAILED/,
  );
});
test("finish accepts normalized evidence only and never arbitrary media/raw fields", async () => {
  const p = moderationPlan();
  const h = harness({ code: "RECORDED" });
  assert.equal((await h.database.finish(p, held())).code, "RECORDED");
  for (const modify of [
    (x) => (x.rawText = "private"),
    (x) => (x.policyVersion = 2),
    (x) =>
      x.categories.push({
        engine: "ocr",
        category: "unknown",
        decision: "BLOCK",
      }),
    (x) => x.engines.push(x.engines[0]),
  ]) {
    const e = held();
    modify(e);
    await assert.rejects(h.database.finish(p, e), /INVALID_INPUT/);
  }
  assert.equal(h.calls.length, 1);
});
for (const [name, response] of [
  [
    "redirect",
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.test" },
      }),
  ],
  [
    "malformed",
    () =>
      new Response("private secret", {
        headers: { "content-type": "application/json" },
      }),
  ],
  [
    "oversize",
    () =>
      new Response("x".repeat(65537), {
        headers: { "content-type": "application/json" },
      }),
  ],
  [
    "encoding",
    () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
      }),
  ],
  [
    "length",
    () =>
      new Response("{}", {
        headers: { "content-type": "application/json", "content-length": "3" },
      }),
  ],
  ["unknown code", () => json({ code: "secret exception" })],
])
  test(`DB response ${name} is bounded and sanitized`, async () => {
    await assert.rejects(
      harness(response).database.claim(job),
      (e) => e.message === "DB_FAILED",
    );
  });
test("DB stalled fetch and stalled body have explicit timeouts", async () => {
  for (const fetcher of [
    () => new Promise(() => {}),
    async () =>
      new Response(new ReadableStream(), {
        headers: { "content-type": "application/json" },
      }),
  ])
    await assert.rejects(
      harness(null, { fetcher, timeoutMs: 10 }).database.claim(job),
      /DB_TIMEOUT/,
    );
});
