import assert from "node:assert/strict";
import { test } from "node:test";
const { Response, Buffer, AbortController } = globalThis;
import { createPrivateModerationFrames } from "../dist/moderation-frames.js";
import { moderationPlan } from "./moderation-fixture.mjs";
import { json, uuid } from "./processing-fixture.mjs";
const raw = Uint8Array.of(255, 216, 1, 2, 3, 255, 217);
function harness(overrides = {}) {
  const calls = [];
  const p = moderationPlan("video");
  const observation = () => ({
    uid: p.media.streamUid,
    requireSignedURLs: true,
    readyToStream: true,
    status: { state: "ready", pctComplete: "100" },
    duration: 3,
    allowedOrigins: ["festival.test"],
    meta: {
      koko_event: p.original.eventId,
      koko_post: p.original.postId,
      koko_asset: p.original.assetId,
      koko_job: p.jobId,
      koko_operation: uuid(51),
      koko_version: "3",
      koko_source: "original",
    },
    modified: "2026-10-06T01:00:00Z",
  });
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://customer-fixture.cloudflarestream.com"))
      return new Response(raw, { headers: { "content-type": "image/jpeg" } });
    if (String(url).endsWith("/token")) {
      const claims = {
        sub: p.media.streamUid,
        exp: Math.floor(Date.now() / 1000) + 60,
        downloadable: false,
      };
      overrides.claims?.(claims);
      return json({
        success: true,
        errors: [],
        result: {
          token:
            "e30." +
            Buffer.from(JSON.stringify(claims)).toString("base64url") +
            ".signature",
        },
      });
    }
    const o = observation();
    overrides.observation?.(o, calls.length);
    return json({ success: true, errors: [], result: o });
  };
  const get = createPrivateModerationFrames({
    enabled: true,
    accountId: "b".repeat(32),
    customerHost: "customer-fixture.cloudflarestream.com",
    allowedOrigins: ["festival.test"],
    apiToken: async () => "fixture_token",
    isCurrent: async () => true,
    fetcher,
    ...overrides,
  });
  return { get, p, calls };
}
test("private frame provider is default OFF, rejects arbitrary hosts", () => {
  assert.equal(createPrivateModerationFrames(), null);
  assert.throws(
    () => harness({ customerHost: "evil.test" }),
    /INVALID_PRIVATE_FRAMES_CONFIG/,
  );
  assert.throws(
    () => harness({ allowedOrigins: ["*"] }),
    /INVALID_PRIVATE_FRAMES_CONFIG/,
  );
});
test("fixed signed thumbnail targets, 3 frames, provider and DB recheck", async () => {
  const h = harness();
  const frames = await h.get(h.p, new AbortController().signal);
  assert.equal(frames.frames.length, 3);
  assert.equal(h.calls.length, 6);
  assert.equal(h.calls.filter((x) => x.init.method === "POST").length, 1);
  assert.ok(h.calls.every((x) => x.init.redirect === "manual"));
  for (const call of h.calls.filter((x) => x.url.includes("thumbnail.jpg"))) {
    assert.equal(call.init.headers.authorization, undefined);
    assert.equal(call.init.headers.origin, "https://festival.test");
  }
  assert.equal(JSON.stringify(frames).includes("signature"), false);
});
for (const [name, observation] of [
  ["unsigned", (o) => (o.requireSignedURLs = false)],
  ["partial", (o) => (o.status.pctComplete = "99")],
  ["wrong event", (o) => (o.meta.koko_event = uuid(90))],
  ["wrong original", (o) => (o.meta.koko_asset = uuid(90))],
  ["too long", (o) => (o.duration = 4.1)],
  ["wrong source", (o) => (o.clippedFrom = "f".repeat(32))],
  ["origins", (o) => (o.allowedOrigins = ["*"])],
  [
    "changed after fetch",
    (o, n) => {
      if (n === 6) o.modified = "2026-10-06T02:00:00Z";
    },
  ],
])
  test(`private frames ${name} rejected`, async () => {
    const h = harness({ observation });
    await assert.rejects(
      h.get(h.p, new AbortController().signal),
      /PRIVATE_FRAMES_UNAVAILABLE/,
    );
  });
for (const [name, claims] of [
  ["wrong subject", (x) => (x.sub = "b".repeat(32))],
  ["download", (x) => (x.downloadable = true)],
  ["far expiry", (x) => (x.exp += 120)],
  ["flags", (x) => (x.flags = {})],
  ["future nbf", (x) => (x.nbf = x.exp)],
])
  test(`signed token ${name} rejected`, async () => {
    const h = harness({ claims });
    await assert.rejects(
      h.get(h.p, new AbortController().signal),
      /PRIVATE_FRAMES_UNAVAILABLE/,
    );
    assert.ok(!h.calls.some((x) => x.url.includes("thumbnail.jpg")));
  });
test("DB refusal and network timeout are sanitized", async () => {
  const h = harness({ isCurrent: async () => false });
  await assert.rejects(
    h.get(h.p, new AbortController().signal),
    /PRIVATE_FRAMES_UNAVAILABLE/,
  );
  assert.equal(h.calls.length, 0);
  const stalled = harness({
    fetcher: () => new Promise(() => {}),
    timeoutMs: 10,
  });
  await assert.rejects(
    stalled.get(stalled.p, new AbortController().signal),
    /PRIVATE_FRAMES_UNAVAILABLE/,
  );
});
