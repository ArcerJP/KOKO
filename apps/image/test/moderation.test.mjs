import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import sharp from "sharp";
import { costRates } from "./moderation-fixture.mjs";
const {
  Buffer,
  Response,
  ReadableStream,
  AbortController,
  AbortSignal,
  setTimeout,
} = globalThis;
import {
  createMediaModerator,
  evaluateModerationScores,
  moderationCategories,
  safeSearchScoreVersion,
  snapshotModerationPolicy,
} from "../dist/moderation.js";

const bytes = await sharp({
  create: { width: 16, height: 8, channels: 3, background: "#c4a381" },
})
  .jpeg()
  .toBuffer();
const image = () => ({
  name: "ai-1024.jpg",
  contentType: "image/jpeg",
  width: 16,
  height: 8,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: Buffer.from(bytes),
});
const photo = () => ({ kind: "photo", image: image() });
const video = () => ({
  kind: "video",
  measuredDurationSeconds: 3.8,
  frames: [0.5, 1.5, 3].map((seconds, index) => ({
    index,
    seconds,
    image: image(),
  })),
});
const policy = () => ({
  approved: true,
  version: 1,
  safeSearchScoreVersion,
  openaiModel: "omni-moderation-2024-09-26",
  thresholds: Object.entries(moderationCategories).flatMap(
    ([engine, categories]) =>
      categories.map((category) => ({
        engine,
        category,
        flag: 0.5,
        block: 0.8,
        immediate_ban: false,
      })),
  ),
});
const starts = (nextAttempt = 1, frameCount = 1) =>
  Array.from({ length: frameCount }, (_, frame) =>
    Object.keys(moderationCategories).map((engine) => ({
      engine,
      frame,
      nextAttempt,
    })),
  ).flat();

test("durable recovery does not replenish consumed provider attempts", async () => {
  const { moderator, quotaCalls } = configuration({ attemptStarts: starts(3) });
  const result = await moderator.moderate(photo());
  assert.equal(result.decision, "PASS");
  assert.ok(result.runs.every((x) => x.attempt === 3));
  assert.ok(quotaCalls.every((x) => x.attempt === 3 && x.frame === 0));
  assert.equal(quotaCalls.length, 4);
});

test("exhausted durable attempts hold without a provider request", async () => {
  const { moderator, quotaCalls, calls } = configuration({
    attemptStarts: starts(4),
  });
  const result = await moderator.moderate(photo());
  assert.equal(result.decision, "HELD");
  assert.deepEqual(result.runs, []);
  assert.equal(quotaCalls.length + calls.length, 0);
});

for (const attemptStarts of [
  [],
  starts(0),
  starts(5),
  [...starts(), starts()[0]],
]) {
  test("invalid durable attempt plan fails closed", () => {
    assert.throws(
      () => configuration({ attemptStarts }),
      /INVALID_MODERATION_CONFIG/,
    );
  });
}

test("photo recovery plan cannot silently authorize unplanned video frames", async () => {
  const { moderator, calls } = configuration({ attemptStarts: starts() });
  const result = await moderator.moderate(video());
  assert.equal(result.decision, "HELD");
  assert.equal(result.errorCode, "INVALID_MEDIA");
  assert.equal(calls.length, 0);
});
const json = (body, options = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...options,
  });
function openai(modality, changes = {}) {
  const supported =
    modality === "image"
      ? moderationCategories.openai
      : moderationCategories.ocr;
  return {
    model: "omni-moderation-2024-09-26",
    results: [
      {
        flagged: false,
        categories: Object.fromEntries(
          moderationCategories.ocr.map((c) => [c, false]),
        ),
        category_scores: Object.fromEntries(
          moderationCategories.ocr.map((c) => [
            c,
            supported.includes(c) ? 0.1 : 0,
          ]),
        ),
        category_applied_input_types: Object.fromEntries(
          moderationCategories.ocr.map((c) => [
            c,
            supported.includes(c) ? [modality] : [],
          ]),
        ),
        ...changes,
      },
    ],
  };
}
const safe = () => ({
  responses: [
    {
      safeSearchAnnotation: Object.fromEntries(
        moderationCategories.safesearch.map((c) => [c, "VERY_UNLIKELY"]),
      ),
    },
  ],
});
function configuration(overrides = {}) {
  const calls = [];
  const quotaCalls = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    if (url === "https://api.openai.com/v1/moderations")
      return json(openai(typeof body.input === "string" ? "text" : "image"));
    if (body.requests[0].features[0].type === "SAFE_SEARCH_DETECTION")
      return json(safe());
    return json({
      responses: [{ fullTextAnnotation: { text: "synthetic OCR text" } }],
    });
  };
  const config = {
    enabled: true,
    policy: policy(),
    maxConcurrentJobs: 1,
    openaiToken: async () => "synthetic-openai-key",
    visionToken: async () => "synthetic-vision-token",
    reserveQuota: async (request) => {
      quotaCalls.push(request);
      return { allowed: true };
    },
    fetcher,
    attemptTimeoutMs: 500,
    retryDelayMs: 1,
    ...overrides,
  };
  return {
    moderator: createMediaModerator(config),
    calls,
    quotaCalls,
    fetcher,
    config,
  };
}

test("disabled by default without reading config or credentials", () => {
  assert.equal(createMediaModerator(), null);
  assert.equal(
    createMediaModerator({
      enabled: false,
      policy: {
        get approved() {
          throw Error("secret");
        },
      },
    }),
    null,
  );
});
test("optional rate snapshot estimates each real attempt without changing verdict/model/policy", async () => {
  const p = policy();
  p.costRates = costRates();
  const base = configuration(),
    { moderator } = configuration({ policy: p, fetcher: base.fetcher });
  p.costRates.microUsdPerUnit.safeSearchImages = 0;
  const result = await moderator.moderate(photo());
  assert.equal(result.decision, "PASS");
  assert.deepEqual(
    result.runs.map((r) => [r.engine, r.estimatedCostUsd]),
    [
      ["openai", 0],
      ["safesearch", 0.0015],
      ["ocr", 0.0015],
    ],
  );
  assert.ok(result.runs.every((r) => r.costRateCard.version === 1));
  assert.equal(base.calls.length, 4);
});
test("configured estimates count failed requests and each retry, but not quota-refused calls", async () => {
  const p = policy();
  p.costRates = costRates();
  const base = configuration();
  let failed = false;
  const { moderator } = configuration({
    policy: p,
    fetcher: async (url, init) => {
      if (!failed && url.includes("vision")) {
        failed = true;
        throw Error("synthetic lost response");
      }
      return base.fetcher(url, init);
    },
  });
  const result = await moderator.moderate(photo());
  assert.equal(result.decision, "PASS");
  const safe = result.runs.filter((r) => r.engine === "safesearch");
  assert.deepEqual(
    safe.map((r) => [r.attempt, r.estimatedCostUsd]),
    [
      [1, 0.0015],
      [2, 0.0015],
    ],
  );
  const blocked = await configuration({
    policy: p,
    reserveQuota: async () => ({ allowed: false }),
  }).moderator.moderate(photo());
  assert.equal(blocked.decision, "HELD");
  assert.ok(blocked.runs.every((r) => r.estimatedCostUsd === 0));
});

test("complete approved policy is copied and frozen", () => {
  const input = policy();
  const result = snapshotModerationPolicy(input);
  input.thresholds[0].block = 0;
  assert.equal(result.thresholds[0].block, 0.8);
  assert.ok(
    Object.isFrozen(result) &&
      Object.isFrozen(result.thresholds) &&
      Object.isFrozen(result.thresholds[0]),
  );
});
for (const [name, mutate] of [
  [
    "unapproved",
    (p) => {
      p.approved = false;
    },
  ],
  [
    "zero version",
    (p) => {
      p.version = 0;
    },
  ],
  [
    "unmapped ordinal version",
    (p) => {
      p.safeSearchScoreVersion = "other";
    },
  ],
  [
    "implicit moving model",
    (p) => {
      p.openaiModel = "omni-moderation-latest";
    },
  ],
  [
    "missing engine/category",
    (p) => {
      p.thresholds.pop();
    },
  ],
  [
    "duplicate",
    (p) => {
      p.thresholds.push(p.thresholds[0]);
    },
  ],
  [
    "unknown",
    (p) => {
      p.thresholds[0].category = "custom";
    },
  ],
  [
    "unsupported image category",
    (p) => {
      p.thresholds[0].category = "sexual/minors";
    },
  ],
  [
    "reversed",
    (p) => {
      p.thresholds[0].flag = 0.9;
    },
  ],
  [
    "nan",
    (p) => {
      p.thresholds[0].flag = NaN;
    },
  ],
  [
    "outside unit",
    (p) => {
      p.thresholds[0].block = 2;
    },
  ],
  [
    "general category immediate BAN",
    (p) => {
      p.thresholds[0].immediate_ban = true;
    },
  ],
  [
    "unknown field",
    (p) => {
      p.endpoint = "https://attacker.invalid";
    },
  ],
])
  test(`policy rejects ${name}`, () => {
    const p = policy();
    mutate(p);
    assert.throws(
      () => snapshotModerationPolicy(p),
      /INVALID_MODERATION_POLICY/,
    );
  });
for (const change of [
  { maxConcurrentJobs: 0 },
  { maxConcurrentJobs: 33 },
  { attemptTimeoutMs: 15001 },
  { reserveQuota: null },
  { visionToken: null },
  { retryDelayMs: 0 },
])
  test(`configuration fails closed ${JSON.stringify(change)}`, () => {
    assert.throws(() => configuration(change), /INVALID_MODERATION_CONFIG/);
  });

test("pure evaluation uses inclusive thresholds and severe BAN only on BLOCK", () => {
  const p = policy();
  const s = Object.fromEntries(
    moderationCategories.openai.map((c) => [c, 0.1]),
  );
  p.thresholds.find(
    (t) => t.engine === "openai" && t.category === "violence/graphic",
  ).immediate_ban = true;
  assert.equal(evaluateModerationScores("openai", s, p).decision, "PASS");
  s["violence/graphic"] = 0.5;
  assert.equal(evaluateModerationScores("openai", s, p).decision, "FLAG");
  assert.equal(evaluateModerationScores("openai", s, p).immediateBan, false);
  s["violence/graphic"] = 0.8;
  assert.equal(evaluateModerationScores("openai", s, p).decision, "BLOCK");
  assert.equal(evaluateModerationScores("openai", s, p).immediateBan, true);
  delete s.sexual;
  assert.equal(evaluateModerationScores("openai", s, p).decision, "ERROR");
});

test("photo uses fixed endpoints, only reduced JPEG, separate credentials, and sanitized evidence", async () => {
  const { moderator, calls, quotaCalls } = configuration();
  const result = await moderator.moderate(photo());
  assert.equal(result.decision, "PASS");
  assert.equal(result.runs.length, 3);
  assert.equal(calls.length, 4);
  assert.equal(quotaCalls.length, 4);
  for (const call of calls) {
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.cache, "no-store");
    assert.equal(
      call.init.headers.authorization,
      call.url.includes("openai")
        ? "Bearer synthetic-openai-key"
        : "Bearer synthetic-vision-token",
    );
    assert.deepEqual(Object.keys(call.init.headers).sort(), [
      "accept",
      "accept-encoding",
      "authorization",
      "content-type",
    ]);
  }
  assert.deepEqual(
    result.runs.map((r) => r.estimatedCostUsd),
    [null, null, null],
  );
  assert.deepEqual(
    result.runs.map((r) => r.observation),
    ["scores", "scores", "scores"],
  );
  const encoded = JSON.stringify(result);
  for (const forbidden of [
    "synthetic-openai-key",
    "synthetic-vision-token",
    "synthetic OCR text",
    bytes.toString("base64"),
  ])
    assert.ok(!encoded.includes(forbidden));
  assert.equal(
    result.runs.reduce((sum, r) => sum + r.usage.openaiRequests, 0),
    2,
  );
});

test("successful no-text OCR is explicit, no text provider call or invented scores", async () => {
  const base = configuration();
  const { moderator } = configuration({
    fetcher: (url, init) => {
      if (url.includes("vision") && init.body.includes("DOCUMENT_TEXT"))
        return json({ responses: [{}] });
      return base.fetcher(url, init);
    },
  });
  const result = await moderator.moderate(photo());
  assert.equal(result.decision, "PASS");
  const ocr = result.runs.find((r) => r.engine === "ocr");
  assert.equal(ocr.observation, "no_text");
  assert.deepEqual(ocr.scores, {});
  assert.equal(ocr.usage.openaiRequests, 0);
});

for (const [name, mutate] of [
  [
    "original name",
    (m) => {
      m.image.name = "original.jpg";
    },
  ],
  [
    "url object",
    (m) => {
      m.image.url = "https://example.invalid/original";
    },
  ],
  [
    "dimensions",
    (m) => {
      m.image.width = 1600;
    },
  ],
  [
    "dishonest dimensions",
    (m) => {
      m.image.width = 1;
    },
  ],
  [
    "bad checksum",
    (m) => {
      m.image.sha256 = "a".repeat(64);
    },
  ],
  [
    "not JPEG",
    (m) => {
      m.image.contentType = "image/webp";
    },
  ],
  [
    "truncated",
    (m) => {
      m.image.bytes = m.image.bytes.subarray(0, 20);
      m.image.sha256 = createHash("sha256").update(m.image.bytes).digest("hex");
    },
  ],
])
  test(`media rejects ${name} before quota/key/fetch`, async () => {
    const m = photo();
    mutate(m);
    const { moderator, calls, quotaCalls } = configuration();
    const result = await moderator.moderate(m);
    assert.equal(result.errorCode, "INVALID_MEDIA");
    assert.equal(calls.length + quotaCalls.length, 0);
  });

test("metadata-containing JPEG is not transmitted", async () => {
  const b = await sharp(bytes).withMetadata().jpeg().toBuffer();
  const m = photo();
  m.image.bytes = b;
  m.image.sha256 = createHash("sha256").update(b).digest("hex");
  const { moderator, calls } = configuration();
  assert.equal((await moderator.moderate(m)).errorCode, "INVALID_MEDIA");
  assert.equal(calls.length, 0);
});

test("video requires exactly 3 distinct in-range ordered timestamps, content may legitimately match", async () => {
  const { moderator, calls } = configuration();
  assert.equal((await moderator.moderate(video())).decision, "PASS");
  assert.equal(calls.length, 12);
  for (const mutate of [
    (m) => m.frames.pop(),
    (m) => {
      m.frames[1].seconds = m.frames[0].seconds;
    },
    (m) => {
      m.frames[0].seconds = 0;
    },
    (m) => {
      m.frames[2].seconds = 3.8;
    },
    (m) => {
      m.frames[1].index = 0;
    },
    (m) => {
      m.measuredDurationSeconds = 4.01;
    },
    (m) => {
      m.measuredDurationSeconds = NaN;
    },
  ]) {
    const m = video();
    mutate(m);
    assert.equal((await moderator.moderate(m)).errorCode, "INVALID_MEDIA");
  }
  assert.equal(calls.length, 12);
});

test("BLOCK beats required engine error; FLAG cannot defeat error", async () => {
  for (const score of [0.8, 0.5]) {
    const base = configuration();
    const { moderator } = configuration({
      fetcher: (url, init) => {
        if (url.includes("openai")) {
          const r = openai("image");
          r.results[0].category_scores.sexual = score;
          return json(r);
        }
        if (init.body.includes("DOCUMENT_TEXT"))
          return json({ responses: [null] });
        return base.fetcher(url, init);
      },
    });
    const result = await moderator.moderate(photo());
    assert.equal(result.decision, score === 0.8 ? "BLOCK" : "HELD");
  }
});

for (const [name, mutate] of [
  [
    "image category unsupported",
    (r) => {
      r.results[0].category_applied_input_types.sexual = [];
    },
  ],
  [
    "unknown category",
    (r) => {
      r.results[0].category_scores.unknown = 0;
    },
  ],
  [
    "duplicate modality",
    (r) => {
      r.results[0].category_applied_input_types.sexual = ["image", "image"];
    },
  ],
  [
    "missing score",
    (r) => {
      delete r.results[0].category_scores.sexual;
    },
  ],
  [
    "null flag",
    (r) => {
      r.results[0].categories.sexual = null;
    },
  ],
  [
    "wrong model",
    (r) => {
      r.model = "future-model";
    },
  ],
  [
    "multiple results",
    (r) => {
      r.results.push(r.results[0]);
    },
  ],
  [
    "scored text-only image category",
    (r) => {
      r.results[0].category_scores["sexual/minors"] = 0.1;
    },
  ],
])
  test(`OpenAI response fails closed: ${name}`, async () => {
    const base = configuration();
    const { moderator } = configuration({
      fetcher: (url, init) => {
        if (
          url.includes("openai") &&
          typeof JSON.parse(init.body).input !== "string"
        ) {
          const r = openai("image");
          mutate(r);
          return json(r);
        }
        return base.fetcher(url, init);
      },
    });
    const result = await moderator.moderate(photo());
    assert.equal(result.decision, "HELD");
    assert.equal(
      result.runs.find((r) => r.engine === "openai").errorCode,
      "INVALID_RESPONSE",
    );
  });

for (const body of [
  { responses: [{ safeSearchAnnotation: null }] },
  { responses: [{ safeSearchAnnotation: { adult: "UNKNOWN" } }] },
  { responses: [] },
  { responses: [{ error: { message: "secret raw provider output" } }] },
])
  test("Vision unknown/missing/error cannot become PASS", async () => {
    const base = configuration();
    const { moderator } = configuration({
      fetcher: (url, init) =>
        url.includes("vision") ? json(body) : base.fetcher(url, init),
    });
    const result = await moderator.moderate(photo());
    assert.equal(result.decision, "HELD");
    assert.ok(!JSON.stringify(result).includes("secret raw provider output"));
  });

for (const full of [null, { text: null }, { text: "x".repeat(32769) }])
  test("invalid or oversized OCR fails closed without forwarding text", async () => {
    const base = configuration();
    const { moderator } = configuration({
      fetcher: (url, init) =>
        url.includes("vision") && init.body.includes("DOCUMENT_TEXT")
          ? json({ responses: [{ fullTextAnnotation: full }] })
          : base.fetcher(url, init),
    });
    assert.equal((await moderator.moderate(photo())).decision, "HELD");
    assert.ok(base.calls.every((c) => typeof c.body.input !== "string"));
  });

for (const [name, response] of [
  [
    "redirect",
    () =>
      new Response(null, {
        status: 307,
        headers: { location: "https://attacker.invalid" },
      }),
  ],
  [
    "non-json",
    () =>
      new Response("<script>secret</script>", {
        headers: { "content-type": "text/html" },
      }),
  ],
  [
    "oversized declaration",
    () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": "262145",
        },
      }),
  ],
  [
    "oversized actual body",
    () =>
      new Response("x".repeat(262145), {
        headers: { "content-type": "application/json" },
      }),
  ],
  [
    "invalid UTF8",
    () =>
      new Response(Uint8Array.from([0xff]), {
        headers: { "content-type": "application/json" },
      }),
  ],
  [
    "bad length",
    () =>
      new Response("{}", {
        headers: { "content-type": "application/json", "content-length": "1" },
      }),
  ],
  [
    "provider unauthorized",
    () => json({ error: "synthetic-secret" }, { status: 401 }),
  ],
])
  test(`HTTP safely rejects ${name} without retry/redirect`, async () => {
    let count = 0;
    const { moderator } = configuration({
      fetcher: async () => {
        count++;
        return response();
      },
    });
    const result = await moderator.moderate(photo());
    assert.equal(result.decision, "HELD");
    assert.equal(count, 3);
    assert.ok(result.runs.every((r) => r.attempt === 1));
    assert.ok(!JSON.stringify(result).includes("synthetic-secret"));
  });

test("transient 5xx retries each engine at most twice; successful engines are not retried", async () => {
  const base = configuration();
  let imageCalls = 0;
  const { moderator } = configuration({
    fetcher: (url, init) => {
      if (
        url.includes("openai") &&
        typeof JSON.parse(init.body).input !== "string"
      ) {
        imageCalls++;
        if (imageCalls < 3)
          return json({ error: "synthetic" }, { status: 503 });
      }
      return base.fetcher(url, init);
    },
  });
  const result = await moderator.moderate(photo());
  assert.equal(result.decision, "PASS");
  assert.equal(imageCalls, 3);
  assert.equal(result.runs.filter((r) => r.engine === "openai").length, 3);
  assert.equal(result.runs.filter((r) => r.engine === "safesearch").length, 1);
});

test("fetch timeout ignores uncancellable promises, returns bounded HELD after max 2 retries", async () => {
  let count = 0;
  const { moderator } = configuration({
    attemptTimeoutMs: 10,
    fetcher: () => {
      count++;
      return new Promise(() => {});
    },
  });
  const result = await moderator.moderate(photo());
  assert.equal(result.decision, "HELD");
  assert.equal(count, 9);
  assert.equal(result.runs.length, 9);
  assert.ok(result.runs.every((r) => r.errorCode === "TIMEOUT"));
});

test("streaming body timeout is bounded and cancelled", async () => {
  let cancelled = 0;
  const { moderator } = configuration({
    attemptTimeoutMs: 10,
    fetcher: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  assert.equal((await moderator.moderate(photo())).decision, "HELD");
  assert.equal(cancelled, 9);
});

test("quota rejection does not call token/fetch or retry, bounded retryAfter", async () => {
  let tokens = 0;
  const { moderator, calls } = configuration({
    reserveQuota: async () => ({ allowed: false, retryAfterSeconds: 99999 }),
    openaiToken: async () => {
      tokens++;
      return "synthetic";
    },
    visionToken: async () => {
      tokens++;
      return "synthetic";
    },
  });
  const result = await moderator.moderate(photo());
  assert.equal(result.decision, "HELD");
  assert.equal(tokens + calls.length, 0);
  assert.ok(
    result.runs.every(
      (r) =>
        r.errorCode === "QUOTA" &&
        r.retryAfterSeconds === 3600 &&
        r.attempt === 1,
    ),
  );
});

test("HTTP 429 uses quota backpressure, never tight retry", async () => {
  let count = 0;
  const { moderator } = configuration({
    fetcher: async () => {
      count++;
      return json({}, { status: 429, headers: { "retry-after": "12" } });
    },
  });
  const result = await moderator.moderate(photo());
  assert.equal(count, 3);
  assert.ok(
    result.runs.every(
      (r) => r.errorCode === "QUOTA" && r.retryAfterSeconds === 12,
    ),
  );
});

test("invalid credentials cannot inject headers and never fetch", async () => {
  const { moderator, calls } = configuration({
    openaiToken: async () => "key\r\nCookie: secret",
    visionToken: async () => {
      throw Error("secret");
    },
  });
  const result = await moderator.moderate(photo());
  assert.equal(result.decision, "HELD");
  assert.equal(calls.length, 0);
  assert.ok(result.runs.every((r) => r.errorCode === "CREDENTIALS"));
  assert.ok(!JSON.stringify(result).includes("secret"));
});

test("instance concurrency is bounded, abort releases slot without credential leak", async () => {
  const controller = new AbortController();
  const { moderator } = configuration({ fetcher: () => new Promise(() => {}) });
  const first = moderator.moderate(photo(), controller.signal);
  assert.equal((await moderator.moderate(photo())).errorCode, "BUSY");
  controller.abort();
  assert.equal((await first).errorCode, "ABORTED");
  assert.equal(
    (await moderator.moderate(photo(), AbortSignal.abort())).errorCode,
    "ABORTED",
  );
});

test("late quota resolution after timeout never sends media or requests credentials", async () => {
  let tokens = 0;
  const resolvers = [];
  const { moderator, calls } = configuration({
    attemptTimeoutMs: 5,
    reserveQuota: () => new Promise((resolve) => resolvers.push(resolve)),
    openaiToken: async () => {
      tokens++;
      return "synthetic";
    },
    visionToken: async () => {
      tokens++;
      return "synthetic";
    },
  });
  assert.equal((await moderator.moderate(photo())).decision, "HELD");
  for (const resolve of resolvers) resolve({ allowed: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(tokens + calls.length, 0);
});

test("video aggregates one blocked frame across all engines and deduplicates categories", async () => {
  const base = configuration();
  let imageCalls = 0;
  const { moderator } = configuration({
    fetcher: (url, init) => {
      if (
        url.includes("openai") &&
        typeof JSON.parse(init.body).input !== "string"
      ) {
        const result = openai("image");
        result.results[0].category_scores.sexual =
          ++imageCalls === 2 ? 0.9 : 0.6;
        return json(result);
      }
      return base.fetcher(url, init);
    },
  });
  const result = await moderator.moderate(video());
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.runs.length, 9);
  assert.deepEqual(result.categories, [
    { engine: "openai", category: "sexual", decision: "BLOCK" },
  ]);
});

test("known BLOCK is retained when another engine is cancelled", async () => {
  const controller = new AbortController();
  const { moderator } = configuration({
    fetcher: (url) => {
      if (url.includes("openai")) {
        const result = openai("image");
        result.results[0].category_scores.sexual = 0.9;
        return json(result);
      }
      return new Promise(() => {});
    },
  });
  const pending = moderator.moderate(photo(), controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  const result = await pending;
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.errorCode, "ABORTED");
});

test("OCR and image rejection cannot mask SafeSearch FLAG ordinal evidence", async () => {
  const base = configuration();
  const { moderator } = configuration({
    fetcher: (url, init) => {
      if (url.includes("vision") && init.body.includes("SAFE_SEARCH")) {
        const result = safe();
        result.responses[0].safeSearchAnnotation.racy = "POSSIBLE";
        return json(result);
      }
      return base.fetcher(url, init);
    },
  });
  const result = await moderator.moderate(photo());
  assert.equal(result.decision, "FLAG");
  assert.equal(
    result.runs.find((r) => r.engine === "safesearch").scores.racy,
    0.5,
  );
});

test("frozen policy and copied input survive mutations during quota wait", async () => {
  const p = policy();
  const m = photo();
  const resolvers = [];
  const { moderator } = configuration({
    policy: p,
    reserveQuota: () => new Promise((resolve) => resolvers.push(resolve)),
  });
  const pending = moderator.moderate(m);
  p.thresholds[0].block = 0;
  m.image.bytes.fill(0);
  m.image.width = 10000;
  for (const resolve of resolvers) resolve({ allowed: true });
  // OCR's second provider call also reserves quota; wait for its queued microtasks.
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (const resolve of resolvers) resolve({ allowed: true });
  const result = await pending;
  assert.equal(result.decision, "PASS");
});

test("response content-encoding cannot undermine decoded body size accounting", async () => {
  const { moderator } = configuration({
    fetcher: async () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
      }),
  });
  const result = await moderator.moderate(photo());
  assert.ok(result.runs.every((r) => r.errorCode === "INVALID_RESPONSE"));
});

test("missing OCR modality metadata fails closed rather than trusting zero scores", async () => {
  const base = configuration();
  const { moderator } = configuration({
    fetcher: (url, init) => {
      if (
        url.includes("openai") &&
        typeof JSON.parse(init.body).input === "string"
      ) {
        const result = openai("text");
        result.results[0].category_applied_input_types["sexual/minors"] = [];
        return json(result);
      }
      return base.fetcher(url, init);
    },
  });
  const result = await moderator.moderate(photo());
  assert.equal(result.decision, "HELD");
  assert.equal(
    result.runs.find((r) => r.engine === "ocr").errorCode,
    "INVALID_RESPONSE",
  );
});

for (const [code, expected] of [
  [8, "QUOTA"],
  [7, "PROVIDER_REJECTED"],
  [16, "PROVIDER_REJECTED"],
  [3, "PROVIDER_REJECTED"],
  [14, "PROVIDER_UNAVAILABLE"],
])
  test(`Vision per-image status ${code} is safely classified`, async () => {
    const base = configuration();
    const { moderator } = configuration({
      fetcher: (url, init) =>
        url.includes("vision")
          ? json({
              responses: [
                { error: { code, message: "private provider message" } },
              ],
            })
          : base.fetcher(url, init),
    });
    const result = await moderator.moderate(photo());
    const runs = result.runs.filter((r) => r.engine === "safesearch");
    assert.equal(result.decision, "HELD");
    assert.ok(runs.every((r) => r.errorCode === expected));
    assert.equal(runs.length, code === 14 ? 3 : 1);
    assert.ok(!JSON.stringify(result).includes("private provider message"));
  });
