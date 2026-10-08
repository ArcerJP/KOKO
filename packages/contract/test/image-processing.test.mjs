import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { before, beforeEach, after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const event = "11111111-1111-4111-8111-111111111111";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const post = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const asset = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const job = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const etag = "a".repeat(32);
before(async () => {
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,service_role;`);
  const root = new URL(
    "../../../apps/api/supabase/migrations/",
    import.meta.url,
  );
  for (const name of (await readdir(root))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await db.exec(await readFile(new URL(name, root), "utf8"));
});
beforeEach(async () => {
  await db.exec("RESET ROLE; TRUNCATE public.events,auth.users CASCADE");
  await db.query("INSERT INTO auth.users VALUES($1)", [owner]);
  await db.query(
    `INSERT INTO public.events(event_id,slug,name,status,starts_at,ends_at,archive_at,private_at,terms_version)
    VALUES($1,'fixture','Fixture','live',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days',now()+interval '3 days','test')`,
    [event],
  );
  await db.query(
    "INSERT INTO public.event_settings(event_id,publication_stopped,uploads_enabled) VALUES($1,false,true)",
    [event],
  );
  await db.query(
    "INSERT INTO public.event_members(event_id,user_id,display_name) VALUES($1,$2,'Owner')",
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
    VALUES($1,$2,$3,'process_media','test',$4)`,
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
});
after(async () => db.close());
async function rpc(action, input = {}, options = {}) {
  const role = options.role ?? "service_role";
  assert.ok(["anon", "authenticated", "service_role"].includes(role));
  await db.exec(`SET ROLE ${role}`);
  try {
    return (
      await db.query(
        "SELECT public.manage_image_processing($1,$2,$3,$4,$5) result",
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
const claim = () => rpc("claim");
const check = (plan) => rpc("check", { plan });
const receipts = (plan) => ({
  plan,
  originalSha256: "b".repeat(64),
  deliveries: plan.deliveries.map((d, i) => ({
    ...d,
    outcome: "stored",
    sha256: String(i + 1).repeat(64),
    size: 20 + i,
    width: Number(d.variant),
    height: 400,
  })),
});
const finish = (plan, input = receipts(plan)) => rpc("finish", input);
const jobRow = async () =>
  (await db.query("SELECT * FROM public.outbox_jobs WHERE id=$1", [job]))
    .rows[0];
const postRow = async () =>
  (await db.query("SELECT * FROM public.posts WHERE id=$1", [post])).rows[0];
const assets = async () =>
  (
    await db.query(
      "SELECT * FROM public.media_assets WHERE post_id=$1 ORDER BY purpose",
      [post],
    )
  ).rows;
async function expire() {
  await db.query(
    "UPDATE public.outbox_jobs SET image_plan=jsonb_set(image_plan,'{expiresAt}',to_jsonb(floor(extract(epoch FROM clock_timestamp())*1000)::bigint-1000)) WHERE id=$1",
    [job],
  );
}

test("service-only invoker, empty search path; client cannot execute or read storage", async () => {
  const meta = (
    await db.query(
      "SELECT prosecdef,proconfig FROM pg_proc WHERE oid='public.manage_image_processing(uuid,uuid,uuid,text,jsonb)'::regprocedure",
    )
  ).rows[0];
  assert.equal(meta.prosecdef, false);
  assert.ok(meta.proconfig.some((v) => /^search_path=(""|)$/.test(v)));
  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(rpc("claim", {}, { role }), /permission denied/);
    await db.exec(`SET ROLE ${role}`);
    try {
      for (const table of ["media_assets", "outbox_jobs"])
        await assert.rejects(
          db.query(`SELECT * FROM public.${table}`),
          /permission denied/,
        );
    } finally {
      await db.exec("RESET ROLE");
    }
  }
  assert.equal(
    (
      await db.query(
        "SELECT bool_and(relrowsecurity) result FROM pg_class WHERE oid IN ('public.media_assets'::regclass,'public.outbox_jobs'::regclass)",
      )
    ).rows[0].result,
    true,
  );
});
test("claim produces exact pipeline plan, reserves four stable fixed keys, never publishes", async () => {
  const start = Date.now(),
    result = await claim();
  assert.equal(result.code, "CLAIMED");
  const plan = result.plan;
  assert.deepEqual(Object.keys(plan).sort(), [
    "deliveries",
    "expiresAt",
    "jobId",
    "leaseId",
    "original",
    "postVersion",
  ]);
  assert.equal(plan.jobId, job);
  assert.equal(plan.postVersion, 3);
  assert.match(plan.leaseId, /^[a-f0-9-]{36}$/);
  assert.ok(
    plan.expiresAt >= start + 119000 && plan.expiresAt <= Date.now() + 120000,
  );
  assert.deepEqual(plan.original, {
    eventId: event,
    postId: post,
    assetId: asset,
    size: 100,
    etag,
  });
  assert.equal(plan.deliveries.length, 4);
  assert.equal(new Set(plan.deliveries.map((d) => d.assetId)).size, 4);
  for (const d of (await assets()).filter(
    (d) => d.provider === "r2_delivery",
  )) {
    assert.equal(
      d.object_key,
      `events/${event}/delivery/${d.id}/${d.purpose.split("_")[1]}.${d.purpose.split("_")[2]}`,
    );
    assert.equal(d.byte_size, null);
  }
  assert.equal((await check(plan)).code, "CURRENT");
  assert.equal((await claim()).code, "BUSY");
  assert.equal((await jobRow()).image_attempt, 1);
  assert.equal((await jobRow()).completed_at, null);
  assert.equal((await postRow()).status, "processing");
  assert.equal((await postRow()).moderation_verdict, null);
});
test("expired claim renews lease but never assets or processing version; old holder rejected", async () => {
  const first = (await claim()).plan;
  await expire();
  assert.equal((await check(first)).code, "STALE");
  const second = (await claim()).plan;
  assert.notEqual(second.leaseId, first.leaseId);
  assert.deepEqual(second.deliveries, first.deliveries);
  assert.equal(second.postVersion, 3);
  assert.equal((await finish(first)).code, "STALE");
  assert.equal((await check(second)).code, "CURRENT");
  await expire();
  assert.equal((await claim()).code, "CLAIMED");
  await expire();
  assert.equal((await claim()).code, "EXHAUSTED");
  assert.equal((await assets()).length, 5);
  assert.equal((await postRow()).status, "held");
  assert.equal((await postRow()).processing_error, "IMAGE_RETRY_EXHAUSTED");
  assert.ok((await jobRow()).completed_at);
});
test("records all metadata atomically; retries are order/outcome insensitive, not publication", async () => {
  const plan = (await claim()).plan,
    body = receipts(plan);
  assert.equal((await finish(plan, body)).code, "RECORDED");
  const rows = await assets();
  for (const d of body.deliveries) {
    const row = rows.find((a) => a.id === d.assetId);
    assert.equal(row.byte_size, d.size);
    assert.equal(row.sha256, d.sha256);
    assert.equal(row.pixel_width, d.width);
    assert.equal(row.pixel_height, d.height);
  }
  assert.equal(rows.find((a) => a.id === asset).sha256, body.originalSha256);
  const j = await jobRow();
  assert.ok(j.image_completed_at);
  assert.equal(j.completed_at, null);
  assert.equal(j.dispatched_at, null);
  assert.equal(j.dispatch_attempt, 0);
  assert.equal(j.attempt, 0);
  assert.equal((await postRow()).status, "processing");
  assert.equal((await postRow()).moderation_verdict, null);
  assert.equal((await postRow()).version, 3);
  body.deliveries.reverse().forEach((d) => (d.outcome = "already_stored"));
  assert.equal((await finish(plan, body)).code, "RECORDED");
  assert.equal((await claim()).code, "IMAGE_SAVED");
  assert.equal((await check(plan)).code, "STALE");
  body.deliveries[0].sha256 = "f".repeat(64);
  assert.equal((await finish(plan, body)).code, "CONFLICT");
  assert.deepEqual((await jobRow()).image_receipt, j.image_receipt);
});
test("preserves a previously established original hash and rejects conflicting conversion", async () => {
  await db.query("UPDATE public.media_assets SET sha256=$1 WHERE id=$2", [
    "a".repeat(64),
    asset,
  ]);
  const plan = (await claim()).plan;
  assert.equal(plan.original.sha256, "a".repeat(64));
  assert.equal((await finish(plan)).code, "CONFLICT");
  const body = receipts(plan);
  body.originalSha256 = "a".repeat(64);
  assert.equal((await finish(plan, body)).code, "RECORDED");
});
test("expired lease rejects final write even without a new claimant", async () => {
  await claim();
  await expire();
  const plan = (await jobRow()).image_plan;
  assert.equal((await finish(plan)).code, "STALE");
  assert.equal((await jobRow()).image_completed_at, null);
});
test("transaction rollback removes reservations, state transition and receipt", async () => {
  await db.exec("BEGIN");
  const plan = (await claim()).plan;
  await finish(plan);
  await db.exec("ROLLBACK");
  assert.equal((await postRow()).status, "uploaded");
  assert.equal((await postRow()).version, 2);
  assert.equal((await assets()).length, 1);
  assert.equal((await jobRow()).image_plan, null);
});
test("a second job cannot take the same processing post", async () => {
  const second = randomUUID();
  await db.query(
    "INSERT INTO public.outbox_jobs(event_id,id,post_id,kind,deduplication_key,payload) SELECT event_id,$1,post_id,kind,'other',payload FROM public.outbox_jobs WHERE id=$2",
    [second, job],
  );
  await claim();
  assert.equal((await rpc("claim", {}, { job: second })).code, "STALE");
});
test("READ COMMITTED required for all actions", async () => {
  for (const action of ["claim", "check", "finish"]) {
    await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await assert.rejects(
      db.query("SELECT public.manage_image_processing($1,$2,$3,$4,'{}')", [
        event,
        post,
        job,
        action,
      ]),
      /requires READ COMMITTED/,
    );
    await db.exec("ROLLBACK");
  }
});
for (const [name, sql] of [
  ["stopped", "UPDATE public.event_settings SET publication_stopped=true"],
  ["uploads paused", "UPDATE public.event_settings SET uploads_enabled=false"],
  ["private event", "UPDATE public.events SET status='private'"],
  ["archive event", "UPDATE public.events SET status='archive'"],
  ["BAN", "UPDATE public.event_members SET is_banned=true,banned_at=now()"],
  ["ban latch", "UPDATE public.posts SET ban_latched=true"],
  ["deleted", "UPDATE public.posts SET status='deleted',deleted_at=now()"],
  ["held", "UPDATE public.posts SET status='held'"],
  ["version changed", "UPDATE public.posts SET version=version+1"],
  ["new terms", "UPDATE public.events SET terms_version='new'"],
  ["missing consent", "DELETE FROM public.consents"],
  ["missing settings", "DELETE FROM public.event_settings"],
  [
    "original deletion requested",
    "UPDATE public.media_assets SET deletion_requested_at=now() WHERE purpose='original'",
  ],
  [
    "original removed",
    "UPDATE public.media_assets SET physically_deleted_at=now() WHERE purpose='original'",
  ],
  [
    "original replaced",
    "UPDATE public.media_assets SET object_version='changed' WHERE purpose='original'",
  ],
  [
    "wrong etag",
    "UPDATE public.media_assets SET object_etag=repeat('b',32) WHERE purpose='original'",
  ],
  [
    "missing bytes",
    "UPDATE public.media_assets SET byte_size=NULL WHERE purpose='original'",
  ],
  ["completed job", "UPDATE public.outbox_jobs SET completed_at=now()"],
  ["wrong kind", "UPDATE public.outbox_jobs SET kind='notify'"],
  [
    "wrong source",
    "UPDATE public.outbox_jobs SET payload=jsonb_set(payload,'{asset_id}',to_jsonb('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::text))",
  ],
])
  test(`current policy/identity fence: ${name}`, async () => {
    const plan = (await claim()).plan;
    await db.exec(sql);
    assert.equal((await check(plan)).code, "STALE");
    assert.equal((await finish(plan)).code, "STALE");
    assert.equal((await claim()).code, "STALE");
    assert.equal((await jobRow()).image_completed_at, null);
  });
for (const [name, change] of [
  ["missing", (b) => b.deliveries.pop()],
  ["duplicate", (b) => (b.deliveries[3] = { ...b.deliveries[0] })],
  ["foreign asset", (b) => (b.deliveries[3].assetId = randomUUID())],
  ["foreign event", (b) => (b.deliveries[3].eventId = randomUUID())],
  ["bad hash", (b) => (b.deliveries[3].sha256 = "invalid")],
  [
    "extra field",
    (b) => (b.deliveries[3].url = "https://example.invalid/private"),
  ],
  ["wrong variant", (b) => (b.deliveries[3].variant = "1024")],
  ["zero bytes", (b) => (b.deliveries[3].size = 0)],
  ["fractional bytes", (b) => (b.deliveries[3].size = 1.5)],
  ["excess bytes", (b) => (b.deliveries[3].size = 16777217)],
  ["null dimensions", (b) => (b.deliveries[3].width = null)],
  ["string dimensions", (b) => (b.deliveries[3].width = "600")],
  ["large dimensions", (b) => (b.deliveries[3].height = 1601)],
  ["fractional dimensions", (b) => (b.deliveries[3].height = 1.2)],
  ["invalid outcome", (b) => (b.deliveries[3].outcome = "published")],
  ["no original hash", (b) => delete b.originalSha256],
  ["invalid original hash", (b) => (b.originalSha256 = "bad")],
  ["extra input", (b) => (b.token = "synthetic")],
  ["null receipt", (b) => (b.deliveries[3] = null)],
])
  test(`validates entire receipt before any write: ${name}`, async () => {
    const plan = (await claim()).plan,
      b = receipts(plan);
    change(b);
    assert.equal((await finish(plan, b)).code, "INVALID_INPUT");
    assert.equal((await jobRow()).image_completed_at, null);
    for (const a of await assets()) {
      assert.equal(a.sha256, null);
      assert.equal(a.pixel_width, null);
    }
  });
test("changed reserved asset is rejected; no replacement or cleanup", async () => {
  const plan = (await claim()).plan;
  await db.query(
    "UPDATE public.media_assets SET deletion_requested_at=now() WHERE id=$1",
    [plan.deliveries[0].assetId],
  );
  assert.equal((await check(plan)).code, "STALE");
  assert.equal((await finish(plan)).code, "STALE");
  assert.equal((await assets()).length, 5);
});
test("wrong scope/plan and missing job cannot authorize", async () => {
  for (const options of [
    { event: randomUUID() },
    { post: randomUUID() },
    { job: randomUUID() },
  ])
    assert.equal((await rpc("claim", {}, options)).code, "STALE");
  const plan = (await claim()).plan;
  for (const bad of [
    { ...plan, leaseId: randomUUID() },
    { ...plan, postVersion: 4 },
    { ...plan, extra: true },
    null,
  ])
    assert.equal((await check(bad)).code, "STALE");
});
test("resource budget is not an upload limit and does not reserve assets", async () => {
  await db.exec(
    "UPDATE public.posts SET original_bytes=67108865; UPDATE public.media_assets SET byte_size=67108865",
  );
  assert.equal((await claim()).code, "RESOURCE_LIMIT");
  assert.equal((await assets()).length, 1);
  assert.equal((await postRow()).status, "held");
  assert.equal((await postRow()).processing_error, "IMAGE_RESOURCE_LIMIT");
});
test("maximum supported processing version remains checkable and finishable", async () => {
  await db.exec(
    "UPDATE public.posts SET version=2147483645; UPDATE public.outbox_jobs SET payload=jsonb_set(payload,'{post_version}','2147483645')",
  );
  const result = await claim();
  assert.equal(result.code, "CLAIMED");
  assert.equal(result.plan.postVersion, 2147483646);
  assert.equal((await check(result.plan)).code, "CURRENT");
  assert.equal((await finish(result.plan)).code, "RECORDED");
});
test("version increment overflow is rejected before reserving any asset", async () => {
  await db.exec(
    "UPDATE public.posts SET version=2147483647; UPDATE public.outbox_jobs SET payload=jsonb_set(payload,'{post_version}','2147483647')",
  );
  assert.equal((await claim()).code, "STALE");
  assert.equal((await assets()).length, 1);
  assert.equal((await postRow()).status, "uploaded");
});

test("decode failure atomically holds, retains original, notifies once, and exposes durable Queue proof", async () => {
  const originalBefore = (await assets())[0];
  const plan = (await claim()).plan;
  assert.equal(
    (await rpc("fail", { plan, reason: "DECODE_FAILED" })).code,
    "HELD",
  );
  const p = await postRow(),
    j = await jobRow();
  assert.equal(p.status, "held");
  assert.equal(p.processing_error, "IMAGE_DECODE_FAILED");
  assert.equal(p.moderation_verdict, null);
  assert.equal(p.ban_latched, false);
  assert.equal(p.version, 4);
  assert.ok(j.completed_at);
  assert.equal(j.image_completed_at, null);
  assert.deepEqual(j.processing_failure_receipt, {
    stage: "image",
    reason: "DECODE_FAILED",
    postVersion: 3,
    heldVersion: 4,
  });
  assert.deepEqual(
    (await assets()).find((a) => a.purpose === "original"),
    originalBefore,
  );
  assert.equal(
    (await rpc("fail", { plan, reason: "DECODE_FAILED" })).code,
    "STALE",
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM public.outbox_jobs WHERE kind='notify'",
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM public.moderation_runs"))
      .rows[0].n,
    0,
  );
  const status = (
    await db.query("SELECT public.media_processing_status($1,$2,$3,$4,$5) r", [
      event,
      post,
      job,
      asset,
      2,
    ])
  ).rows[0].r;
  assert.equal(status.code, "HELD");
});

for (const change of [
  "expired",
  "lease",
  "version",
  "ban",
  "delete",
  "completed",
  "stopped",
])
  test(`image failure cannot settle ${change} work`, async () => {
    const plan = (await claim()).plan;
    if (change === "expired") await expire();
    if (change === "lease") plan.leaseId = randomUUID();
    if (change === "version")
      await db.exec("UPDATE public.posts SET version=version+1");
    if (change === "ban")
      await db.exec(
        "UPDATE public.event_members SET is_banned=true,banned_at=now()",
      );
    if (change === "delete")
      await db.exec(
        "UPDATE public.posts SET status='deleted',deleted_at=now()",
      );
    if (change === "completed") await finish(plan);
    if (change === "stopped")
      await db.exec(
        "UPDATE public.event_settings SET publication_stopped=true",
      );
    assert.equal(
      (await rpc("fail", { plan, reason: "DECODE_FAILED" })).code,
      "STALE",
    );
    assert.equal((await jobRow()).processing_failure_receipt, null);
  });

test("failure reason is an exact code and transaction rollback never leaves a false hold", async () => {
  const plan = (await claim()).plan;
  for (const reason of [
    null,
    "secret exception body",
    "RETRY_EXHAUSTED",
    { reason: "DECODE_FAILED" },
  ])
    assert.equal((await rpc("fail", { plan, reason })).code, "INVALID_INPUT");
  await db.exec(`CREATE FUNCTION public.fixture_reject_failure_notify() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='notify' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER fixture_failure_notify BEFORE INSERT ON public.outbox_jobs FOR EACH ROW EXECUTE FUNCTION public.fixture_reject_failure_notify()`);
  try {
    await assert.rejects(
      rpc("fail", { plan, reason: "DECODE_FAILED" }),
      /fixture/,
    );
  } finally {
    await db.exec(
      "DROP TRIGGER fixture_failure_notify ON public.outbox_jobs; DROP FUNCTION public.fixture_reject_failure_notify()",
    );
  }
  assert.equal((await postRow()).status, "processing");
  assert.equal((await jobRow()).completed_at, null);
});

test("explicit admin retry alone reuses the exact failed reservation with a new generation and lease", async () => {
  const old = (await claim()).plan;
  await rpc("fail", { plan: old, reason: "DECODE_FAILED" });
  const before = await assets();
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
  const found = await rpc("claim", {}, { job: next });
  assert.equal(found.code, "CLAIMED");
  assert.equal(found.plan.postVersion, 6);
  assert.deepEqual(found.plan.deliveries, old.deliveries);
  assert.notEqual(found.plan.leaseId, old.leaseId);
  assert.deepEqual(await assets(), before);
  assert.equal(
    (await rpc("fail", { plan: old, reason: "DECODE_FAILED" })).code,
    "STALE",
  );
  assert.equal(
    (await rpc("finish", receipts(found.plan), { job: next })).code,
    "RECORDED",
  );
});

test("processing status alone cannot adopt an unproved reservation", async () => {
  const old = (await claim()).plan;
  await db.query(
    "UPDATE public.outbox_jobs SET completed_at=now() WHERE id=$1",
    [job],
  );
  const next = randomUUID();
  await db.query(
    "INSERT INTO public.outbox_jobs(event_id,id,post_id,kind,deduplication_key,payload) SELECT event_id,$1,post_id,kind,'unproved',jsonb_set(payload,'{post_version}','3') FROM public.outbox_jobs WHERE id=$2",
    [next, job],
  );
  assert.equal((await rpc("claim", {}, { job: next })).code, "STALE");
  assert.equal(
    (await rpc("fail", { plan: old, reason: "DECODE_FAILED" })).code,
    "STALE",
  );
});
test("preexisting derivatives are not adopted", async () => {
  const id = randomUUID();
  await db.query(
    "INSERT INTO public.media_assets(event_id,id,post_id,purpose,provider,object_key) VALUES($1,$2,$3,'delivery_600_jpg','r2_delivery',$4)",
    [event, id, post, `events/${event}/delivery/${id}/600.jpg`],
  );
  assert.equal((await claim()).code, "STALE");
});
test("upload window closing does not drop accepted work; private deadline caps lease", async () => {
  await db.exec(
    "UPDATE public.events SET ends_at=now()-interval '2 hours',archive_at=now()-interval '1 hour',private_at=now()+interval '40 seconds'",
  );
  const plan = (await claim()).plan;
  assert.ok(plan.expiresAt <= Date.now() + 40000);
  assert.equal((await check(plan)).code, "CURRENT");
  await db.exec(
    "UPDATE public.events SET private_at=now()-interval '1 second'",
  );
  assert.equal((await finish(plan)).code, "STALE");
});
test("an owner change does not transfer an old processing claim", async () => {
  const plan = (await claim()).plan,
    newOwner = randomUUID();
  await db.query("INSERT INTO auth.users VALUES($1)", [newOwner]);
  await db.query(
    "INSERT INTO public.event_members(event_id,user_id,display_name) VALUES($1,$2,'Other')",
    [event, newOwner],
  );
  await db.query(
    "INSERT INTO public.consents(event_id,user_id,terms_version) VALUES($1,$2,'test')",
    [event, newOwner],
  );
  await db.query("UPDATE public.posts SET user_id=$1 WHERE id=$2", [
    newOwner,
    post,
  ]);
  assert.equal((await check(plan)).code, "STALE");
  assert.equal((await claim()).code, "STALE");
  assert.equal((await finish(plan)).code, "STALE");
});
test("a late DB failure rolls back every saved receipt and the original hash", async () => {
  const plan = (await claim()).plan;
  await db.exec(`CREATE FUNCTION public.fail_image_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.image_completed_at IS NOT NULL THEN RAISE EXCEPTION 'synthetic final write failure'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER reject_image_receipt BEFORE UPDATE ON public.outbox_jobs FOR EACH ROW EXECUTE FUNCTION public.fail_image_receipt();`);
  try {
    await assert.rejects(finish(plan), /synthetic final write failure/);
  } finally {
    await db.exec(
      "DROP TRIGGER reject_image_receipt ON public.outbox_jobs; DROP FUNCTION public.fail_image_receipt()",
    );
  }
  for (const a of await assets()) {
    assert.equal(a.sha256, null);
    assert.equal(a.pixel_width, null);
  }
  assert.equal((await jobRow()).image_completed_at, null);
  assert.equal((await finish(plan)).code, "RECORDED");
});
test("finished replay checks stored asset metadata rather than hiding corruption", async () => {
  const plan = (await claim()).plan;
  await finish(plan);
  await db.query("UPDATE public.media_assets SET pixel_height=1 WHERE id=$1", [
    plan.deliveries[0].assetId,
  ]);
  assert.equal((await finish(plan)).code, "CONFLICT");
});
for (const [name, sql] of [
  [
    "BAN before reservation",
    "UPDATE public.event_members SET is_banned=true,banned_at=now()",
  ],
  [
    "paused before reservation",
    "UPDATE public.event_settings SET uploads_enabled=false",
  ],
  ["no consent before reservation", "DELETE FROM public.consents"],
  ["wrong version before reservation", "UPDATE public.posts SET version=3"],
  [
    "video is not image work",
    "UPDATE public.posts SET kind='video',original_scope='full_video_fallback'",
  ],
  ["different source bytes", "UPDATE public.media_assets SET byte_size=101"],
  [
    "missing source identity",
    "UPDATE public.media_assets SET object_version=NULL",
  ],
  [
    "unsupported ETag",
    "UPDATE public.media_assets SET object_etag=repeat('a',32)||'-10001'",
  ],
])
  test(name, async () => {
    await db.exec(sql);
    assert.equal((await claim()).code, "STALE");
    assert.equal((await assets()).length, 1);
    assert.equal((await jobRow()).image_attempt, 0);
  });
for (const [action, input] of [
  [null, {}],
  ["wrong", {}],
  ["claim", null],
  ["claim", []],
  ["claim", { extra: 1 }],
  ["check", {}],
  ["check", { plan: null, extra: 1 }],
  ["finish", {}],
  ["claim", { large: "x".repeat(17000) }],
])
  test(`invalid action/input ${action} ${JSON.stringify(input).slice(0, 40)}`, async () => {
    assert.equal((await rpc(action, input)).code, "INVALID_INPUT");
    assert.equal((await assets()).length, 1);
  });
