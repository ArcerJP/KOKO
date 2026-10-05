import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { URL } from "node:url";
import {
  createImageR2Store,
  ImageStorageError,
  maxOriginalReadBytes,
  maxDerivativeBytes,
} from "../dist/r2.js";
import { transformImage } from "../dist/index.js";

const { Response, ReadableStream } = globalThis;
const env = {
  KOKO_IMAGE_R2_ENABLED: "true",
  R2_ACCOUNT_ID: "a".repeat(32),
  R2_ORIGINAL_READ_ACCESS_KEY_ID: "b".repeat(32),
  R2_ORIGINAL_READ_SECRET_ACCESS_KEY: "c".repeat(64),
  R2_DERIVED_ACCESS_KEY_ID: "d".repeat(32),
  R2_DERIVED_SECRET_ACCESS_KEY: "e".repeat(64),
};
const eventId = "00000000-0000-4000-8000-000000000001";
const postId = "00000000-0000-4000-8000-000000000002";
const assetId = "00000000-0000-4000-8000-000000000003";
const hash = (bytes, algorithm = "sha256") =>
  createHash(algorithm).update(bytes).digest("hex");
const input = Buffer.from("SYNTHETIC_BYTES");
const original = () => ({
  eventId,
  postId,
  assetId,
  size: input.length,
  etag: hash(input, "md5"),
  sha256: hash(input),
});
const reference = () => ({ eventId, assetId, variant: "600", format: "jpg" });
const derivative = () => ({
  name: "display-600.jpg",
  contentType: "image/jpeg",
  width: 600,
  height: 400,
  sha256: hash(input),
  bytes: Buffer.from(input),
});
const headers = () => ({
  etag: `"${hash(input, "md5")}"`,
  "content-length": String(input.length),
});
const deliveryHeaders = () => ({
  ...headers(),
  "content-type": "image/jpeg",
  "cache-control": "private, no-store",
  "x-amz-meta-sha256": hash(input),
});
function fixed(code) {
  return (error) => {
    assert.ok(error instanceof ImageStorageError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    assert.equal(JSON.stringify(error).includes("SECRET"), false);
    return true;
  };
}

test("disabled by default; malformed config rejected without any network", () => {
  for (const flag of [undefined, "false", "TRUE", " true ", ""]) {
    assert.equal(createImageR2Store({ KOKO_IMAGE_R2_ENABLED: flag }), null);
  }
  for (const field of Object.keys(env).filter(
    (key) => key !== "KOKO_IMAGE_R2_ENABLED",
  )) {
    assert.throws(
      () =>
        createImageR2Store({ ...env, [field]: "https://evil.invalid/SECRET" }),
      fixed("INVALID_CONFIG"),
    );
  }
  assert.throws(
    () =>
      createImageR2Store({
        ...env,
        R2_DERIVED_ACCESS_KEY_ID: env.R2_ORIGINAL_READ_ACCESS_KEY_ID,
      }),
    fixed("INVALID_CONFIG"),
  );
  for (const deadline of [0, -1, 15001, 1.5, NaN, Infinity])
    assert.throws(
      () => createImageR2Store(env, undefined, deadline),
      fixed("INVALID_CONFIG"),
    );
});

test("original GET has fixed private host/key, If-Match, separate signed read credential", async () => {
  let calls = 0;
  const store = createImageR2Store(env, async (request) => {
    calls++;
    assert.equal(
      request.url,
      `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/koko-dev-originals/events/${eventId}/posts/${postId}/original/${assetId}.bin`,
    );
    assert.equal(request.method, "GET");
    assert.equal(request.redirect, "manual");
    assert.equal(request.cache, "no-store");
    assert.equal(request.headers.get("if-match"), headers().etag);
    assert.equal(request.headers.get("accept-encoding"), "identity");
    assert.ok(
      request.headers
        .get("authorization")
        .includes(`Credential=${env.R2_ORIGINAL_READ_ACCESS_KEY_ID}/`),
    );
    assert.ok(request.headers.get("authorization").includes("if-match"));
    assert.equal(request.url.includes("X-Amz"), false);
    return new Response(input, { headers: headers() });
  });
  const result = await store.getOriginal(original());
  assert.deepEqual(result, { bytes: input, sha256: hash(input) });
  assert.equal(calls, 1);
  const withoutHash = original();
  delete withoutHash.sha256;
  assert.deepEqual(await store.getOriginal(withoutHash), result);
});

test("original input/size/hash/URL validation happens before fetch", async () => {
  let calls = 0;
  const store = createImageR2Store(env, async () => {
    calls++;
    throw new Error("NETWORK_FORBIDDEN");
  });
  for (const value of [
    null,
    {},
    { ...original(), url: "https://evil.invalid/" },
    { ...original(), eventId: "../SECRET" },
    { ...original(), assetId: null },
    { ...original(), etag: '"bad"' },
    { ...original(), etag: "a".repeat(32) + "-10001" },
    { ...original(), size: 0 },
    { ...original(), size: 1.5 },
    { ...original(), sha256: "wrong" },
  ]) {
    await assert.rejects(store.getOriginal(value), fixed("INVALID_INPUT"));
  }
  await assert.rejects(
    store.getOriginal({ ...original(), size: maxOriginalReadBytes + 1 }),
    fixed("RESOURCE_LIMIT"),
  );
  assert.equal(calls, 0);
});

for (const status of [301, 302, 307, 308, 401, 403, 404, 412, 429, 500]) {
  test(`original status ${status} fails without redirects/retries or raw error`, async () => {
    let calls = 0,
      cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const store = createImageR2Store(env, async () => {
      calls++;
      return new Response(body, {
        status,
        headers: { location: "https://evil.invalid/SECRET" },
      });
    });
    await assert.rejects(
      store.getOriginal(original()),
      fixed(
        [404, 412].includes(status) ? "ORIGINAL_MISMATCH" : "STORAGE_FAILED",
      ),
    );
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
  });
}

for (const [name, body, changes, ref] of [
  ["etag", input, { etag: '"mismatch"' }],
  ["declared length", input, { "content-length": "999" }],
  ["missing length", input, { "content-length": null }],
  ["compressed", input, { "content-encoding": "gzip" }],
  ["short body", input.subarray(1), {}],
  ["oversized body", Buffer.concat([input, input]), {}],
  ["sha mismatch", input, {}, { ...original(), sha256: "0".repeat(64) }],
]) {
  test(`original rejects ${name}`, async () => {
    const h = { ...headers(), ...changes };
    if (h["content-length"] === null) delete h["content-length"];
    const store = createImageR2Store(
      env,
      async () => new Response(body, { headers: h }),
    );
    await assert.rejects(
      store.getOriginal(ref ?? original()),
      fixed("ORIGINAL_MISMATCH"),
    );
  });
}

test("derived PUT is exclusive, private, signed separately; input is snapshotted", async () => {
  const value = derivative();
  const ref = reference();
  const store = createImageR2Store(env, async (request) => {
    assert.equal(
      request.url,
      `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/koko-dev-derived/events/${eventId}/delivery/${assetId}/600.jpg`,
    );
    assert.equal(request.method, "PUT");
    assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("if-none-match"), "*");
    assert.equal(request.headers.get("cache-control"), "private, no-store");
    assert.equal(request.headers.get("content-type"), "image/jpeg");
    assert.equal(request.headers.get("x-amz-meta-sha256"), hash(input));
    assert.equal(
      request.headers.get("content-md5"),
      createHash("md5").update(input).digest("base64"),
    );
    const authorization = request.headers.get("authorization");
    assert.ok(
      authorization.includes(`Credential=${env.R2_DERIVED_ACCESS_KEY_ID}/`),
    );
    assert.ok(authorization.includes("if-none-match"));
    assert.ok(authorization.includes("content-md5"));
    assert.deepEqual(Buffer.from(await request.arrayBuffer()), input);
    return new Response(null, { headers: { etag: headers().etag } });
  });
  const result = store.putDelivery(ref, value);
  value.bytes.fill(0);
  value.sha256 = "0".repeat(64);
  ref.eventId = "modified";
  assert.deepEqual(await result, {
    outcome: "stored",
    sha256: hash(input),
    size: input.length,
  });
});

test("derived validation forbids original/AI paths, arbitrary keys and bad bytes", async () => {
  let calls = 0;
  const store = createImageR2Store(env, async () => {
    calls++;
    throw new Error("NETWORK_FORBIDDEN");
  });
  for (const ref of [
    null,
    {},
    { ...reference(), key: "original/file" },
    { ...reference(), variant: "1024" },
    { ...reference(), format: "png" },
    { ...reference(), eventId: "../SECRET" },
  ])
    await assert.rejects(
      store.putDelivery(ref, derivative()),
      fixed("INVALID_INPUT"),
    );
  for (const value of [
    null,
    {},
    { ...derivative(), name: "ai-1024.jpg" },
    { ...derivative(), width: 601 },
    { ...derivative(), height: 0 },
    { ...derivative(), sha256: "0".repeat(64) },
    { ...derivative(), contentType: "text/html" },
    { ...derivative(), bytes: new Uint8Array() },
    { ...derivative(), url: "https://evil.invalid/" },
  ])
    await assert.rejects(
      store.putDelivery(reference(), value),
      fixed("INVALID_INPUT"),
    );
  await assert.rejects(
    store.putDelivery(reference(), {
      ...derivative(),
      bytes: new Uint8Array(maxDerivativeBytes + 1),
    }),
    fixed("RESOURCE_LIMIT"),
  );
  assert.equal(calls, 0);
});

test("412 is idempotent only after conditional GET checks actual SHA and private metadata", async () => {
  const methods = [];
  const store = createImageR2Store(env, async (request) => {
    methods.push(request.method);
    if (request.method === "PUT") return new Response(null, { status: 412 });
    assert.equal(request.headers.get("if-match"), headers().etag);
    return new Response(input, { headers: deliveryHeaders() });
  });
  assert.deepEqual(await store.putDelivery(reference(), derivative()), {
    outcome: "already_stored",
    sha256: hash(input),
    size: input.length,
  });
  assert.deepEqual(methods, ["PUT", "GET"]);
});

for (const [name, status, body, changes] of [
  ["disappeared", 404, input, {}],
  ["changed", 412, input, {}],
  ["etag", 200, input, { etag: '"other"' }],
  ["content type", 200, input, { "content-type": "text/html" }],
  ["cache", 200, input, { "cache-control": "public" }],
  ["metadata hash", 200, input, { "x-amz-meta-sha256": "0".repeat(64) }],
  ["actual bytes", 200, Buffer.alloc(input.length), {}],
  ["length", 200, input.subarray(1), {}],
]) {
  test(`existing derivative ${name} fails closed without overwrite or deletion`, async () => {
    const methods = [];
    const store = createImageR2Store(env, async (request) => {
      methods.push(request.method);
      return request.method === "PUT"
        ? new Response(null, { status: 412 })
        : new Response(body, {
            status,
            headers: { ...deliveryHeaders(), ...changes },
          });
    });
    await assert.rejects(
      store.putDelivery(reference(), derivative()),
      fixed("DELIVERY_CONFLICT"),
    );
    assert.deepEqual(methods, ["PUT", "GET"]);
  });
}

test("ambiguous PUT failures never trigger overwrite, retry, deletion or success", async () => {
  for (const behavior of [
    "throw",
    "redirect",
    "error",
    "bad-etag",
    "unexpected-success",
  ]) {
    let calls = 0;
    const store = createImageR2Store(env, async () => {
      calls++;
      if (behavior === "throw") throw new Error("SECRET_PROVIDER_BODY");
      return new Response("SECRET_PROVIDER_BODY", {
        status:
          behavior === "redirect"
            ? 307
            : behavior === "error"
              ? 500
              : behavior === "unexpected-success"
                ? 201
                : 200,
      });
    });
    await assert.rejects(
      store.putDelivery(reference(), derivative()),
      fixed("STORAGE_FAILED"),
    );
    assert.equal(calls, 1);
  }
});

test("whole-operation deadlines abort request/body and discard late responses", async () => {
  let resolve,
    signal,
    cancelled = false;
  const store = createImageR2Store(
    env,
    (request) => {
      signal = request.signal;
      return new Promise((r) => {
        resolve = r;
      });
    },
    100,
  );
  await assert.rejects(store.getOriginal(original()), fixed("TIMEOUT"));
  assert.equal(signal.aborted, true);
  resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: headers() },
    ),
  );
  await delay(10);
  assert.equal(cancelled, true);
  cancelled = false;
  const hanging = createImageR2Store(
    env,
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: headers() },
      ),
    100,
  );
  await assert.rejects(hanging.getOriginal(original()), fixed("TIMEOUT"));
  assert.equal(cancelled, true);
  const write = createImageR2Store(env, () => new Promise(() => {}), 100);
  await assert.rejects(
    write.putDelivery(reference(), derivative()),
    fixed("TIMEOUT"),
  );
});

test("real synthetic HEIC transform persists four delivery variants, never the AI image", async () => {
  const source = await readFile(
    new URL("./fixtures/blocks.heic", import.meta.url),
  );
  const objects = new Map();
  const calls = [];
  const store = createImageR2Store(env, async (request) => {
    calls.push([request.method, request.url]);
    if (request.url.includes("koko-dev-originals"))
      return new Response(source, {
        headers: {
          etag: `"${hash(source, "md5")}"`,
          "content-length": String(source.length),
        },
      });
    const bytes = Buffer.from(await request.arrayBuffer());
    objects.set(request.url, bytes);
    return new Response(null, { headers: { etag: `"${hash(bytes, "md5")}"` } });
  });
  const fetched = await store.getOriginal({
    ...original(),
    size: source.length,
    etag: hash(source, "md5"),
    sha256: hash(source),
  });
  const result = await transformImage(fetched.bytes);
  assert.equal(result.ok, true);
  // Each DB media_assets row has one purpose and its own reserved asset ID.
  for (const [i, value] of result.derivatives.slice(1).entries()) {
    const match = /^display-(600|1600)\.(webp|jpg)$/.exec(value.name);
    await store.putDelivery(
      {
        eventId,
        assetId: `00000000-0000-4000-8000-00000000001${i}`,
        variant: match[1],
        format: match[2],
      },
      value,
    );
  }
  assert.equal(objects.size, 4);
  assert.equal(calls.length, 5);
  assert.equal(
    calls.some(([, url]) => url.includes("1024")),
    false,
  );
  assert.equal(hash(fetched.bytes), hash(source));
});
