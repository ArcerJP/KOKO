import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createImageService } from "../dist/service.js";
const { Request, ReadableStream, AbortController, fetch } = globalThis;
import {
  configuredImageService,
  createImageHttpServer,
} from "../dist/server.js";
import { createImageRunner } from "../dist/runner.js";
import { createImageDatabase } from "../dist/db.js";
import {
  job,
  plan,
  url,
  key,
  json,
  outputs,
  input,
  hash,
} from "./processing-fixture.mjs";
const request = (body = job, headers = {}, init = {}) =>
  new Request("http://test/internal/image", {
    method: "POST",
    headers: {
      authorization: "Bearer fixture",
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
function harness(options = {}) {
  const calls = [];
  const handle = createImageService({
    enabled: true,
    authenticate: async (auth) => {
      calls.push("auth");
      return auth === "Bearer fixture";
    },
    run: async (j) => {
      calls.push(j);
      return {
        ok: true,
        outcome: "image_recorded",
        ai: { bytes: "private-image" },
      };
    },
    ...options,
  });
  return { handle, calls };
}
test("disabled by default even with malformed secret-like config; health is not acceptance", async () => {
  const handle = configuredImageService({ SUPABASE_SECRET_KEY: "secret" });
  assert.equal((await handle(request())).status, 404);
  assert.deepEqual(
    await (await handle(new Request("http://test/health"))).json(),
    { service: "koko-image", status: "disabled" },
  );
  assert.throws(
    () => configuredImageService({ KOKO_IMAGE_SERVICE_ENABLED: "true" }),
    /INVALID_SERVICE_AUTH_CONFIG/,
  );
  assert.throws(
    () => createImageService({ enabled: true }),
    /INVALID_SERVICE_CONFIG/,
  );
});
test("authenticate before body and DB; minimal reply never includes image bytes", async () => {
  const h = harness();
  const r = await h.handle(request());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(await r.json(), {
    stage: "image",
    outcome: "image_recorded",
    processComplete: false,
  });
  assert.deepEqual(h.calls, ["auth", job]);
});
for (const headers of [
  { authorization: "" },
  { cookie: "session=secret" },
  { origin: "https://test" },
  { "x-serverless-authorization": "Bearer fixture" },
])
  test(`reject browser or untrusted identity ${Object.keys(headers)[0]}`, async () => {
    const h = harness();
    assert.equal((await h.handle(request(job, headers))).status, 401);
    assert.equal(
      h.calls.some((c) => typeof c === "object"),
      false,
    );
  });
test("forged forwarded identity headers are not authentication", async () => {
  const h = harness();
  assert.equal(
    (
      await h.handle(
        request(job, {
          authorization: "",
          "x-goog-authenticated-user-email":
            "accounts.google.com:admin@example.com",
        }),
      )
    ).status,
    401,
  );
});
for (const value of [
  null,
  [],
  {},
  { ...job, url: "https://evil.example" },
  { ...job, eventId: "bad" },
  { ...job, postId: "bad" },
  { ...job, jobId: "bad" },
  "bad-json",
  " ".repeat(1025),
])
  test(`invalid body ${JSON.stringify(value).slice(0, 45)}`, async () => {
    const h = harness();
    assert.equal((await h.handle(request(value))).status, 400);
    assert.deepEqual(h.calls, ["auth"]);
  });
for (const headers of [
  { "content-type": "text/plain" },
  { "content-encoding": "gzip" },
  { "content-length": "9999" },
  { "content-length": "999" },
])
  test(`invalid body framing ${JSON.stringify(headers)}`, async () => {
    const h = harness();
    assert.equal((await h.handle(request(job, headers))).status, 400);
    assert.deepEqual(h.calls, ["auth"]);
  });
test("strict UTF8 and bounded stalled stream", async () => {
  const h = harness({ bodyTimeoutMs: 10 });
  assert.equal(
    (await h.handle(request(job, {}, { body: Uint8Array.of(255) }))).status,
    400,
  );
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  assert.equal(
    (await h.handle(request(job, {}, { body, duplex: "half" }))).status,
    400,
  );
  assert.equal(cancelled, true);
});
test("one request in flight and release slot after failure", async () => {
  let release;
  const h = harness({
    authenticate: () =>
      new Promise((r) => {
        release = r;
      }),
  });
  const first = h.handle(request());
  assert.equal((await h.handle(request())).status, 429);
  release(false);
  assert.equal((await first).status, 401);
  const next = h.handle(request());
  release(true);
  assert.equal((await next).status, 200);
});
for (const [reason, status] of Object.entries({
  BUSY: 503,
  DB_TIMEOUT: 503,
  TIMEOUT: 503,
  DB_FAILED: 503,
  STORAGE_FAILED: 503,
  STALE: 409,
  INVALID_INPUT: 400,
  RUNNER_FAILED: 503,
  "secret exception": 503,
}))
  test(`map fixed failure ${reason}`, async () => {
    const h = harness({ run: async () => ({ ok: false, reason }) });
    const r = await h.handle(request());
    assert.equal(r.status, status);
    assert.ok(!(await r.text()).includes("secret"));
  });
test("runner exceptions and invalid result cannot escape", async () => {
  for (const run of [
    async () => {
      throw new Error("secret exception");
    },
    async () => null,
    async () => ({ ok: true, outcome: "secret" }),
  ]) {
    const r = await harness({ run }).handle(request());
    assert.equal(r.status, 503);
    assert.ok(!(await r.text()).includes("secret"));
  }
});
test("authenticate false-like and exceptions do not run", async () => {
  for (const authenticate of [
    async () => "true",
    async () => {
      throw new Error("secret");
    },
  ]) {
    const h = harness({ authenticate });
    const r = await h.handle(request());
    assert.notEqual(r.status, 200);
    assert.equal(h.calls.length, 0);
  }
});
test("routing, method, query and aborted request rejection", async () => {
  const h = harness();
  assert.equal(
    (await h.handle(new Request("http://test/internal/image"))).status,
    405,
  );
  assert.equal(
    (await h.handle(new Request("http://test/internal/image?url=secret")))
      .status,
    404,
  );
  assert.equal((await h.handle(new Request("http://test/other"))).status, 404);
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (await h.handle(request(job, {}, { signal: controller.signal }))).status,
    401,
  );
});
test("HTTP boundary → existing runner → DB check/finish; retry is image-stage only", async () => {
  let saved = false;
  const p = plan();
  const database = createImageDatabase({
    enabled: true,
    supabaseUrl: url,
    secretKey: key,
    fetcher: async (_url, init) => {
      const b = JSON.parse(init.body);
      if (b.p_action === "claim")
        return saved
          ? json({ code: "IMAGE_SAVED" })
          : json({ code: "CLAIMED", plan: p });
      if (b.p_action === "check") return json({ code: "CURRENT" });
      saved = true;
      return json({ code: "RECORDED" });
    },
  });
  const runner = createImageRunner({
    enabled: true,
    database,
    transform: async () => ({ ok: true, derivatives: outputs() }),
    store: {
      getOriginal: async () => ({ bytes: input, sha256: hash(input) }),
      putDelivery: async (_ref, d) => ({
        outcome: "stored",
        sha256: d.sha256,
        size: d.bytes.length,
      }),
    },
  });
  const h = harness({ run: runner.run });
  assert.equal(
    (await (await h.handle(request())).json()).outcome,
    "image_recorded",
  );
  assert.deepEqual(await (await h.handle(request())).json(), {
    stage: "image",
    outcome: "image_already_recorded",
    processComplete: false,
  });
});
test("real Node loopback transport and duplicate Authorization rejection", async () => {
  const h = harness();
  const server = createImageHttpServer(h.handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(endpoint + "/internal/image", {
      method: "POST",
      headers: {
        authorization: "Bearer fixture",
        "content-type": "application/json",
      },
      body: JSON.stringify(job),
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("connection"), "close");
    assert.equal((await r.json()).processComplete, false);
    const duplicate = await new Promise((resolve, reject) => {
      const req = httpRequest(
        endpoint + "/internal/image",
        {
          method: "POST",
          headers: [
            "Authorization",
            "Bearer fixture",
            "Authorization",
            "Bearer other",
            "Content-Type",
            "application/json",
          ],
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(job));
    });
    assert.equal(duplicate, 400);
    const oversized = await fetch(endpoint + "/internal/image", {
      method: "POST",
      headers: {
        authorization: "Bearer fixture",
        "content-type": "application/json",
      },
      body: " ".repeat(1025),
    });
    assert.equal(oversized.status, 400);
    assert.equal(oversized.headers.get("connection"), "close");
    assert.equal(h.calls.filter((c) => typeof c === "object").length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
