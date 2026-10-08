import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createImageDatabase, ImageDatabaseError } from "../dist/db.js";
import {
  job,
  plan,
  receipt,
  json,
  url,
  key,
  uuid,
} from "./processing-fixture.mjs";
const { Response, ReadableStream, TextEncoder, structuredClone } = globalThis;
function client(fetcher, extra = {}) {
  return createImageDatabase({
    enabled: true,
    supabaseUrl: url,
    secretKey: key,
    fetcher,
    ...extra,
  });
}
const error = (code) => (e) =>
  e instanceof ImageDatabaseError &&
  e.message === code &&
  e.code === code &&
  !e.cause;

test("processing failure uses only a fixed code and exact lease; never treats ambiguous DB outcome as held", async () => {
  const p = plan();
  const calls = [];
  const db = client(async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return json({ code: "HELD" });
  });
  assert.deepEqual(await db.fail(p, "DECODE_FAILED"), { code: "HELD" });
  assert.deepEqual(calls[0].p_input, { plan: p, reason: "DECODE_FAILED" });
  assert.equal(calls[0].p_action, "fail");
  for (const reason of ["raw secret", "DB_FAILED", "RETRY_EXHAUSTED", null])
    await assert.rejects(db.fail(p, reason), error("INVALID_INPUT"));
  assert.equal(calls.length, 1);
  for (const response of [
    { code: "RECORDED" },
    { code: "HELD", raw: "secret" },
  ])
    await assert.rejects(
      client(async () => json(response)).fail(p, "DECODE_FAILED"),
      error("DB_FAILED"),
    );
  await assert.rejects(
    client(async () => {
      throw new Error("secret");
    }).fail(p, "DECODE_FAILED"),
    error("DB_FAILED"),
  );
});

test("disabled by default; construction makes no request", () => {
  assert.equal(createImageDatabase(), null);
  for (const enabled of [false, "true", 1, undefined])
    assert.equal(createImageDatabase({ enabled }), null);
  client(() => {
    throw new Error("must not run");
  });
});
for (const [name, override] of [
  ["missing URL", { supabaseUrl: undefined }],
  ["http", { supabaseUrl: url.replace("https:", "http:") }],
  ["localhost", { supabaseUrl: "https://localhost" }],
  ["userinfo", { supabaseUrl: url.replace("https://", "https://user:pass@") }],
  ["port", { supabaseUrl: url + ":443" }],
  ["path", { supabaseUrl: url + "/rest/v1" }],
  ["query", { supabaseUrl: url + "?key=x" }],
  ["hash", { supabaseUrl: url + "#x" }],
  ["suffix", { supabaseUrl: url + ".evil.invalid" }],
  ["missing key", { secretKey: undefined }],
  ["publishable", { secretKey: "sb_publishable_fixture" }],
  ["JWT", { secretKey: "eyJfixture" }],
  ["newline", { secretKey: key + "\r\nX-Evil: 1" }],
  ["key too long", { secretKey: "sb_secret_" + "x".repeat(257) }],
  ["timeout 0", { timeoutMs: 0 }],
  ["timeout large", { timeoutMs: 5001 }],
  ["timeout fractional", { timeoutMs: 1.5 }],
  ["bad fetch", { fetcher: null }],
])
  test(`invalid config: ${name}`, () =>
    assert.throws(
      () => client(() => {}, override),
      error("INVALID_DB_CONFIG"),
    ));

test("claim uses one fixed POST, apikey only; snapshots config/ref and validates returned scope", async () => {
  const p = plan(),
    ref = { ...job },
    opts = { enabled: true, supabaseUrl: url + "/", secretKey: key };
  let calls = 0;
  opts.fetcher = async (target, init) => {
    calls++;
    assert.equal(target, url + "/rest/v1/rpc/manage_image_processing");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.equal(init.cache, "no-store");
    assert.deepEqual(init.headers, {
      apikey: key,
      "content-type": "application/json",
      accept: "application/json",
    });
    assert.ok(init.signal);
    assert.deepEqual(JSON.parse(init.body), {
      p_event_id: job.eventId,
      p_post_id: job.postId,
      p_job_id: job.jobId,
      p_action: "claim",
      p_input: {},
    });
    await delay(1);
    return json({ code: "CLAIMED", plan: p });
  };
  const db = createImageDatabase(opts);
  opts.secretKey = "changed";
  opts.supabaseUrl = "https://evil.invalid";
  const pending = db.claim(ref);
  ref.eventId = uuid(30);
  const r = await pending;
  assert.equal(r.code, "CLAIMED");
  assert.equal(r.plan.original.eventId, job.eventId);
  assert.ok(Object.isFrozen(r.plan) && Object.isFrozen(r.plan.deliveries[0]));
  assert.equal(calls, 1);
});
for (const code of [
  "BUSY",
  "EXHAUSTED",
  "STALE",
  "RESOURCE_LIMIT",
  "INVALID_INPUT",
  "IMAGE_SAVED",
])
  test(`claim preserves phase-only code ${code}`, async () =>
    assert.deepEqual(await client(() => json({ code })).claim(job), { code }));
for (const [name, change] of [
  ["foreign event", (p) => (p.original.eventId = uuid(50))],
  ["foreign post", (p) => (p.original.postId = uuid(50))],
  ["foreign job", (p) => (p.jobId = uuid(50))],
  ["expired", (p) => (p.expiresAt = 1)],
  ["unbounded TTL", (p) => (p.expiresAt += 100000)],
  ["version overflow", (p) => (p.postVersion = 2147483648)],
  ["extra plan", (p) => (p.url = url)],
  ["extra source", (p) => (p.original.url = url)],
  ["duplicate delivery", (p) => (p.deliveries[3] = { ...p.deliveries[0] })],
  ["incomplete outputs", (p) => p.deliveries.pop()],
  ["original budget", (p) => (p.original.size = 67108865)],
  ["invalid identity", (p) => (p.original.etag = "bad")],
])
  test(`rejects bad claim plan: ${name}`, async () => {
    const p = plan();
    change(p);
    await assert.rejects(
      client(() => json({ code: "CLAIMED", plan: p })).claim(job),
      error("DB_FAILED"),
    );
  });
for (const body of [
  null,
  [],
  {},
  true,
  { code: "CURRENT" },
  { code: "CLAIMED" },
  { code: "BUSY", secret: "synthetic" },
])
  test(`rejects invalid envelope ${JSON.stringify(body)}`, async () =>
    assert.rejects(client(() => json(body)).claim(job), error("DB_FAILED")));

test("check accepts only CURRENT and resends exact snapshot; expired does not fetch", async () => {
  const p = plan();
  let n = 0;
  const db = client((_u, init) => {
    n++;
    assert.deepEqual(JSON.parse(init.body).p_input, { plan: p });
    return json({ code: "CURRENT" });
  });
  assert.equal(await db.check(p), true);
  assert.equal(await db.check({ ...p, expiresAt: 1 }), false);
  assert.equal(n, 1);
});
for (const code of ["STALE", "RESOURCE_LIMIT", "INVALID_INPUT"])
  test(`check ${code} is false`, async () =>
    assert.equal(await client(() => json({ code })).check(plan()), false));
test("check cannot turn late CURRENT into success", async () => {
  const p = plan();
  p.expiresAt = Date.now() + 20;
  assert.equal(
    await client(async () => {
      await delay(40);
      return json({ code: "CURRENT" });
    }).check(p),
    false,
  );
});
test("check rejects another action response", async () =>
  assert.rejects(
    client(() => json({ code: "RECORDED" })).check(plan()),
    error("DB_FAILED"),
  ));
for (const code of [
  "RECORDED",
  "STALE",
  "CONFLICT",
  "INVALID_INPUT",
  "RESOURCE_LIMIT",
])
  test(`finish ${code}: exact metadata only; expired replay is delegated to DB`, async () => {
    const p = plan();
    p.expiresAt = 1;
    const proof = receipt(p);
    const db = client((_u, init) => {
      const b = JSON.parse(init.body);
      assert.equal(b.p_action, "finish");
      assert.deepEqual(b.p_input, { plan: p, ...proof });
      assert.ok(!init.body.includes("bytes") && !init.body.includes("ai-1024"));
      return json({ code });
    });
    assert.deepEqual(await db.finish(p, proof), { code });
  });
for (const [name, change] of [
  ["extra bytes", (r) => (r.bytes = [1])],
  ["AI image", (r) => (r.ai = { bytes: [1] })],
  ["bad original hash", (r) => (r.originalSha256 = "bad")],
  ["different original hash", (r) => (r.originalSha256 = "c".repeat(64))],
  ["missing entry", (r) => r.deliveries.pop()],
  ["duplicate", (r) => (r.deliveries[3] = { ...r.deliveries[0] })],
  ["foreign asset", (r) => (r.deliveries[0].assetId = uuid(60))],
  ["foreign event", (r) => (r.deliveries[0].eventId = uuid(60))],
  ["extra URL", (r) => (r.deliveries[0].url = url)],
  ["wrong outcome", (r) => (r.deliveries[0].outcome = "published")],
  ["bad hash", (r) => (r.deliveries[0].sha256 = "bad")],
  ["zero size", (r) => (r.deliveries[0].size = 0)],
  ["fractional size", (r) => (r.deliveries[0].size = 0.5)],
  ["large size", (r) => (r.deliveries[0].size = 16777217)],
  ["huge dimensions", (r) => (r.deliveries[0].width = 601)],
  ["fractional dimensions", (r) => (r.deliveries[0].height = 1.5)],
  ["null entry", (r) => (r.deliveries[0] = null)],
])
  test(`bad receipt never sent: ${name}`, async () => {
    const p = plan(),
      r = receipt(p);
    change(r);
    let n = 0;
    await assert.rejects(
      client(() => {
        n++;
        return json({ code: "RECORDED" });
      }).finish(p, r),
      error("INVALID_INPUT"),
    );
    assert.equal(n, 0);
  });
test("invalid jobs and plans never reach transport", async () => {
  let n = 0;
  const db = client(() => {
    n++;
  });
  for (const j of [null, {}, { ...job, eventId: "bad" }, { ...job, url }])
    await assert.rejects(db.claim(j), error("INVALID_INPUT"));
  await assert.rejects(db.check({}), error("INVALID_INPUT"));
  assert.equal(n, 0);
});
test("receipt is a snapshot across await", async () => {
  const p = plan(),
    r = receipt(p),
    before = structuredClone(r);
  let sent;
  const db = client(async (_u, init) => {
    sent = JSON.parse(init.body).p_input;
    await delay(1);
    return json({ code: "RECORDED" });
  });
  const pending = db.finish(p, r);
  r.deliveries[0].size = 999;
  await pending;
  assert.deepEqual(sent, { plan: p, ...before });
});

for (const status of [
  201, 204, 301, 302, 307, 308, 400, 401, 403, 404, 409, 429, 500, 503,
])
  test(`HTTP ${status} fails without retry`, async () => {
    let n = 0;
    const db = client(() => {
      n++;
      return new Response(status === 204 ? null : "synthetic provider error", {
        status,
        headers: { location: "https://evil.invalid" },
      });
    });
    await assert.rejects(db.claim(job), error("DB_FAILED"));
    assert.equal(n, 1);
  });
for (const [name, response] of [
  ["wrong type", () => new Response('{"code":"BUSY"}')],
  [
    "no body",
    () =>
      new Response(null, { headers: { "content-type": "application/json" } }),
  ],
  [
    "invalid JSON",
    () =>
      new Response("broken", {
        headers: { "content-type": "application/json" },
      }),
  ],
  [
    "invalid UTF8",
    () =>
      new Response(new Uint8Array([255]), {
        headers: { "content-type": "application/json" },
      }),
  ],
  [
    "huge declared size",
    () =>
      json(
        { code: "BUSY" },
        {
          headers: {
            "content-type": "application/json",
            "content-length": "16385",
          },
        },
      ),
  ],
  [
    "bad declared size",
    () =>
      json(
        { code: "BUSY" },
        {
          headers: {
            "content-type": "application/json",
            "content-length": "no",
          },
        },
      ),
  ],
  [
    "wrong declared size",
    () =>
      json(
        { code: "BUSY" },
        {
          headers: {
            "content-type": "application/json",
            "content-length": "1",
          },
        },
      ),
  ],
  [
    "oversized chunked body",
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("x".repeat(16385)));
            c.close();
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  ],
  [
    "redirected response",
    () => {
      const r = json({ code: "BUSY" });
      Object.defineProperty(r, "redirected", { value: true });
      return r;
    },
  ],
  [
    "wrong response URL",
    () => {
      const r = json({ code: "BUSY" });
      Object.defineProperty(r, "url", { value: "https://evil.invalid" });
      return r;
    },
  ],
])
  test(`transport fails closed: ${name}`, async () =>
    assert.rejects(client(response).claim(job), error("DB_FAILED")));
test("hung fetch is bounded and aborted even if transport ignores signal", async () => {
  let signal;
  const db = client(
    (_u, i) => {
      signal = i.signal;
      return new Promise(() => {});
    },
    { timeoutMs: 20 },
  );
  await assert.rejects(db.claim(job), error("DB_TIMEOUT"));
  assert.equal(signal.aborted, true);
});
test("hung body is bounded and cancelled", async () => {
  let cancelled = false;
  const db = client(
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    { timeoutMs: 20 },
  );
  await assert.rejects(db.claim(job), error("DB_TIMEOUT"));
  assert.equal(cancelled, true);
});
test("late fetch body is cancelled after timeout, never reused", async () => {
  let resolve,
    cancelled = false;
  const db = client(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
    { timeoutMs: 20 },
  );
  await assert.rejects(db.claim(job), error("DB_TIMEOUT"));
  resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await delay(1);
  assert.equal(cancelled, true);
});
test("provider exception never leaks secrets or cause", async () => {
  await assert.rejects(
    client(() => {
      throw new Error(key);
    }).claim(job),
    error("DB_FAILED"),
  );
});
