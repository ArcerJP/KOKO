import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const event = "11111111-1111-4111-8111-111111111111";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const post = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const asset = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const job = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const etag = "a".repeat(32);
const engines = ["openai", "safesearch", "ocr"];
let thresholds;
before(async () => {
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,service_role;`);
  const dir = new URL(
    "../../../apps/api/supabase/migrations/",
    import.meta.url,
  );
  for (const file of (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(await readFile(new URL(file, dir), "utf8"));
  thresholds = [];
  for (const engine of engines) {
    const { rows } = await db.query(
      "SELECT koko_private.moderation_categories($1) categories",
      [engine],
    );
    for (const category of rows[0].categories)
      thresholds.push({
        engine,
        category,
        flag: 0.5,
        block: 0.8,
        immediate_ban: category === "violence/graphic",
      });
  }
});
beforeEach(async () => {
  await db.exec(
    "RESET ROLE; TRUNCATE public.events,auth.users,koko_private.moderation_budgets CASCADE",
  );
  await db.query("INSERT INTO auth.users VALUES($1)", [owner]);
  await db.query(
    `INSERT INTO public.events(event_id,slug,name,status,starts_at,ends_at,archive_at,private_at,terms_version)
    VALUES($1,'fixture','Fixture','live',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days',now()+interval '3 days','test')`,
    [event],
  );
  await db.query(
    "INSERT INTO public.event_settings(event_id,publication_stopped,uploads_enabled,thresholds_approved,moderation_thresholds,moderation_concurrency) VALUES($1,false,true,true,$2,2)",
    [event, JSON.stringify(thresholds)],
  );
  await db.query(
    "INSERT INTO public.event_members(event_id,user_id,display_name) VALUES($1,$2,'Synthetic')",
    [event, owner],
  );
  await db.query(
    "INSERT INTO public.consents(event_id,user_id,terms_version) VALUES($1,$2,'test')",
    [event, owner],
  );
  await db.query(
    `INSERT INTO public.posts(event_id,id,user_id,kind,client_request_id,declared_content_type,original_scope,status,version,original_bytes)
    VALUES($1,$2,$3,'photo',$2,'image/heic','photo_file','uploaded',2,100)`,
    [event, post, owner],
  );
  await db.query(
    `INSERT INTO public.media_assets(event_id,id,post_id,purpose,provider,object_key,byte_size,object_etag,object_version)
    VALUES($1,$2,$3,'original','r2_original',$4,100,$5,'object-v1')`,
    [
      event,
      asset,
      post,
      `events/${event}/posts/${post}/original/${asset}.bin`,
      etag,
    ],
  );
  await db.query(
    `INSERT INTO public.outbox_jobs(event_id,id,post_id,kind,deduplication_key,payload)
    VALUES($1,$2,$3,'process_media','fixture',$4)`,
    [
      event,
      job,
      post,
      JSON.stringify({
        asset_id: asset,
        post_version: 2,
        object_etag: etag,
        object_version: "object-v1",
      }),
    ],
  );
  await db.exec(
    "INSERT INTO koko_private.moderation_budgets(provider,approved,calls_per_minute) VALUES('openai',true,100),('vision',true,100)",
  );
  const image = (await rpc("claim", {}, { image: true })).plan;
  assert.equal(
    (
      await rpc(
        "finish",
        {
          plan: image,
          originalSha256: "b".repeat(64),
          deliveries: image.deliveries.map((d, i) => ({
            ...d,
            outcome: "stored",
            sha256: String(i + 1).repeat(64),
            size: 20 + i,
            width: Number(d.variant),
            height: 400,
          })),
        },
        { image: true },
      )
    ).code,
    "RECORDED",
  );
});
after(async () => db.close());
async function rpc(action, input = {}, options = {}) {
  const role = options.role ?? "service_role";
  assert.ok(["anon", "authenticated", "service_role"].includes(role));
  await db.exec(`SET ROLE ${role}`);
  try {
    return (
      await db.query(
        `SELECT public.${options.image ? "manage_image_processing" : "manage_media_moderation"}($1,$2,$3,$4,$5) result`,
        [
          options.event ?? event,
          options.post ?? post,
          options.job ?? job,
          action,
          JSON.stringify(input),
        ],
      )
    ).rows[0].result;
  } finally {
    await db.exec("RESET ROLE");
  }
}
const row = async (table, id = post) =>
  (
    await db.query(
      `SELECT * FROM public.${table} WHERE ${table === "event_members" ? "user_id" : "id"}=$1`,
      [id],
    )
  ).rows[0];
const claim = async (options) => rpc("claim", {}, options);

test("AI preprocessing failure is private held with original/image receipt retained and no violation/AI fiction", async () => {
  const original = await row("media_assets", asset);
  const image = (await row("outbox_jobs", job)).image_receipt;
  const plan = (await claim()).plan;
  assert.equal(
    (await rpc("fail", { plan, reason: "DECODE_FAILED" })).code,
    "HELD",
  );
  const p = await row("posts"),
    j = await row("outbox_jobs", job),
    member = await row("event_members", owner);
  assert.equal(p.status, "held");
  assert.equal(p.processing_error, "AI_PREPROCESSING_DECODE_FAILED");
  assert.equal(p.moderation_verdict, null);
  assert.ok(j.completed_at);
  assert.equal(j.moderation_completed_at, null);
  assert.equal(j.moderation_receipt, null);
  assert.deepEqual(j.image_receipt, image);
  assert.deepEqual(await row("media_assets", asset), original);
  assert.equal(member.block_count, 0);
  assert.equal(member.is_banned, false);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM public.moderation_runs"))
      .rows[0].n,
    0,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM public.outbox_jobs WHERE kind='notify' AND payload->>'category'='processing_error'",
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await rpc("fail", { plan, reason: "DECODE_FAILED" })).code,
    "STALE",
  );
});

for (const change of ["lease", "expired", "ban", "delete", "version", "policy"])
  test(`preprocessing failure cannot settle ${change}`, async () => {
    const plan = (await claim()).plan;
    if (change === "lease") plan.leaseId = randomUUID();
    if (change === "expired")
      await db.exec(
        "UPDATE public.outbox_jobs SET moderation_plan=jsonb_set(moderation_plan,'{expiresAt}','1') WHERE moderation_plan IS NOT NULL",
      );
    if (change === "ban")
      await db.exec(
        "UPDATE public.event_members SET is_banned=true,banned_at=now()",
      );
    if (change === "delete")
      await db.exec(
        "UPDATE public.posts SET status='deleted',deleted_at=now()",
      );
    if (change === "version")
      await db.exec("UPDATE public.posts SET version=version+1");
    if (change === "policy")
      await db.exec(
        "UPDATE public.event_settings SET thresholds_approved=false",
      );
    assert.equal(
      (await rpc("fail", { plan, reason: "DECODE_FAILED" })).code,
      change === "policy" ? "POLICY_UNAPPROVED" : "STALE",
    );
    assert.equal(
      (await row("outbox_jobs", job)).processing_failure_receipt,
      null,
    );
  });

test("three abandoned moderation leases converge on a separate processing hold, never a violation", async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal((await claim()).code, "CLAIMED");
    await db.exec(
      "UPDATE public.outbox_jobs SET moderation_plan=jsonb_set(moderation_plan,'{expiresAt}','1') WHERE moderation_plan IS NOT NULL",
    );
  }
  assert.equal((await claim()).code, "HELD");
  assert.equal(
    (await row("posts")).processing_error,
    "AI_PREPROCESSING_RETRY_EXHAUSTED",
  );
  assert.equal((await row("event_members", owner)).block_count, 0);
  assert.ok((await row("outbox_jobs", job)).completed_at);
});

test("manual retry after AI preprocessing failure retains image proof and obtains a new moderation lease", async () => {
  const old = (await claim()).plan;
  await rpc("fail", { plan: old, reason: "DECODE_FAILED" });
  await db.exec("UPDATE public.event_members SET role='admin'");
  const response = (
    await db.query(
      "SELECT public.stage_three_operation($1,$2,'retry',$3,$4,$5) r",
      [
        event,
        owner,
        post,
        JSON.stringify({ expected_version: 4, reason: "Synthetic retry" }),
        randomUUID(),
      ],
    )
  ).rows[0].r;
  assert.equal(response.code, "ok");
  const next = (
    await db.query(
      "SELECT id FROM public.outbox_jobs WHERE kind='process_media' AND completed_at IS NULL",
    )
  ).rows[0].id;
  const found = await claim({ job: next });
  assert.equal(found.code, "CLAIMED");
  assert.equal(found.plan.postVersion, 5);
  assert.notEqual(found.plan.leaseId, old.leaseId);
  assert.deepEqual(found.plan.media, old.media);
  assert.equal(
    (await rpc("fail", { plan: old, reason: "DECODE_FAILED" })).code,
    "STALE",
  );
});
const reserve = (
  plan,
  engine,
  frame = 0,
  attempt = 1,
  provider = engine === "openai" ? "openai" : "vision",
  options = {},
) => rpc("reserve", { plan, engine, frame, attempt, provider }, options);
function run(
  engine,
  { frame = 0, attempt = 1, category, score = 0.9, error } = {},
) {
  const scores = Object.fromEntries(
    thresholds
      .filter((t) => t.engine === engine)
      .map((t) => [t.category, t.category === category ? score : 0]),
  );
  const decision = error
    ? "ERROR"
    : category
      ? score >= 0.8
        ? "BLOCK"
        : "FLAG"
      : "PASS";
  return {
    engine,
    frame,
    attempt,
    decision,
    modelVersion:
      engine === "openai"
        ? "omni-moderation-2024-09-26"
        : engine === "safesearch"
          ? "vision-v1/builtin-stable/unreported/likelihood-ordinal-v1"
          : "vision-v1/builtin-stable/unreported+omni-moderation-2024-09-26",
    scores: error ? {} : scores,
    latencyMs: 10,
    usage: {
      openaiRequests: !error && engine !== "safesearch" ? 1 : 0,
      safeSearchImages: !error && engine === "safesearch" ? 1 : 0,
      ocrImages: !error && engine === "ocr" ? 1 : 0,
    },
    estimatedCostUsd: null,
    observation: error ? "error" : "scores",
    ...(error ? { errorCode: error } : {}),
  };
}
function result(runs = engines.map((e) => run(e)), frameCount = 1, errorCode) {
  const categories = new Map();
  let immediateBan = false;
  const finals = engines.map((engine) => {
    const values = Array.from({ length: frameCount }, (_, frame) =>
      runs.filter((r) => r.engine === engine && r.frame === frame).at(-1),
    );
    for (const r of values.filter(Boolean))
      for (const t of thresholds.filter((t) => t.engine === engine)) {
        if (r.scores[t.category] >= t.flag) {
          const decision = r.scores[t.category] >= t.block ? "BLOCK" : "FLAG";
          const key = engine + t.category;
          if (categories.get(key)?.decision !== "BLOCK")
            categories.set(key, { engine, category: t.category, decision });
          if (decision === "BLOCK") immediateBan ||= t.immediate_ban;
        }
      }
    return {
      engine,
      decision: values.some((r) => r?.decision === "BLOCK")
        ? "BLOCK"
        : errorCode === "ABORTED" ||
            values.some((r) => !r || r.decision === "ERROR")
          ? "ERROR"
          : values.some((r) => r.decision === "FLAG")
            ? "FLAG"
            : "PASS",
    };
  });
  return {
    decision: finals.some((e) => e.decision === "BLOCK")
      ? "BLOCK"
      : finals.some((e) => e.decision === "ERROR")
        ? "HELD"
        : finals.some((e) => e.decision === "FLAG")
          ? "FLAG"
          : "PASS",
    policyVersion: 1,
    engines: finals,
    runs,
    categories: [...categories.values()],
    immediateBan,
    ...(errorCode ? { errorCode } : {}),
  };
}
async function finish(plan, evidence = result(), options = {}) {
  for (const r of evidence.runs) {
    if (r.usage.safeSearchImages || r.usage.ocrImages)
      assert.equal(
        (await reserve(plan, r.engine, r.frame, r.attempt, "vision", options))
          .allowed,
        true,
      );
    if (r.usage.openaiRequests)
      assert.equal(
        (await reserve(plan, r.engine, r.frame, r.attempt, "openai", options))
          .allowed,
        true,
      );
  }
  return rpc("finish", { plan, result: evidence }, options);
}
async function expire() {
  await db.query(
    "UPDATE public.outbox_jobs SET moderation_plan=jsonb_set(moderation_plan,'{expiresAt}',to_jsonb(floor(extract(epoch FROM clock_timestamp())*1000)::bigint-1)) WHERE id=$1",
    [job],
  );
}
test("service-only operational tables retain fourteen public RLS tables", async () => {
  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(rpc("claim", {}, { role }), (e) => e.code === "42501");
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(
      db.query("SELECT * FROM koko_private.moderation_budgets"),
      (e) => e.code === "42501",
    );
    await db.exec("RESET ROLE");
  }
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::integer n FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity",
      )
    ).rows[0].n,
    14,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::integer n FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='koko_private' AND c.relkind='r' AND c.relrowsecurity",
      )
    ).rows[0].n,
    2,
  );
});
test("claim snapshots approved policy and read-only original recovery; check and BUSY", async () => {
  const first = await claim();
  assert.equal(first.code, "CLAIMED");
  assert.equal(first.plan.policy.thresholds.length, 24);
  assert.deepEqual(
    first.plan.attemptStarts.map((a) => a.nextAttempt),
    [1, 1, 1],
  );
  assert.equal(first.plan.media.source, "original_read_only");
  assert.equal((await rpc("check", { plan: first.plan })).code, "CURRENT");
  assert.equal((await claim()).code, "BUSY");
  assert.equal((await row("posts")).status, "processing");
});
for (const [name, sql, code] of [
  [
    "unapproved",
    "UPDATE public.event_settings SET thresholds_approved=false",
    "POLICY_UNAPPROVED",
  ],
  [
    "missing category",
    "UPDATE public.event_settings SET moderation_thresholds=moderation_thresholds-0",
    "POLICY_UNAPPROVED",
  ],
  [
    "duplicate",
    "UPDATE public.event_settings SET moderation_thresholds=jsonb_set(moderation_thresholds,'{0}',moderation_thresholds->1)",
    "POLICY_UNAPPROVED",
  ],
  [
    "publication stop",
    "UPDATE public.event_settings SET publication_stopped=true",
    "STALE",
  ],
  [
    "upload stop",
    "UPDATE public.event_settings SET uploads_enabled=false",
    "STALE",
  ],
  ["archived", "UPDATE public.events SET status='archive'", "STALE"],
  ["consent changed", "UPDATE public.events SET terms_version='new'", "STALE"],
  [
    "BAN",
    "UPDATE public.event_members SET is_banned=true,banned_at=now()",
    "STALE",
  ],
  [
    "asset deletion",
    "UPDATE public.media_assets SET deletion_requested_at=now()",
    "STALE",
  ],
  [
    "receipt mismatch",
    "UPDATE public.media_assets SET sha256=repeat('f',64) WHERE purpose='delivery_600_jpg'",
    "MEDIA_NOT_READY",
  ],
])
  test(`${name} fails closed`, async () => {
    await db.exec(sql);
    assert.equal((await claim()).code, code);
  });
test("PASS is derived atomically and replay does not duplicate logs/counters", async () => {
  const { plan } = await claim();
  const evidence = result();
  assert.equal((await finish(plan, evidence)).code, "RECORDED");
  assert.equal((await row("posts")).status, "published");
  assert.equal((await row("event_members", owner)).published_post_count, 1);
  assert.equal(
    (await rpc("finish", { plan, result: evidence })).code,
    "RECORDED",
  );
  assert.equal(
    (await db.query("SELECT count(*)::integer n FROM public.moderation_runs"))
      .rows[0].n,
    3,
  );
  assert.equal((await claim()).code, "DONE");
});
for (const [decision, runs] of [
  [
    "FLAG",
    () => [
      run("openai", { category: "sexual", score: 0.6 }),
      run("safesearch"),
      run("ocr"),
    ],
  ],
  [
    "HELD",
    () => [
      run("openai", { category: "sexual", score: 0.6 }),
      run("safesearch", { error: "TIMEOUT" }),
      run("ocr"),
    ],
  ],
  [
    "BLOCK",
    () => [
      run("openai", { category: "sexual" }),
      run("safesearch", { error: "TIMEOUT" }),
      run("ocr"),
    ],
  ],
])
  test(`${decision}: BLOCK > HELD > FLAG > PASS and notification without deletion`, async () => {
    const { plan } = await claim();
    assert.equal((await finish(plan, result(runs()))).code, "RECORDED");
    assert.equal((await row("posts")).moderation_verdict, decision);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::integer n FROM public.outbox_jobs WHERE kind='notify'",
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::integer n FROM public.outbox_jobs WHERE kind='delete_assets'",
        )
      ).rows[0].n,
      0,
    );
  });
test("severe BLOCK BAN latches previous published posts and updates counters", async () => {
  const extra = randomUUID();
  await db.query(
    `INSERT INTO public.posts(event_id,id,user_id,kind,client_request_id,declared_content_type,original_scope,status,moderation_verdict,published_at)
    VALUES($1,$2,$3,'photo',$2,'image/jpeg','photo_file','published','PASS',now())`,
    [event, extra, owner],
  );
  const { plan } = await claim();
  assert.equal(
    (
      await finish(
        plan,
        result([
          run("openai", { category: "violence/graphic" }),
          run("safesearch"),
          run("ocr"),
        ]),
      )
    ).code,
    "RECORDED",
  );
  const member = await row("event_members", owner);
  assert.equal(member.block_count, 1);
  assert.equal(member.is_banned, true);
  assert.equal(member.published_post_count, 0);
  assert.equal((await row("posts", extra)).status, "hidden");
  assert.equal((await row("posts", extra)).ban_latched, true);
  assert.equal((await row("posts")).status, "blocked");
  const notices = (
    await db.query("SELECT payload FROM public.outbox_jobs WHERE kind='notify'")
  ).rows.map((r) => r.payload);
  assert.equal(
    notices.find((n) => n.category === "block").post_version,
    (await row("posts")).version,
  );
  assert.equal(notices.find((n) => n.category === "ban").user_id, owner);
});
test("third ordinary BLOCK triggers BAN without inventing a retention period", async () => {
  await db.exec("UPDATE public.event_members SET block_count=2");
  const { plan } = await claim();
  await finish(
    plan,
    result([
      run("openai", { category: "sexual" }),
      run("safesearch"),
      run("ocr"),
    ]),
  );
  assert.equal((await row("event_members", owner)).is_banned, true);
  assert.equal((await row("event_members", owner)).block_count, 3);
  assert.equal((await row("media_assets", asset)).deletion_requested_at, null);
});
test("quota reservation is provider-wide, atomic, finite and unknown-safe", async () => {
  const { plan } = await claim();
  await db.exec(
    "UPDATE koko_private.moderation_budgets SET calls_per_minute=1 WHERE provider='openai'",
  );
  assert.equal((await reserve(plan, "openai")).code, "RESERVED");
  assert.equal((await reserve(plan, "openai")).code, "RESERVED_ALREADY");
  assert.equal((await reserve(plan, "ocr")).allowed, true);
  assert.equal((await reserve(plan, "ocr", 0, 1, "openai")).code, "QUOTA");
  await db.exec(
    "DELETE FROM koko_private.moderation_budgets WHERE provider='vision'",
  );
  assert.equal((await reserve(plan, "safesearch")).code, "QUOTA_UNCONFIGURED");
  assert.equal((await reserve(plan, "openai", 0, 4)).code, "INVALID_INPUT");
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::integer n FROM koko_private.moderation_calls",
      )
    ).rows[0].n,
    2,
  );
});

test("different events share the same provider minute quota; rollover preserves consumed job attempts", async () => {
  const originalPlan = (await claim()).plan;
  const other = {
    event: randomUUID(),
    post: randomUUID(),
    job: randomUUID(),
    image: true,
  };
  const otherAsset = randomUUID();
  await db.query(
    `INSERT INTO public.events(event_id,slug,name,status,starts_at,ends_at,archive_at,private_at,terms_version)
    VALUES($1,'second','Second fixture','live',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days',now()+interval '3 days','test')`,
    [other.event],
  );
  await db.query(
    "INSERT INTO public.event_settings(event_id,publication_stopped,uploads_enabled,thresholds_approved,moderation_thresholds,moderation_concurrency) VALUES($1,false,true,true,$2,2)",
    [other.event, JSON.stringify(thresholds)],
  );
  await db.query(
    "INSERT INTO public.event_members(event_id,user_id,display_name) VALUES($1,$2,'Second synthetic')",
    [other.event, owner],
  );
  await db.query(
    "INSERT INTO public.consents(event_id,user_id,terms_version) VALUES($1,$2,'test')",
    [other.event, owner],
  );
  await db.query(
    `INSERT INTO public.posts(event_id,id,user_id,kind,client_request_id,declared_content_type,original_scope,status,version,original_bytes)
    VALUES($1,$2,$3,'photo',$2,'image/heic','photo_file','uploaded',2,100)`,
    [other.event, other.post, owner],
  );
  await db.query(
    `INSERT INTO public.media_assets(event_id,id,post_id,purpose,provider,object_key,byte_size,object_etag,object_version)
    VALUES($1,$2,$3,'original','r2_original',$4,100,$5,'second-v1')`,
    [
      other.event,
      otherAsset,
      other.post,
      `events/${other.event}/posts/${other.post}/original/${otherAsset}.bin`,
      etag,
    ],
  );
  await db.query(
    `INSERT INTO public.outbox_jobs(event_id,id,post_id,kind,deduplication_key,payload)
    VALUES($1,$2,$3,'process_media','second',$4)`,
    [
      other.event,
      other.job,
      other.post,
      JSON.stringify({
        asset_id: otherAsset,
        post_version: 2,
        object_etag: etag,
        object_version: "second-v1",
      }),
    ],
  );
  const image = (await rpc("claim", {}, other)).plan;
  assert.equal(
    (
      await rpc(
        "finish",
        {
          plan: image,
          originalSha256: "e".repeat(64),
          deliveries: image.deliveries.map((d, i) => ({
            ...d,
            outcome: "stored",
            sha256: String(i + 1).repeat(64),
            size: 20 + i,
            width: Number(d.variant),
            height: 400,
          })),
        },
        other,
      )
    ).code,
    "RECORDED",
  );
  other.image = false;
  const otherPlan = (await claim(other)).plan;
  await db.exec(
    "UPDATE koko_private.moderation_budgets SET calls_per_minute=1 WHERE provider='openai'",
  );
  assert.equal((await reserve(originalPlan, "openai")).allowed, true);
  assert.equal(
    (await reserve(otherPlan, "openai", 0, 1, "openai", other)).code,
    "QUOTA",
  );
  await db.exec(
    "UPDATE koko_private.moderation_budgets SET window_start=now()-interval '1 minute' WHERE provider='openai'",
  );
  assert.equal(
    (await reserve(otherPlan, "openai", 0, 1, "openai", other)).allowed,
    true,
  );
  assert.equal(
    (await reserve(originalPlan, "openai")).code,
    "RESERVED_ALREADY",
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::integer n FROM koko_private.moderation_calls WHERE provider='openai'",
      )
    ).rows[0].n,
    2,
  );
});
test("crash recovery advances durable attempts and rejects the prior lease", async () => {
  const old = (await claim()).plan;
  assert.equal((await reserve(old, "openai")).allowed, true);
  await expire();
  const { plan } = await claim();
  assert.equal(
    plan.attemptStarts.find((a) => a.engine === "openai").nextAttempt,
    2,
  );
  assert.equal((await rpc("check", { plan: old })).code, "STALE");
  assert.equal((await reserve(plan, "openai", 0, 1)).code, "RESERVED_ALREADY");
  const evidence = result([
    run("openai", { attempt: 2 }),
    run("safesearch"),
    run("ocr"),
  ]);
  assert.equal((await finish(plan, evidence)).code, "RECORDED");
});
test("old settings/post/owner/asset changes cannot authorize final publication", async () => {
  const { plan } = await claim();
  await db.exec(
    "UPDATE public.event_settings SET settings_version=settings_version+1",
  );
  assert.equal((await rpc("finish", { plan, result: result() })).code, "STALE");
  assert.equal((await row("posts")).status, "processing");
});
test("unknown or forged successful evidence cannot skip mandatory engines/reservations", async () => {
  const { plan } = await claim();
  assert.equal(
    (await rpc("finish", { plan, result: result() })).code,
    "INVALID_INPUT",
  );
  const partial = result([run("openai", { error: "QUOTA" })]);
  partial.decision = "PASS";
  assert.equal(
    (await rpc("finish", { plan, result: partial })).code,
    "INVALID_INPUT",
  );
  assert.equal((await row("posts")).status, "processing");
});
test("empty failures commit HELD without synthetic zero scores", async () => {
  const { plan } = await claim();
  assert.equal(
    (await finish(plan, result([], 1, "INVALID_MEDIA"))).code,
    "RECORDED",
  );
  assert.equal((await row("posts")).status, "held");
  assert.equal(
    (await db.query("SELECT count(*)::integer n FROM public.moderation_runs"))
      .rows[0].n,
    0,
  );
});
test("retryable errors preserve per-attempt logs and final successful scores", async () => {
  const { plan } = await claim();
  const evidence = result([
    run("openai", { error: "TIMEOUT" }),
    run("openai", { attempt: 2 }),
    run("safesearch"),
    run("ocr"),
  ]);
  assert.equal((await finish(plan, evidence)).code, "RECORDED");
  assert.equal(
    (await db.query("SELECT count(*)::integer n FROM public.moderation_runs"))
      .rows[0].n,
    4,
  );
});

test("successful or non-retryable attempts cannot be replaced by later scores", async () => {
  const { plan } = await claim();
  const evidence = result([
    run("openai"),
    run("openai", { attempt: 2 }),
    run("safesearch"),
    run("ocr"),
  ]);
  assert.equal((await finish(plan, evidence)).code, "INVALID_INPUT");
  assert.equal((await row("posts")).status, "processing");
  evidence.runs[0] = run("openai", { error: "CREDENTIALS" });
  assert.equal(
    (await rpc("finish", { plan, result: evidence })).code,
    "INVALID_INPUT",
  );
  assert.equal(
    (await db.query("SELECT count(*)::integer n FROM public.moderation_runs"))
      .rows[0].n,
    0,
  );
});
test("no-text OCR is distinct from failure and requires a Vision call", async () => {
  const { plan } = await claim();
  const ocr = run("ocr");
  ocr.scores = {};
  ocr.observation = "no_text";
  ocr.usage.openaiRequests = 0;
  assert.equal(
    (await finish(plan, result([run("openai"), run("safesearch"), ocr]))).code,
    "RECORDED",
  );
});
test("late insert failure rolls back publication, logs, counters and outbox", async () => {
  const { plan } = await claim();
  await db.exec(`CREATE FUNCTION public.fixture_fail_notify() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='notify' THEN RAISE EXCEPTION 'fixture rollback'; END IF; RETURN NEW; END $$;
   CREATE TRIGGER fixture_fail_notify BEFORE INSERT ON public.outbox_jobs FOR EACH ROW EXECUTE FUNCTION public.fixture_fail_notify();`);
  try {
    await assert.rejects(
      finish(
        plan,
        result([
          run("openai", { category: "sexual" }),
          run("safesearch"),
          run("ocr"),
        ]),
      ),
      /fixture rollback/,
    );
    assert.equal((await row("posts")).status, "processing");
    assert.equal((await row("event_members", owner)).block_count, 0);
    assert.equal(
      (await db.query("SELECT count(*)::integer n FROM public.moderation_runs"))
        .rows[0].n,
      0,
    );
  } finally {
    await db.exec(
      "DROP TRIGGER fixture_fail_notify ON public.outbox_jobs; DROP FUNCTION public.fixture_fail_notify()",
    );
  }
});
test("admin retry uses saved derivatives and counts the same blocked post only once", async () => {
  const evidence = result([
    run("openai", { category: "sexual" }),
    run("safesearch"),
    run("ocr"),
  ]);
  await finish((await claim()).plan, evidence);
  await db.exec("UPDATE public.event_members SET role='admin'");
  const version = (await row("posts")).version;
  const response = (
    await db.query(
      "SELECT public.stage_three_operation($1,$2,'retry',$3,$4,$5) result",
      [
        event,
        owner,
        post,
        JSON.stringify({
          expected_version: version,
          reason: "Synthetic retry",
        }),
        randomUUID(),
      ],
    )
  ).rows[0].result;
  assert.equal(response.code, "ok");
  const next = (
    await db.query(
      "SELECT id FROM public.outbox_jobs WHERE kind='process_media' AND completed_at IS NULL",
    )
  ).rows[0].id;
  const { plan } = await claim({ job: next });
  assert.equal(plan.media.source, "original_read_only");
  assert.equal((await finish(plan, evidence, { job: next })).code, "RECORDED");
  assert.equal((await row("event_members", owner)).block_count, 1);
});

async function videoFixture() {
  const stream = randomUUID();
  await db.exec(
    "UPDATE public.posts SET kind='video',original_scope='client_trimmed',measured_duration_seconds=3; UPDATE public.outbox_jobs SET payload=jsonb_set(payload,'{post_version}','3'::jsonb)",
  );
  await db.query(
    `INSERT INTO public.media_assets(event_id,id,post_id,purpose,provider,stream_uid,stream_ready_to_stream,stream_require_signed_urls,stream_processing_complete,stream_duration_seconds)
    VALUES($1,$2,$3,'stream_source','stream','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',true,true,true,3)`,
    [event, stream, post],
  );
  const media = {
    kind: "video",
    postVersion: 3,
    streamAssetId: stream,
    measuredDurationSeconds: 3,
    frameTimes: [0.5, 1.5, 2.5],
    requireSignedURLs: true,
    readyToStream: true,
    processingComplete: true,
  };
  await db.query(
    "UPDATE public.outbox_jobs SET moderation_media=$1 WHERE id=$2",
    [JSON.stringify(media), job],
  );
  return { stream, media };
}

test("video preprocessing hold can be manually retried twice using verified same-original frames", async () => {
  await videoFixture();
  await db.exec("UPDATE public.event_members SET role='admin'");
  let currentJob = job;
  for (let attempt = 0; attempt < 2; attempt++) {
    const found = await claim({ job: currentJob });
    assert.equal(found.code, "CLAIMED");
    assert.equal(
      (
        await rpc(
          "fail",
          { plan: found.plan, reason: "DECODE_FAILED" },
          { job: currentJob },
        )
      ).code,
      "HELD",
    );
    const version = (await row("posts")).version;
    const retry = (
      await db.query(
        "SELECT public.stage_three_operation($1,$2,'retry',$3,$4,$5) r",
        [
          event,
          owner,
          post,
          JSON.stringify({
            expected_version: version,
            reason: "Synthetic frame retry",
          }),
          randomUUID(),
        ],
      )
    ).rows[0].r;
    assert.equal(retry.code, "ok");
    currentJob = (
      await db.query(
        "SELECT id FROM public.outbox_jobs WHERE kind='process_media' AND completed_at IS NULL",
      )
    ).rows[0].id;
  }
  assert.equal((await claim({ job: currentJob })).code, "CLAIMED");
  assert.equal((await row("event_members", owner)).block_count, 0);
});
test("video requires all three frames and mandatory engines before publication", async () => {
  await videoFixture();
  const { plan } = await claim();
  assert.equal(plan.attemptStarts.length, 9);
  assert.equal(plan.media.streamUid, "a".repeat(32));
  assert.equal(plan.media.sourceUid, null);
  const runs = [0, 1, 2].flatMap((frame) =>
    engines.map((engine) => run(engine, { frame })),
  );
  assert.equal((await finish(plan, result(runs, 3))).code, "RECORDED");
  assert.equal((await row("posts")).status, "published");
  assert.equal(
    (await db.query("SELECT count(*)::integer n FROM public.moderation_runs"))
      .rows[0].n,
    9,
  );
});

test("fallback clip must attest its exact same-post source UID", async () => {
  const { media } = await videoFixture();
  const clip = randomUUID();
  await db.exec("UPDATE public.posts SET original_scope='full_video_fallback'");
  await db.query(
    `INSERT INTO public.media_assets(event_id,id,post_id,purpose,provider,stream_uid,stream_ready_to_stream,stream_require_signed_urls,stream_processing_complete,stream_duration_seconds)
    VALUES($1,$2,$3,'stream_clip','stream','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',true,true,true,3)`,
    [event, clip, post],
  );
  await db.query(
    "UPDATE public.outbox_jobs SET moderation_media=$1 WHERE id=$2",
    [JSON.stringify({ ...media, streamAssetId: clip }), job],
  );
  assert.equal((await claim()).code, "MEDIA_NOT_READY");
  await db.query(
    "UPDATE public.media_assets SET stream_source_uid=repeat('c',32) WHERE id=$1",
    [clip],
  );
  assert.equal((await claim()).code, "MEDIA_NOT_READY");
  await db.query(
    "UPDATE public.media_assets SET stream_source_uid=repeat('a',32) WHERE id=$1",
    [clip],
  );
  const { plan } = await claim();
  assert.equal(plan.media.sourceUid, "a".repeat(32));
  assert.equal(plan.media.streamUid, "b".repeat(32));
  await db.query(
    "UPDATE public.media_assets SET stream_source_uid=repeat('c',32) WHERE id=$1",
    [clip],
  );
  assert.equal((await rpc("check", { plan })).code, "MEDIA_NOT_READY");
});
test("video BLOCK on one frame beats a mandatory-engine error elsewhere", async () => {
  await videoFixture();
  const { plan } = await claim();
  const runs = [0, 1, 2].flatMap((frame) =>
    engines.map((engine) =>
      run(engine, {
        frame,
        ...(frame === 0 && engine === "openai"
          ? { category: "sexual" }
          : frame === 2 && engine === "openai"
            ? { error: "TIMEOUT" }
            : {}),
      }),
    ),
  );
  assert.equal((await finish(plan, result(runs, 3))).code, "RECORDED");
  assert.equal((await row("posts")).moderation_verdict, "BLOCK");
});

test("video admin retry reuses same-original verified media under the new generation", async () => {
  await videoFixture();
  const runs = [0, 1, 2].flatMap((frame) =>
    engines.map((engine) =>
      run(engine, {
        frame,
        ...(frame === 0 && engine === "openai" ? { category: "sexual" } : {}),
      }),
    ),
  );
  await finish((await claim()).plan, result(runs, 3));
  await db.exec("UPDATE public.event_members SET role='admin'");
  const version = (await row("posts")).version;
  const response = (
    await db.query(
      "SELECT public.stage_three_operation($1,$2,'retry',$3,$4,$5) result",
      [
        event,
        owner,
        post,
        JSON.stringify({
          expected_version: version,
          reason: "Synthetic video retry",
        }),
        randomUUID(),
      ],
    )
  ).rows[0].result;
  assert.equal(response.code, "ok");
  const next = (
    await db.query(
      "SELECT id FROM public.outbox_jobs WHERE kind='process_media' AND completed_at IS NULL",
    )
  ).rows[0].id;
  const found = await claim({ job: next });
  assert.equal(found.code, "CLAIMED");
  assert.equal(found.plan.media.postVersion, version + 1);
  assert.equal(found.plan.media.streamUid, "a".repeat(32));
  const prepared = { ...found.plan.media };
  delete prepared.streamUid;
  delete prepared.sourceUid;
  assert.deepEqual(
    (
      await db.query(
        "SELECT moderation_media FROM public.outbox_jobs WHERE id=$1",
        [next],
      )
    ).rows[0].moderation_media,
    prepared,
  );
  assert.equal(
    (await finish(found.plan, result(runs, 3), { job: next })).code,
    "RECORDED",
  );
  assert.equal((await row("event_members", owner)).block_count, 1);
});
for (const [name, sql] of [
  [
    "signed",
    "UPDATE public.media_assets SET stream_require_signed_urls=false WHERE provider='stream'",
  ],
  [
    "ready",
    "UPDATE public.media_assets SET stream_ready_to_stream=false WHERE provider='stream'",
  ],
  [
    "incomplete quality",
    "UPDATE public.media_assets SET stream_processing_complete=false WHERE provider='stream'",
  ],
  [
    "duration mismatch",
    "UPDATE public.media_assets SET stream_duration_seconds=3.1 WHERE provider='stream'",
  ],
  ["too long", "UPDATE public.posts SET measured_duration_seconds=5"],
  ["missing evidence", "UPDATE public.outbox_jobs SET moderation_media=NULL"],
  [
    "identical times",
    "UPDATE public.outbox_jobs SET moderation_media=jsonb_set(moderation_media,'{frameTimes}','[1,1,2]'::jsonb)",
  ],
  [
    "past end",
    "UPDATE public.outbox_jobs SET moderation_media=jsonb_set(moderation_media,'{frameTimes}','[0.5,1.5,3]'::jsonb)",
  ],
  [
    "wrong version",
    "UPDATE public.outbox_jobs SET moderation_media=jsonb_set(moderation_media,'{postVersion}','2'::jsonb)",
  ],
])
  test(`video ${name} cannot claim or publish`, async () => {
    await videoFixture();
    await db.exec(sql);
    assert.equal((await claim()).code, "MEDIA_NOT_READY");
  });
for (const [name, modify] of [
  [
    "extra text",
    (e) => {
      e.runs[0].ocrText = "must-never-store";
    },
  ],
  [
    "missing scores",
    (e) => {
      delete e.runs[0].scores.sexual;
    },
  ],
  [
    "invalid scores",
    (e) => {
      e.runs[0].scores.sexual = -1;
    },
  ],
  [
    "forged costs",
    (e) => {
      e.runs[0].estimatedCostUsd = 1;
    },
  ],
  [
    "duplicate attempts",
    (e) => {
      e.runs.push(e.runs[0]);
    },
  ],
  [
    "unknown model",
    (e) => {
      e.runs[0].modelVersion = "unapproved";
    },
  ],
  [
    "null observation",
    (e) => {
      e.runs[0].observation = null;
    },
  ],
  [
    "forged decision",
    (e) => {
      e.runs[0].scores.sexual = 0.9;
    },
  ],
  [
    "extra engine",
    (e) => {
      e.engines.push(e.engines[0]);
    },
  ],
  [
    "null error",
    (e) => {
      e.errorCode = null;
    },
  ],
])
  test(`invalid evidence ${name} leaves no partial records`, async () => {
    const { plan } = await claim();
    const evidence = result();
    for (const r of evidence.runs) {
      if (r.usage.ocrImages || r.usage.safeSearchImages)
        await reserve(plan, r.engine);
      if (r.usage.openaiRequests) await reserve(plan, r.engine, 0, 1, "openai");
    }
    modify(evidence);
    assert.equal(
      (await rpc("finish", { plan, result: evidence })).code,
      "INVALID_INPUT",
    );
    assert.equal((await row("posts")).status, "processing");
    assert.equal(
      (await db.query("SELECT count(*)::integer n FROM public.moderation_runs"))
        .rows[0].n,
      0,
    );
  });
test("new object metadata cannot reuse an old moderation plan", async () => {
  const { plan } = await claim();
  await db.exec(
    "UPDATE public.media_assets SET object_version='object-v2' WHERE purpose='original'; UPDATE public.outbox_jobs SET payload=jsonb_set(payload,'{object_version}','\"object-v2\"'::jsonb)",
  );
  assert.equal((await rpc("check", { plan })).code, "STALE");
});
test("shared concurrency bounds include other active jobs and expired leases do not consume slots", async () => {
  await claim();
  await db.exec("UPDATE public.event_settings SET moderation_concurrency=1");
  const second = randomUUID();
  await db.query(
    "INSERT INTO public.outbox_jobs(event_id,id,post_id,kind,deduplication_key,payload) SELECT event_id,$1::uuid,post_id,kind,$1::uuid::text,jsonb_set(payload,'{post_version}','3'::jsonb) FROM public.outbox_jobs WHERE id=$2",
    [second, job],
  );
  assert.equal((await claim({ job: second })).code, "BUSY");
  await expire();
  assert.equal((await claim({ job: second })).code, "CLAIMED");
});
test("all consumed attempt slots return nextAttempt=4 and cannot be refunded by recovery", async () => {
  let { plan } = await claim();
  for (const attempt of [1, 2, 3])
    assert.equal((await reserve(plan, "openai", 0, attempt)).allowed, true);
  await expire();
  plan = (await claim()).plan;
  assert.equal(
    plan.attemptStarts.find((a) => a.engine === "openai").nextAttempt,
    4,
  );
  for (const attempt of [1, 2, 3])
    assert.equal((await reserve(plan, "openai", 0, attempt)).allowed, false);
  assert.equal(
    (await finish(plan, result([], 1, "RESOURCE_LIMIT"))).code,
    "RECORDED",
  );
  assert.equal((await row("posts")).status, "held");
});
test("known BLOCK survives cancellation; otherwise cancellation is HELD", async () => {
  const { plan } = await claim();
  assert.equal(
    (
      await finish(
        plan,
        result(
          [
            run("openai", { category: "sexual" }),
            run("safesearch"),
            run("ocr"),
          ],
          1,
          "ABORTED",
        ),
      )
    ).code,
    "RECORDED",
  );
  assert.equal((await row("posts")).status, "blocked");
});
