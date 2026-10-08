import assert from "node:assert/strict";
import { test } from "node:test";
const { Buffer, AbortController, URL, Request } = globalThis;
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import { createImageDatabase } from "../dist/db.js";
import { createImageRunner } from "../dist/runner.js";
import { createModerationDatabase } from "../dist/moderation-db.js";
import { createImageService } from "../dist/service.js";
import { moderationCategories } from "../dist/moderation.js";
import { createModerationRunner } from "../dist/moderation-runner.js";
import { job, input, hash, outputs } from "./processing-fixture.mjs";
import { moderationPlan, held } from "./moderation-fixture.mjs";
import { policy, costRates } from "./moderation-fixture.mjs";
import { uuid, url, key, json } from "./processing-fixture.mjs";
function harness(overrides = {}) {
  const calls = [];
  const p = moderationPlan();
  const database = {
    claim: async () => ({ code: "CLAIMED", plan: p }),
    check: async () => {
      calls.push("check");
      return true;
    },
    reserve: async (_p, r) => {
      calls.push({ reserve: r });
      return { allowed: true };
    },
    fail: async (_p, reason) => {
      calls.push({ failure: reason });
      return { code: "HELD" };
    },
    finish: async (_p, result) => {
      calls.push({ finish: result });
      return { code: "RECORDED" };
    },
    ...overrides.database,
  };
  const runner = createModerationRunner({
    enabled: true,
    getOriginal: async (ref) => {
      calls.push({ read: ref });
      return { bytes: input, sha256: hash(input) };
    },
    transform: async () => {
      calls.push("transform");
      return { ok: true, derivatives: outputs() };
    },
    openaiToken: async () => "fixture-openai",
    visionToken: async () => "fixture-vision",
    moderatorFactory: (opts) => ({
      moderate: async (media) => {
        calls.push({ media });
        assert.deepEqual(opts.attemptStarts, p.attemptStarts);
        await opts.reserveQuota({
          provider: "openai",
          feature: "openai",
          frame: 0,
          attempt: 1,
          units: 1,
          signal: new AbortController().signal,
        });
        await opts.openaiToken(new AbortController().signal);
        return held();
      },
    }),
    ...overrides,
    database,
  });
  return { runner, calls, p };
}
test("runner default OFF and requires all capabilities", () => {
  assert.equal(createModerationRunner(), null);
  assert.throws(
    () => createModerationRunner({ enabled: true }),
    /INVALID_MODERATION_RUNNER_CONFIG/,
  );
});

test("AI preprocessing decode failure is durably held without forged provider runs; transient DB refusal stays unconfirmed", async () => {
  for (const transform of [
    async () => ({ ok: false, reason: "DECODE_FAILED" }),
    async () => {
      throw new Error("secret decoder trace");
    },
  ]) {
    const h = harness({ transform });
    assert.deepEqual(await h.runner.run(job), {
      ok: false,
      reason: "DECODE_FAILED",
    });
    assert.equal(
      h.calls.filter((x) => x.failure === "DECODE_FAILED").length,
      1,
    );
    assert.ok(!h.calls.some((x) => x.media || x.finish));
  }
  const stale = harness({
    transform: async () => ({ ok: false, reason: "DECODE_FAILED" }),
    database: { fail: async () => ({ code: "STALE" }) },
  });
  assert.deepEqual(await stale.runner.run(job), { ok: false, reason: "STALE" });
  const bad = harness({
    transform: async () => ({ ok: false, reason: "DECODE_FAILED" }),
    database: {
      fail: async () => {
        throw new Error("secret");
      },
    },
  });
  assert.deepEqual(await bad.runner.run(job), {
    ok: false,
    reason: "PROCESSING_FAILED",
  });
  const held = harness({ database: { claim: async () => ({ code: "HELD" }) } });
  assert.deepEqual(await held.runner.run(job), {
    ok: false,
    reason: "PROCESSING_FAILED",
  });
  assert.equal(held.calls.length, 0);
});
test("photo recovery reads exact original without version field, transforms only in memory and returns no bytes", async () => {
  const h = harness();
  const result = await h.runner.run(job);
  assert.deepEqual(result, { ok: true, outcome: "moderation_recorded" });
  const ref = h.calls.find((x) => x.read).read;
  assert.equal(ref.sha256, hash(input));
  assert.ok(!("objectVersion" in ref));
  assert.equal(h.calls.filter((x) => x === "transform").length, 1);
  assert.equal(h.calls.find((x) => x.media).media.kind, "photo");
  assert.equal(h.calls.filter((x) => x.finish).length, 1);
  assert.ok(!JSON.stringify(result).includes("bytes"));
});
test("initial uploaded work executes image stage only after authoritative refusal then recliams", async () => {
  let claim = 0,
    image = 0;
  const p = moderationPlan();
  const h = harness({
    database: {
      claim: async () =>
        ++claim === 1 ? { code: "STALE" } : { code: "CLAIMED", plan: p },
    },
    imageRun: async () => {
      image++;
      return {
        ok: true,
        outcome: "image_recorded",
        ai: { bytes: "must-not-use" },
      };
    },
  });
  assert.equal((await h.runner.run(job)).ok, true);
  assert.equal(image, 1);
  assert.equal(claim, 2);
});
test("durable completed result avoids all storage/AI work", async () => {
  const h = harness({ database: { claim: async () => ({ code: "DONE" }) } });
  assert.deepEqual(await h.runner.run(job), {
    ok: true,
    outcome: "moderation_already_recorded",
  });
  assert.deepEqual(h.calls, []);
});
for (const code of ["BUSY", "POLICY_UNAPPROVED", "MEDIA_NOT_READY"])
  test(`claim ${code} cannot invoke AI`, async () => {
    const h = harness({ database: { claim: async () => ({ code }) } });
    assert.deepEqual(await h.runner.run(job), { ok: false, reason: code });
    assert.deepEqual(h.calls, []);
  });
test("changing owner/consent/BAN between read and decode rejects before provider work", async () => {
  let count = 0;
  const h = harness({ database: { check: async () => ++count < 2 } });
  assert.equal((await h.runner.run(job)).reason, "STALE");
  assert.ok(!h.calls.some((x) => x.media));
  assert.ok(!h.calls.some((x) => x.finish));
});
test("original or AI checksum corruption never sends provider data", async () => {
  for (const overrides of [
    {
      getOriginal: async () => ({
        bytes: Buffer.from("changed"),
        sha256: hash(input),
      }),
    },
    {
      transform: async () => ({
        ok: true,
        derivatives: outputs().map((d) => ({ ...d, sha256: "a".repeat(64) })),
      }),
    },
  ]) {
    const h = harness(overrides);
    assert.equal((await h.runner.run(job)).ok, false);
    assert.ok(!h.calls.some((x) => x.media));
  }
});
test("unfinished DB commit never reports completion; exceptions are fixed codes", async () => {
  const stale = harness({
    database: { finish: async () => ({ code: "STALE" }) },
  });
  assert.deepEqual(await stale.runner.run(job), { ok: false, reason: "STALE" });
  const broken = harness({
    database: {
      finish: async () => {
        throw new Error("secret");
      },
    },
  });
  assert.deepEqual(await broken.runner.run(job), {
    ok: false,
    reason: "PROCESSING_FAILED",
  });
});
test("no fallback image retry on unapproved policy", async () => {
  let count = 0;
  const h = harness({
    database: { claim: async () => ({ code: "POLICY_UNAPPROVED" }) },
    imageRun: async () => {
      count++;
    },
  });
  await h.runner.run(job);
  assert.equal(count, 0);
});
test("video uses three private snapshots and transforms every frame before AI", async () => {
  const p = moderationPlan("video");
  let seen;
  const h = harness({
    database: { claim: async () => ({ code: "CLAIMED", plan: p }) },
    getOriginal: async () => {
      throw new Error("video must not read original");
    },
    getVideoFrames: async () => ({
      streamAssetId: p.media.streamAssetId,
      postVersion: p.postVersion,
      measuredDurationSeconds: 3,
      requireSignedURLs: true,
      readyToStream: true,
      processingComplete: true,
      frames: p.media.frameTimes.map((seconds, index) => ({
        index,
        seconds,
        bytes: input,
        sha256: hash(input),
      })),
    }),
    moderatorFactory: () => ({
      moderate: async (media) => {
        seen = media;
        return held();
      },
    }),
  });
  assert.equal((await h.runner.run(job)).ok, true);
  assert.equal(seen.kind, "video");
  assert.equal(seen.frames.length, 3);
  assert.equal(h.calls.filter((x) => x === "transform").length, 3);
});
test("missing video adapter fails closed", async () => {
  const h = harness({
    database: {
      claim: async () => ({ code: "CLAIMED", plan: moderationPlan("video") }),
    },
  });
  assert.deepEqual(await h.runner.run(job), {
    ok: false,
    reason: "MEDIA_NOT_READY",
  });
});
test("abort and in-process concurrency never publish", async () => {
  let release;
  const h = harness({
    database: {
      claim: () =>
        new Promise((r) => {
          release = r;
        }),
    },
  });
  const controller = new AbortController();
  const first = h.runner.run(job, controller.signal);
  await Promise.resolve();
  assert.equal((await h.runner.run(job)).reason, "BUSY");
  controller.abort();
  assert.equal((await first).ok, false);
  release({ code: "DONE" });
});

for (const scenario of [
  "publish",
  "priced_publish",
  "image_decode_failure",
  "ai_decode_failure",
])
  test(`real SQL + HTTP + image + decode + provider mocks: ${scenario}`, async () => {
    const db = new PGlite();
    const original = await sharp({
      create: { width: 24, height: 16, channels: 3, background: "#735baa" },
    })
      .jpeg()
      .toBuffer();
    try {
      await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
      GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,service_role;`);
      const dir = new URL("../../api/supabase/migrations/", import.meta.url);
      for (const name of (await readdir(dir))
        .filter((x) => x.endsWith(".sql"))
        .sort())
        await db.exec(await readFile(new URL(name, dir), "utf8"));
      await db.query("INSERT INTO auth.users VALUES($1)", [uuid(90)]);
      await db.query(
        `INSERT INTO public.events(event_id,slug,name,status,starts_at,ends_at,archive_at,private_at,terms_version)
      VALUES($1,'test','Synthetic','live',now()-interval '1 hour',now()+interval '1 hour',now()+interval '2 hours',now()+interval '3 hours','fixture')`,
        [job.eventId],
      );
      await db.query(
        "INSERT INTO public.event_settings(event_id,publication_stopped,uploads_enabled,thresholds_approved,moderation_thresholds,moderation_concurrency) VALUES($1,false,true,true,$2,1)",
        [job.eventId, JSON.stringify(policy().thresholds)],
      );
      if (scenario === "priced_publish") {
        const card = costRates();
        const dates = (
          await db.query(
            "SELECT to_char((now() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') verified, to_char((now() AT TIME ZONE 'UTC')::date+30,'YYYY-MM-DD') expiry",
          )
        ).rows[0];
        card.verifiedOn = dates.verified;
        card.validUntil = dates.expiry;
        await db.query(
          "UPDATE public.event_settings SET moderation_cost_rates=$1",
          [JSON.stringify(card)],
        );
      }
      await db.query(
        "INSERT INTO public.event_members(event_id,user_id,display_name) VALUES($1,$2,'Synthetic')",
        [job.eventId, uuid(90)],
      );
      await db.query(
        "INSERT INTO public.consents(event_id,user_id,terms_version) VALUES($1,$2,'fixture')",
        [job.eventId, uuid(90)],
      );
      await db.query(
        `INSERT INTO public.posts(event_id,id,user_id,kind,client_request_id,declared_content_type,original_scope,status,version,original_bytes)
      VALUES($1,$2,$3,'photo',$2,'image/jpeg','photo_file','uploaded',2,$4)`,
        [job.eventId, job.postId, uuid(90), original.length],
      );
      await db.query(
        `INSERT INTO public.media_assets(event_id,id,post_id,purpose,provider,object_key,byte_size,object_etag,object_version)
      VALUES($1,$2,$3,'original','r2_original',$4,$5,$6,'object-v1')`,
        [
          job.eventId,
          uuid(3),
          job.postId,
          `events/${job.eventId}/posts/${job.postId}/original/${uuid(3)}.bin`,
          original.length,
          hash(original, "md5"),
        ],
      );
      await db.query(
        "INSERT INTO public.outbox_jobs(event_id,id,post_id,kind,deduplication_key,payload) VALUES($1,$2,$3,'process_media','fixture',$4)",
        [
          job.eventId,
          job.jobId,
          job.postId,
          JSON.stringify({
            asset_id: uuid(3),
            post_version: 2,
            object_etag: hash(original, "md5"),
            object_version: "object-v1",
          }),
        ],
      );
      await db.exec(
        "INSERT INTO koko_private.moderation_budgets(provider,approved,calls_per_minute) VALUES('openai',true,100),('vision',true,100)",
      );
      const trace = [];
      const dbFetch = async (endpoint, init) => {
        const body = JSON.parse(init.body);
        const func = endpoint.endsWith("manage_media_moderation")
          ? "manage_media_moderation"
          : "manage_image_processing";
        await db.exec("SET ROLE service_role");
        try {
          const result = (
            await db.query(`SELECT public.${func}($1,$2,$3,$4,$5) result`, [
              body.p_event_id,
              body.p_post_id,
              body.p_job_id,
              body.p_action,
              JSON.stringify(body.p_input),
            ])
          ).rows[0].result;
          trace.push([func, body.p_action, result.code]);
          return json(result);
        } finally {
          await db.exec("RESET ROLE");
        }
      };
      let reads = 0,
        puts = 0,
        providerCalls = 0;
      const store = {
        getOriginal: async () => {
          reads++;
          return { bytes: original, sha256: hash(original) };
        },
        putDelivery: async (_ref, d) => {
          puts++;
          return { outcome: "stored", size: d.bytes.length, sha256: d.sha256 };
        },
      };
      const initial = createImageRunner({
        enabled: true,
        ...(scenario === "image_decode_failure"
          ? { transform: async () => ({ ok: false, reason: "DECODE_FAILED" }) }
          : {}),
        database: createImageDatabase({
          enabled: true,
          supabaseUrl: url,
          secretKey: key,
          fetcher: dbFetch,
        }),
        store,
      });
      const database = createModerationDatabase({
        enabled: true,
        supabaseUrl: url,
        secretKey: key,
        fetcher: dbFetch,
      });
      const full = createModerationRunner({
        enabled: true,
        ...(scenario === "ai_decode_failure"
          ? { transform: async () => ({ ok: false, reason: "DECODE_FAILED" }) }
          : {}),
        database,
        imageRun: initial.run,
        getOriginal: store.getOriginal,
        openaiToken: async () => "fixture_openai",
        visionToken: async () => "fixture_vision",
        providerFetch: async (endpoint, init) => {
          providerCalls++;
          const request = JSON.parse(init.body);
          if (endpoint.includes("openai.com"))
            return json({
              model: "omni-moderation-2024-09-26",
              results: [
                {
                  flagged: false,
                  category_scores: Object.fromEntries(
                    moderationCategories.ocr.map((c) => [c, 0]),
                  ),
                  categories: Object.fromEntries(
                    moderationCategories.ocr.map((c) => [c, false]),
                  ),
                  category_applied_input_types: Object.fromEntries(
                    moderationCategories.ocr.map((c) => [
                      c,
                      moderationCategories.openai.includes(c) ? ["image"] : [],
                    ]),
                  ),
                },
              ],
            });
          return json({
            responses: [
              request.requests[0].features[0].type === "SAFE_SEARCH_DETECTION"
                ? {
                    safeSearchAnnotation: Object.fromEntries(
                      moderationCategories.safesearch.map((c) => [
                        c,
                        "VERY_UNLIKELY",
                      ]),
                    ),
                  }
                : {},
            ],
          });
        },
      });
      let fullResult;
      const service = createImageService({
        enabled: true,
        authenticate: async () => true,
        run: initial.run,
        processEnabled: true,
        processRun: async (...args) => {
          fullResult = await full.run(...args);
          return fullResult;
        },
      });
      const request = () =>
        new Request("http://test/internal/process", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(job),
        });
      const response = await service(request());
      if (!["publish", "priced_publish"].includes(scenario)) {
        assert.notEqual(response.status, 200);
        const post = (
          await db.query(
            "SELECT status,moderation_verdict,processing_error,ban_latched FROM public.posts WHERE id=$1",
            [job.postId],
          )
        ).rows[0];
        assert.equal(post.status, "held");
        assert.equal(post.moderation_verdict, null);
        assert.equal(post.ban_latched, false);
        assert.equal(
          post.processing_error,
          scenario === "image_decode_failure"
            ? "IMAGE_DECODE_FAILED"
            : "AI_PREPROCESSING_DECODE_FAILED",
        );
        assert.equal(providerCalls, 0);
        assert.equal(puts, scenario === "image_decode_failure" ? 0 : 4);
        assert.equal(
          (await db.query("SELECT count(*)::int n FROM public.moderation_runs"))
            .rows[0].n,
          0,
        );
        const state = (
          await db.query(
            "SELECT public.media_processing_status($1,$2,$3,$4,$5) r",
            [job.eventId, job.postId, job.jobId, uuid(3), 2],
          )
        ).rows[0].r;
        assert.equal(state.code, "HELD");
        const assets = (
          await db.query(
            "SELECT * FROM public.media_assets WHERE purpose='original'",
          )
        ).rows;
        assert.equal(assets.length, 1);
        assert.equal(assets[0].deletion_requested_at, null);
        assert.equal(assets[0].physically_deleted_at, null);
        const beforeReads = reads;
        await service(request());
        assert.equal(reads, beforeReads);
        assert.equal(providerCalls, 0);
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::int n FROM public.outbox_jobs WHERE kind='notify'",
            )
          ).rows[0].n,
          1,
        );
        return;
      }
      assert.equal(response.status, 200, JSON.stringify({ fullResult, trace }));
      assert.equal((await response.json()).processComplete, true);
      assert.equal(
        (
          await db.query("SELECT status FROM public.posts WHERE id=$1", [
            job.postId,
          ])
        ).rows[0].status,
        "published",
      );
      assert.equal(puts, 4);
      assert.equal(reads, 2);
      assert.equal(providerCalls, 3);
      const costs = (
        await db.query(
          "SELECT engine,estimated_cost_usd,cost_rate_card FROM public.moderation_runs ORDER BY engine",
        )
      ).rows;
      if (scenario === "priced_publish") {
        assert.deepEqual(
          costs.map((r) => [r.engine, Number(r.estimated_cost_usd)]),
          [
            ["ocr", 0.0015],
            ["openai", 0],
            ["safesearch", 0.0015],
          ],
        );
        assert.ok(costs.every((r) => r.cost_rate_card.version === 1));
      } else
        assert.ok(
          costs.every(
            (r) => r.estimated_cost_usd === null && r.cost_rate_card === null,
          ),
        );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::integer n FROM public.moderation_runs",
          )
        ).rows[0].n,
        3,
      );
      assert.equal((await service(request())).status, 200);
      assert.equal(puts, 4);
      assert.equal(reads, 2);
      assert.equal(providerCalls, 3);
    } finally {
      await db.close();
    }
  });
