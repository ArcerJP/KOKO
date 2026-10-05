import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { URL } from "node:url";
import { createImagePipeline } from "../dist/pipeline.js";
import {
  createImageR2Store,
  ImageStorageError,
  maxOriginalReadBytes,
} from "../dist/r2.js";

const { Response, structuredClone } = globalThis;
const hash = (b, algorithm = "sha256") =>
  createHash(algorithm).update(b).digest("hex");
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const input = Buffer.from("SYNTHETIC_INPUT");
const kinds = [
  ["600", "webp"],
  ["600", "jpg"],
  ["1600", "webp"],
  ["1600", "jpg"],
];
function plan(bytes = input) {
  return {
    jobId: uuid(20),
    leaseId: uuid(21),
    postVersion: 1,
    expiresAt: Date.now() + 120_000,
    original: {
      eventId: uuid(1),
      postId: uuid(2),
      assetId: uuid(3),
      size: bytes.length,
      etag: hash(bytes, "md5"),
      sha256: hash(bytes),
    },
    deliveries: kinds.map(([variant, format], i) => ({
      eventId: uuid(1),
      assetId: uuid(i + 4),
      variant,
      format,
    })),
  };
}
function outputs() {
  return ["ai-1024.jpg", ...kinds.map(([v, f]) => `display-${v}.${f}`)].map(
    (name) => {
      const bytes = Buffer.from(name);
      return {
        name,
        contentType: name.endsWith(".jpg") ? "image/jpeg" : "image/webp",
        width: 40,
        height: 20,
        sha256: hash(bytes),
        bytes,
      };
    },
  );
}
function harness(overrides = {}) {
  const calls = [];
  const options = {
    enabled: true,
    store: {
      async getOriginal() {
        calls.push("GET");
        return { bytes: Buffer.from(input), sha256: hash(input) };
      },
      async putDelivery(ref, d) {
        calls.push(`PUT:${ref.variant}/${ref.format}`);
        return { outcome: "stored", sha256: d.sha256, size: d.bytes.length };
      },
    },
    async isCurrent() {
      calls.push("CHECK");
      return true;
    },
    async transform() {
      calls.push("TRANSFORM");
      return { ok: true, derivatives: outputs() };
    },
    ...overrides,
  };
  return { calls, options, processor: createImagePipeline(options) };
}
const failed = (reason) => ({ ok: false, reason });

test("pipeline is disabled by default, requires store and current DB-check dependency", () => {
  assert.equal(createImagePipeline(), null);
  for (const enabled of [false, "true", 1, undefined])
    assert.equal(createImagePipeline({ enabled }), null);
  for (const options of [
    { enabled: true },
    { ...harness().options, isCurrent: undefined },
    { ...harness().options, checkTimeoutMs: 5001 },
  ])
    assert.throws(
      () => createImagePipeline(options),
      /^Error: INVALID_PIPELINE_CONFIG$/,
    );
});

test("ordered read/transform/four writes/final check; AI stays in memory; plan unchanged", async () => {
  const h = harness(),
    p = plan(),
    before = structuredClone(p);
  const result = await h.processor.process(p);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "saved");
  assert.equal(result.originalSha256, hash(input));
  assert.equal(result.ai.name, "ai-1024.jpg");
  assert.equal(result.deliveries.length, 4);
  assert.deepEqual(h.calls, [
    "CHECK",
    "GET",
    "CHECK",
    "TRANSFORM",
    ...kinds.flatMap(([v, f]) => ["CHECK", `PUT:${v}/${f}`]),
    "CHECK",
  ]);
  assert.deepEqual(p, before);
});

const invalidPlans = [
  ["missing", () => null],
  ["URL extra", (p) => ({ ...p, url: "https://evil.invalid/SECRET" })],
  ["job", (p) => ({ ...p, jobId: "invalid" })],
  ["lease", (p) => ({ ...p, leaseId: "invalid" })],
  ["version", (p) => ({ ...p, postVersion: 0 })],
  ["expiry", (p) => ({ ...p, expiresAt: NaN })],
  [
    "original hash",
    (p) => ({ ...p, original: { ...p.original, sha256: "bad" } }),
  ],
  [
    "original key injection",
    (p) => ({ ...p, original: { ...p.original, key: "arbitrary" } }),
  ],
  [
    "original etag",
    (p) => ({ ...p, original: { ...p.original, etag: '"wrong"' } }),
  ],
  ["missing variant", (p) => ({ ...p, deliveries: p.deliveries.slice(1) })],
  [
    "duplicate variant",
    (p) => ({
      ...p,
      deliveries: [
        p.deliveries[0],
        { ...p.deliveries[0], assetId: uuid(88) },
        ...p.deliveries.slice(2),
      ],
    }),
  ],
  [
    "duplicate asset",
    (p) => ({
      ...p,
      deliveries: p.deliveries.map((d) => ({ ...d, assetId: uuid(88) })),
    }),
  ],
  [
    "original asset reused",
    (p) => ({
      ...p,
      deliveries: p.deliveries.map((d, i) =>
        i ? d : { ...d, assetId: p.original.assetId },
      ),
    }),
  ],
  [
    "cross event",
    (p) => ({
      ...p,
      deliveries: p.deliveries.map((d) => ({ ...d, eventId: uuid(99) })),
    }),
  ],
  [
    "AI destination",
    (p) => ({
      ...p,
      deliveries: p.deliveries.map((d, i) =>
        i ? d : { ...d, variant: "1024" },
      ),
    }),
  ],
];
for (const [name, change] of invalidPlans)
  test(`invalid plan ${name} does no I/O`, async () => {
    const h = harness();
    assert.deepEqual(
      await h.processor.process(change(plan())),
      failed("INVALID_PLAN"),
    );
    assert.deepEqual(h.calls, []);
  });
test("resource and already expired plans do no I/O", async () => {
  const h = harness(),
    p = plan();
  p.original.size = maxOriginalReadBytes + 1;
  assert.deepEqual(await h.processor.process(p), failed("RESOURCE_LIMIT"));
  assert.deepEqual(
    await h.processor.process({ ...plan(), expiresAt: 1 }),
    failed("STALE"),
  );
  assert.deepEqual(h.calls, []);
});

for (let stop = 1; stop <= 7; stop++)
  test(`stale at check ${stop} prevents following stage/result`, async () => {
    let count = 0;
    const h = harness({
      async isCurrent() {
        return ++count !== stop;
      },
    });
    assert.deepEqual(await h.processor.process(plan()), failed("STALE"));
    assert.equal(
      h.calls.filter((c) => c.startsWith("PUT:")).length,
      Math.max(0, stop - 3),
    );
  });
test("guard throwing/false-like values fail closed without exposing exception text", async () => {
  for (const value of [false, undefined, 1, "true"]) {
    const h = harness({
      async isCurrent() {
        return value;
      },
    });
    assert.deepEqual(await h.processor.process(plan()), failed("STALE"));
    assert.deepEqual(h.calls, []);
  }
  const h = harness({
    isCurrent() {
      throw new Error("SECRET_BODY");
    },
  });
  assert.deepEqual(await h.processor.process(plan()), failed("CHECK_FAILED"));
  assert.deepEqual(h.calls, []);
});
test("guard deadline, late success and expiry during check never resume storage", async () => {
  let release;
  const h = harness({
    checkTimeoutMs: 5,
    isCurrent: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  assert.deepEqual(await h.processor.process(plan()), failed("CHECK_TIMEOUT"));
  release(true);
  await delay(10);
  assert.deepEqual(h.calls, []);
  const p = plan();
  p.expiresAt = Date.now() + 10;
  const expired = harness({
    async isCurrent() {
      await delay(30);
      return true;
    },
  });
  assert.deepEqual(await expired.processor.process(p), failed("STALE"));
  assert.deepEqual(expired.calls, []);
});
test("single in-flight plan; cloned frozen identity survives caller mutation", async () => {
  let release, entered;
  const ready = new Promise((r) => {
    entered = r;
  });
  const seen = [];
  const h = harness({
    async isCurrent(p) {
      seen.push(p);
      assert.ok(
        Object.isFrozen(p) &&
          Object.isFrozen(p.original) &&
          Object.isFrozen(p.deliveries[0]),
      );
      if (seen.length === 1) {
        entered();
        await new Promise((r) => {
          release = r;
        });
      }
      return true;
    },
  });
  const p = plan(),
    task = h.processor.process(p);
  await ready;
  assert.deepEqual(await h.processor.process(plan()), failed("BUSY"));
  p.original.postId = uuid(99);
  p.deliveries[0].assetId = uuid(99);
  p.expiresAt = 1;
  release();
  assert.equal((await task).ok, true);
  assert.equal(seen[0].original.postId, uuid(2));
  assert.equal(seen[0].deliveries[0].assetId, uuid(4));
  assert.equal((await h.processor.process(plan())).ok, true);
});
for (const [name, change] of [
  ["missing", (d) => d.slice(1)],
  ["duplicate", (d) => [d[0], d[0], ...d.slice(2)]],
  [
    "hash",
    (d) => d.map((v, i) => (i === 4 ? { ...v, sha256: "0".repeat(64) } : v)),
  ],
  [
    "type",
    (d) => d.map((v, i) => (i === 4 ? { ...v, contentType: "text/html" } : v)),
  ],
  ["dimensions", (d) => d.map((v, i) => (i === 4 ? { ...v, width: 1601 } : v))],
  ["extra", (d) => d.map((v, i) => (i === 4 ? { ...v, secret: "SECRET" } : v))],
])
  test(`all generated outputs checked before PUT: ${name}`, async () => {
    const h = harness({
      async transform() {
        return { ok: true, derivatives: change(outputs()) };
      },
    });
    assert.deepEqual(
      await h.processor.process(plan()),
      failed("INVALID_DERIVATIVES"),
    );
    assert.ok(!h.calls.some((c) => c.startsWith("PUT:")));
  });
for (const reason of ["BUSY", "TIMEOUT", "DECODE_FAILED", "WORKER_FAILED"])
  test(`transform ${reason} has no writes`, async () => {
    const h = harness({
      async transform() {
        return { ok: false, reason };
      },
    });
    assert.deepEqual(await h.processor.process(plan()), failed(reason));
    assert.ok(!h.calls.some((c) => c.startsWith("PUT:")));
  });
test("original mismatch/mutation rejected before saving", async () => {
  const h = harness();
  h.options.store.getOriginal = async () => ({
    bytes: Buffer.from("wrong"),
    sha256: hash(input),
  });
  assert.deepEqual(
    await createImagePipeline(h.options).process(plan()),
    failed("ORIGINAL_MISMATCH"),
  );
  const mutate = harness({
    async transform(bytes) {
      bytes.fill(0);
      return { ok: true, derivatives: outputs() };
    },
  });
  assert.deepEqual(
    await mutate.processor.process(plan()),
    failed("ORIGINAL_MISMATCH"),
  );
});
test("snapshot of every derivative survives mutation at later await", async () => {
  const values = outputs();
  let checks = 0;
  const h = harness({
    async transform() {
      return { ok: true, derivatives: values };
    },
    async isCurrent() {
      if (++checks === 3) values.forEach((d) => d.bytes.fill(0));
      return true;
    },
  });
  const result = await h.processor.process(plan());
  assert.equal(result.ok, true);
  assert.equal(hash(result.ai.bytes), result.ai.sha256);
});
for (let failAt = 1; failAt <= 4; failAt++)
  test(`partial save failure ${failAt} never retries/deletes or returns partial success`, async () => {
    let puts = 0;
    const h = harness();
    h.options.store.putDelivery = async (_, d) => {
      if (++puts === failAt) throw new ImageStorageError("DELIVERY_CONFLICT");
      return { outcome: "stored", sha256: d.sha256, size: d.bytes.length };
    };
    assert.deepEqual(
      await createImagePipeline(h.options).process(plan()),
      failed("DELIVERY_CONFLICT"),
    );
    assert.equal(puts, failAt);
  });
test("malformed receipt and unexpected provider exception are fixed failures", async () => {
  const h = harness();
  h.options.store.putDelivery = async () => ({
    outcome: "stored",
    sha256: "bad",
    size: 4,
  });
  assert.deepEqual(
    await createImagePipeline(h.options).process(plan()),
    failed("STORAGE_FAILED"),
  );
  h.options.store.putDelivery = async () => {
    throw new Error("SECRET_TOKEN_BODY");
  };
  assert.deepEqual(
    await createImagePipeline(h.options).process(plan()),
    failed("PIPELINE_FAILED"),
  );
});

test("synthetic HEIC through real decoder + signed R2 adapter; replay verifies four existing objects", async () => {
  const bytes = await readFile(
    new URL("./fixtures/blocks.heic", import.meta.url),
  );
  const before = hash(bytes),
    p = plan(bytes),
    objects = new Map(),
    requests = [];
  const env = {
    KOKO_IMAGE_R2_ENABLED: "true",
    R2_ACCOUNT_ID: "a".repeat(32),
    R2_ORIGINAL_READ_ACCESS_KEY_ID: "b".repeat(32),
    R2_ORIGINAL_READ_SECRET_ACCESS_KEY: "c".repeat(64),
    R2_DERIVED_ACCESS_KEY_ID: "d".repeat(32),
    R2_DERIVED_SECRET_ACCESS_KEY: "e".repeat(64),
  };
  const store = createImageR2Store(env, async (request) => {
    const pathname = new URL(request.url).pathname;
    requests.push({ method: request.method, pathname });
    if (pathname.startsWith("/koko-dev-originals/")) {
      assert.equal(request.method, "GET");
      return new Response(bytes, {
        headers: {
          etag: `"${hash(bytes, "md5")}"`,
          "content-length": String(bytes.length),
        },
      });
    }
    assert.ok(pathname.startsWith("/koko-dev-derived/"));
    assert.ok(!pathname.includes("1024"));
    if (request.method === "PUT") {
      assert.equal(request.headers.get("if-none-match"), "*");
      if (objects.has(pathname)) return new Response(null, { status: 412 });
      const body = Buffer.from(await request.arrayBuffer());
      const headers = {
        etag: `"${hash(body, "md5")}"`,
        "content-length": String(body.length),
        "content-type": request.headers.get("content-type"),
        "cache-control": request.headers.get("cache-control"),
        "x-amz-meta-sha256": request.headers.get("x-amz-meta-sha256"),
      };
      objects.set(pathname, { body, headers });
      return new Response(null, { headers: { etag: headers.etag } });
    }
    assert.equal(request.method, "GET");
    const object = objects.get(pathname);
    return new Response(object.body, { headers: object.headers });
  });
  const processor = createImagePipeline({
    enabled: true,
    store,
    async isCurrent() {
      return true;
    },
  });
  const first = await processor.process(p);
  assert.equal(first.ok, true);
  assert.equal(objects.size, 4);
  assert.ok(first.deliveries.every((d) => d.outcome === "stored"));
  const second = await processor.process(p);
  assert.equal(second.ok, true);
  assert.ok(second.deliveries.every((d) => d.outcome === "already_stored"));
  assert.equal(hash(bytes), before);
  assert.equal(first.originalSha256, before);
  assert.deepEqual(first.ai.bytes, second.ai.bytes);
  assert.equal(requests.filter((r) => r.method === "PUT").length, 8);
  assert.equal(requests.filter((r) => r.method === "GET").length, 6);
});
