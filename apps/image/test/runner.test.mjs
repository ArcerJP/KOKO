import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createImageRunner } from "../dist/runner.js";
import { createImageDatabase } from "../dist/db.js";
import { createImageR2Store, ImageStorageError } from "../dist/r2.js";
import {
  job,
  plan,
  json,
  url,
  key,
  input,
  hash,
  outputs,
} from "./processing-fixture.mjs";
const { Response } = globalThis;
function harness(options = {}) {
  const calls = [],
    p = plan();
  let checks = 0,
    finishBody;
  const database = createImageDatabase({
    enabled: true,
    supabaseUrl: url,
    secretKey: key,
    timeoutMs: options.timeoutMs ?? 5000,
    fetcher: async (_url, init) => {
      const b = JSON.parse(init.body);
      calls.push(b.p_action);
      assert.equal(b.p_event_id, job.eventId);
      assert.equal(b.p_post_id, job.postId);
      assert.equal(b.p_job_id, job.jobId);
      if (b.p_action === "claim")
        return options.claim
          ? options.claim(b, init)
          : json({ code: "CLAIMED", plan: p });
      if (b.p_action === "check") {
        checks++;
        assert.deepEqual(b.p_input, { plan: p });
        return options.check
          ? options.check(checks, b, init)
          : json({ code: "CURRENT" });
      }
      finishBody = b.p_input;
      return options.finish
        ? options.finish(b, init)
        : json({ code: "RECORDED" });
    },
  });
  const store = {
    async getOriginal() {
      calls.push("GET");
      if (options.get) return options.get();
      return { bytes: Buffer.from(input), sha256: hash(input) };
    },
    async putDelivery(ref, value) {
      calls.push("PUT");
      if (options.put) return options.put(ref, value);
      return {
        outcome: "stored",
        sha256: value.sha256,
        size: value.bytes.length,
      };
    },
  };
  const transform = async () => {
    calls.push("TRANSFORM");
    if (options.transform) return options.transform();
    return { ok: true, derivatives: outputs() };
  };
  return {
    runner: createImageRunner({ enabled: true, database, store, transform }),
    database,
    store,
    transform,
    calls,
    p,
    proof: () => finishBody,
  };
}
test("runner disabled by default and rejects incomplete internal dependencies", () => {
  assert.equal(createImageRunner(), null);
  assert.equal(createImageRunner({ enabled: "true" }), null);
  assert.throws(
    () => createImageRunner({ enabled: true }),
    /INVALID_RUNNER_CONFIG/,
  );
  assert.throws(
    () => createImageRunner({ enabled: true, database: {} }),
    /INVALID_RUNNER_CONFIG/,
  );
  assert.throws(
    () => createImageRunner({ enabled: true, database: harness().database }),
    /INVALID_PIPELINE_CONFIG/,
  );
});
test("claim → seven DB guards → image storage → exact metadata finish; AI returned only after commit", async () => {
  const h = harness(),
    result = await h.runner.run(job);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "image_recorded");
  assert.equal(result.ai.name, "ai-1024.jpg");
  assert.deepEqual(h.calls, [
    "claim",
    "check",
    "GET",
    "check",
    "TRANSFORM",
    "check",
    "PUT",
    "check",
    "PUT",
    "check",
    "PUT",
    "check",
    "PUT",
    "check",
    "finish",
  ]);
  assert.deepEqual(Object.keys(h.proof()).sort(), [
    "deliveries",
    "originalSha256",
    "plan",
  ]);
  assert.equal(h.proof().deliveries.length, 4);
  assert.ok(!JSON.stringify(h.proof()).includes("bytes"));
  assert.ok(!JSON.stringify(result).includes(key));
});
for (const code of [
  "BUSY",
  "EXHAUSTED",
  "STALE",
  "RESOURCE_LIMIT",
  "INVALID_INPUT",
])
  test(`claim ${code} never transforms or writes`, async () => {
    const h = harness({ claim: () => json({ code }) });
    assert.deepEqual(await h.runner.run(job), { ok: false, reason: code });
    assert.deepEqual(h.calls, ["claim"]);
  });
test("already-recorded is phase-specific, has no AI bytes, and performs no storage", async () => {
  const h = harness({ claim: () => json({ code: "IMAGE_SAVED" }) });
  assert.deepEqual(await h.runner.run(job), {
    ok: true,
    outcome: "image_already_recorded",
  });
  assert.deepEqual(h.calls, ["claim"]);
});
for (let n = 1; n <= 7; n++)
  test(`DB stop at guard ${n} prevents finish and later storage`, async () => {
    const h = harness({
      check: (i) => json({ code: i === n ? "STALE" : "CURRENT" }),
    });
    assert.deepEqual(await h.runner.run(job), { ok: false, reason: "STALE" });
    assert.equal(h.calls.filter((x) => x === "PUT").length, Math.max(0, n - 3));
    assert.equal(h.proof(), undefined);
  });
for (const stage of ["get", "put", "transform"])
  test(`failure at ${stage} never commits partial image`, async () => {
    const h = harness({
      [stage]: () => {
        throw new Error("SYNTHETIC_SECRET");
      },
    });
    assert.deepEqual(await h.runner.run(job), {
      ok: false,
      reason: "PIPELINE_FAILED",
    });
    assert.ok(!h.calls.includes("finish"));
  });
test("storage failure after earlier writes is held without rollback delete or finish", async () => {
  let n = 0;
  const h = harness({
    put: (_r, v) => {
      if (++n === 3) throw new ImageStorageError("STORAGE_FAILED");
      return { outcome: "stored", size: v.bytes.length, sha256: v.sha256 };
    },
  });
  assert.deepEqual(await h.runner.run(job), {
    ok: false,
    reason: "STORAGE_FAILED",
  });
  assert.equal(n, 3);
  assert.ok(!h.calls.includes("finish"));
});
for (const code of ["STALE", "CONFLICT", "INVALID_INPUT", "RESOURCE_LIMIT"])
  test(`finish ${code} returns no AI/image success and does not retry`, async () => {
    const h = harness({ finish: () => json({ code }) });
    assert.deepEqual(await h.runner.run(job), { ok: false, reason: code });
    assert.equal(h.calls.filter((c) => c === "finish").length, 1);
  });
test("failed claim transport is ambiguous and never retries or starts image IO", async () => {
  const h = harness({
    claim: () => {
      throw new Error(key);
    },
  });
  assert.deepEqual(await h.runner.run(job), { ok: false, reason: "DB_FAILED" });
  assert.deepEqual(h.calls, ["claim"]);
});
test("failed check transport stops before original read", async () => {
  const h = harness({
    check: () => json({ code: "CURRENT" }, { status: 503 }),
  });
  assert.deepEqual(await h.runner.run(job), {
    ok: false,
    reason: "CHECK_FAILED",
  });
  assert.deepEqual(h.calls, ["claim", "check"]);
});
test("finish may have committed despite lost reply; next explicit run reports only image recorded", async () => {
  let committed = false;
  const h = harness({
    claim: () =>
      json(
        committed ? { code: "IMAGE_SAVED" } : { code: "CLAIMED", plan: h.p },
      ),
    finish: () => {
      committed = true;
      throw new Error(key);
    },
  });
  assert.deepEqual(await h.runner.run(job), { ok: false, reason: "DB_FAILED" });
  const first = h.calls.length;
  assert.deepEqual(await h.runner.run(job), {
    ok: true,
    outcome: "image_already_recorded",
  });
  assert.deepEqual(h.calls.slice(first), ["claim"]);
});
test("timeout claim stops even when DB resolves late", async () => {
  let resolve;
  const h = harness({
    timeoutMs: 20,
    claim: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  assert.deepEqual(await h.runner.run(job), {
    ok: false,
    reason: "DB_TIMEOUT",
  });
  resolve(json({ code: "CLAIMED", plan: h.p }));
  await delay(1);
  assert.deepEqual(h.calls, ["claim"]);
});
test("timeout finish cannot return image success later", async () => {
  let resolve;
  const h = harness({
    timeoutMs: 20,
    finish: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  assert.deepEqual(await h.runner.run(job), {
    ok: false,
    reason: "DB_TIMEOUT",
  });
  resolve(json({ code: "RECORDED" }));
  await delay(1);
  assert.equal(h.calls.filter((x) => x === "finish").length, 1);
});
test("one active run; starts again only after prior run settles", async () => {
  let release, entered;
  const ready = new Promise((r) => {
    entered = r;
  });
  let blocked = true;
  const h = harness({
    claim: async () => {
      if (blocked) {
        entered();
        await new Promise((r) => {
          release = r;
        });
      }
      return json({ code: "CLAIMED", plan: h.p });
    },
  });
  const pending = h.runner.run({ ...job });
  await ready;
  assert.deepEqual(await h.runner.run(job), { ok: false, reason: "BUSY" });
  release();
  assert.equal((await pending).ok, true);
  blocked = false;
  assert.equal((await h.runner.run(job)).ok, true);
});
test("unexpected trusted dependency exception is sanitized", async () => {
  const h = harness();
  const runner = createImageRunner({
    enabled: true,
    database: {
      ...h.database,
      claim() {
        throw new Error(key);
      },
    },
    store: h.store,
    transform: h.transform,
  });
  assert.deepEqual(await runner.run(job), {
    ok: false,
    reason: "RUNNER_FAILED",
  });
  assert.deepEqual(h.calls, []);
});
test("real synthetic HEIC → signed mock R2 → exact RPC finish → replay without extra image IO", async () => {
  const bytes = await readFile(
    new URL("fixtures/blocks.heic", import.meta.url),
  );
  const p = plan(bytes),
    objects = new Map(),
    calls = [];
  let completed = false,
    proof;
  const db = createImageDatabase({
    enabled: true,
    supabaseUrl: url,
    secretKey: key,
    fetcher: async (target, init) => {
      assert.equal(target, url + "/rest/v1/rpc/manage_image_processing");
      const b = JSON.parse(init.body);
      calls.push(b.p_action);
      if (b.p_action === "claim")
        return json(
          completed ? { code: "IMAGE_SAVED" } : { code: "CLAIMED", plan: p },
        );
      assert.deepEqual(b.p_input.plan, p);
      if (b.p_action === "check") return json({ code: "CURRENT" });
      proof = b.p_input;
      assert.equal(proof.originalSha256, hash(bytes));
      assert.equal(proof.deliveries.length, 4);
      for (const d of proof.deliveries) {
        const v = objects.get(
          `/koko-dev-derived/events/${d.eventId}/delivery/${d.assetId}/${d.variant}.${d.format}`,
        );
        assert.ok(v);
        assert.equal(hash(v), d.sha256);
        assert.equal(v.length, d.size);
        assert.ok(
          d.width <= Number(d.variant) && d.height <= Number(d.variant),
        );
      }
      completed = true;
      return json({ code: "RECORDED" });
    },
  });
  const store = createImageR2Store(
    {
      KOKO_IMAGE_R2_ENABLED: "true",
      R2_ACCOUNT_ID: "a".repeat(32),
      R2_ORIGINAL_READ_ACCESS_KEY_ID: "b".repeat(32),
      R2_ORIGINAL_READ_SECRET_ACCESS_KEY: "c".repeat(64),
      R2_DERIVED_ACCESS_KEY_ID: "d".repeat(32),
      R2_DERIVED_SECRET_ACCESS_KEY: "e".repeat(64),
    },
    async (request) => {
      assert.match(request.headers.get("authorization"), /^AWS4-HMAC-SHA256 /);
      const path = new URL(request.url).pathname;
      if (request.method === "GET") {
        calls.push("R2_GET");
        assert.equal(
          path,
          `/koko-dev-originals/events/${job.eventId}/posts/${job.postId}/original/${p.original.assetId}.bin`,
        );
        return new Response(bytes, {
          headers: {
            etag: `"${hash(bytes, "md5")}"`,
            "content-length": String(bytes.length),
          },
        });
      }
      calls.push("R2_PUT");
      assert.equal(request.method, "PUT");
      assert.equal(request.headers.get("if-none-match"), "*");
      assert.ok(!objects.has(path));
      const body = Buffer.from(await request.arrayBuffer());
      objects.set(path, body);
      return new Response(null, {
        headers: { etag: `"${hash(body, "md5")}"` },
      });
    },
  );
  const runner = createImageRunner({ enabled: true, database: db, store });
  const before = hash(bytes),
    result = await runner.run(job);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "image_recorded");
  assert.equal(objects.size, 4);
  assert.ok(result.ai.bytes.length > 0);
  assert.equal(hash(bytes), before);
  assert.equal(calls.filter((x) => x === "check").length, 7);
  assert.equal(calls.at(-1), "finish");
  assert.ok(!JSON.stringify(proof).includes("bytes"));
  const n = calls.length;
  assert.deepEqual(await runner.run(job), {
    ok: true,
    outcome: "image_already_recorded",
  });
  assert.deepEqual(calls.slice(n), ["claim"]);
});
