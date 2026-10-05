import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { before, beforeEach, after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const event = "11111111-1111-4111-8111-111111111111",
  owner = "22222222-2222-4222-8222-222222222222",
  post = "33333333-3333-4333-8333-333333333333",
  asset = "44444444-4444-4444-8444-444444444444",
  job = "55555555-5555-4555-8555-555555555555";
before(async () => {
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role; GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,service_role;`);
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
    VALUES($1,'synthetic','Synthetic','live',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days',now()+interval '3 days','test')`,
    [event],
  );
  await db.query(
    "INSERT INTO public.event_settings(event_id,publication_stopped,uploads_enabled,operational_outbox_enabled) VALUES($1,false,true,true)",
    [event],
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
    `INSERT INTO public.posts(event_id,id,user_id,kind,status,client_request_id,declared_content_type,original_scope,original_bytes,version)
    VALUES($1,$2,$3,'photo','uploaded',$2,'image/jpeg','photo_file',100,3)`,
    [event, post, owner],
  );
  await db.query(
    `INSERT INTO public.media_assets(event_id,id,post_id,purpose,provider,object_key,byte_size,object_etag,object_version)
    VALUES($1,$2,$3,'original','r2_original',$4,100,$5,'v1')`,
    [
      event,
      asset,
      post,
      `events/${event}/posts/${post}/original/${asset}.bin`,
      "a".repeat(32),
    ],
  );
  await insert("notify", { category: "block", post_version: 3 });
});
after(async () => db.close());
async function insert(
  kind,
  payload,
  { id = job, postId = post, dedup = id } = {},
) {
  await db.query(
    "INSERT INTO public.outbox_jobs(event_id,id,post_id,kind,deduplication_key,payload) VALUES($1,$2,$3,$4,$5,$6)",
    [event, id, postId, kind, dedup, JSON.stringify(payload)],
  );
}
async function call(
  action,
  input = {},
  jobId = job,
  scope = event,
  role = "service_role",
) {
  assert.ok(["anon", "authenticated", "service_role"].includes(role));
  await db.exec(`SET ROLE ${role}`);
  try {
    return (
      await db.query("SELECT public.stage_three_outbox($1,$2,$3,$4) result", [
        scope,
        jobId,
        action,
        JSON.stringify(input),
      ])
    ).rows[0].result;
  } finally {
    await db.exec("RESET ROLE");
  }
}
async function claim(input = { limit: 10, notify: true }) {
  return call("claim", input, null);
}
async function prepare() {
  const c = (await claim()).jobs[0];
  assert.ok(c);
  return { c, result: await call("prepare", { lease_id: c.lease_id }) };
}
async function settle(c, outcome, retry_seconds = 0) {
  return call(
    "settle",
    { lease_id: c.lease_id, outcome, retry_seconds },
    c.job_id,
  );
}
async function row() {
  return (await db.query("SELECT * FROM public.outbox_jobs WHERE id=$1", [job]))
    .rows[0];
}
async function payload(value, kind = "notify", postId = post) {
  await db.query(
    "UPDATE public.outbox_jobs SET kind=$1,payload=$2,post_id=$3 WHERE id=$4",
    [kind, JSON.stringify(value), postId, job],
  );
}
test("all migrations apply, service-only fixed-search-path invoker RPC", async () => {
  for (const role of ["anon", "authenticated"])
    await assert.rejects(
      call("claim", { limit: 10, notify: true }, null, event, role),
      /permission denied/,
    );
  const r = (
    await db.query(
      "SELECT prosecdef,proconfig FROM pg_proc WHERE proname='stage_three_outbox'",
    )
  ).rows[0];
  assert.equal(r.prosecdef, false);
  assert.deepEqual(r.proconfig, ['search_path=""']);
});
test("feature defaults off and disabled makes no mutations", async () => {
  await db.exec(
    "UPDATE public.event_settings SET operational_outbox_enabled=false",
  );
  assert.equal((await claim()).code, "DISABLED");
  assert.equal((await row()).ops_attempt, 0);
  const r = (
    await db.query(
      "SELECT column_default FROM information_schema.columns WHERE table_name='event_settings' AND column_name='operational_outbox_enabled'",
    )
  ).rows[0];
  assert.equal(r.column_default, "false");
});
test("REPEATABLE READ is rejected", async () => {
  await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    await assert.rejects(
      db.query("SELECT public.stage_three_outbox($1,NULL,'claim',$2)", [
        event,
        JSON.stringify({ limit: 10, notify: true }),
      ]),
      /READ COMMITTED/,
    );
  } finally {
    await db.exec("ROLLBACK");
  }
});
for (const input of [
  null,
  [],
  {},
  { limit: 0, notify: true },
  { limit: 11, notify: true },
  { limit: 1.5, notify: true },
  { limit: "1", notify: true },
  { limit: 1, notify: "true" },
  { limit: 1, notify: true, url: "bad" },
])
  test(`invalid claim ${JSON.stringify(input)}`, async () => {
    assert.equal((await claim(input)).code, "INVALID_INPUT");
    assert.equal((await row()).ops_attempt, 0);
  });
test("unknown event and job scopes fail closed", async () => {
  assert.equal(
    (await call("claim", { limit: 10, notify: true }, null, randomUUID())).code,
    "NOT_FOUND",
  );
  const c = (await claim()).jobs[0];
  assert.equal(
    (await call("prepare", { lease_id: c.lease_id }, randomUUID())).code,
    "STALE",
  );
});
test("no notify claim when not configured; unrelated kinds untouched", async () => {
  await insert("export", {}, { id: randomUUID() });
  await insert("process_media", {}, { id: randomUUID() });
  assert.deepEqual((await claim({ limit: 10, notify: false })).jobs, []);
  assert.equal((await row()).ops_attempt, 0);
});
test("max 10, stable batch, live lease excluded and never exposes payload", async () => {
  for (let i = 0; i < 12; i++)
    await insert(
      "notify",
      { category: "ban", user_id: owner },
      { id: randomUUID(), postId: null },
    );
  const first = await claim();
  assert.equal(first.jobs.length, 10);
  assert.equal(new Set(first.jobs.map((x) => x.job_id)).size, 10);
  assert.deepEqual(
    Object.keys(first.jobs[0]).sort(),
    ["attempt", "event_id", "job_id", "kind", "lease_id"].sort(),
  );
  assert.equal((await claim()).jobs.length, 3);
  assert.equal((await claim()).jobs.length, 0);
});
test("future available time is not claimed", async () => {
  await db.exec(
    "UPDATE public.outbox_jobs SET available_at=now()+interval '1 hour'",
  );
  assert.equal((await claim()).jobs.length, 0);
});
test("deduplication key unique per event", async () => {
  await assert.rejects(
    insert("notify", {}, { id: randomUUID(), dedup: job }),
    /duplicate key/,
  );
});
test("prepare projects current DB display and durably starts, repeat never sends", async () => {
  const c = (await claim()).jobs[0];
  await db.exec(
    "UPDATE public.event_members SET display_name='Changed synthetic'",
  );
  const r = await call("prepare", { lease_id: c.lease_id });
  assert.equal(r.code, "SEND");
  assert.equal(r.notification.display_name, "Changed synthetic");
  assert.deepEqual(
    Object.keys(r.notification).sort(),
    [
      "job_id",
      "event_id",
      "post_id",
      "category",
      "display_name",
      "report_count",
    ].sort(),
  );
  assert.equal((await row()).ops_state, "started");
  assert.equal((await call("prepare", { lease_id: c.lease_id })).code, "STALE");
});
test("started expired crash is ambiguous, never reclaims/succeeds", async () => {
  await prepare();
  await db.exec(
    "UPDATE public.outbox_jobs SET ops_locked_until=now()-interval '1 second'",
  );
  const r = await claim();
  assert.equal(r.jobs.length, 0);
  assert.equal(r.held, 1);
  assert.equal((await row()).ops_state, "ambiguous");
  assert.equal((await row()).completed_at, null);
  assert.equal((await claim()).jobs.length, 0);
});
test("expired running lease reclaims with fresh lease, old lease cannot prepare/settle", async () => {
  const first = (await claim()).jobs[0];
  await db.exec(
    "UPDATE public.outbox_jobs SET ops_locked_until=now()-interval '1 second'",
  );
  const second = (await claim()).jobs[0];
  assert.notEqual(first.lease_id, second.lease_id);
  assert.equal(second.attempt, 2);
  assert.equal(
    (await call("prepare", { lease_id: first.lease_id })).code,
    "STALE",
  );
  assert.equal((await settle(first, "delivered")).code, "STALE");
});
for (const change of [
  "ops_attempt=5",
  "ops_deadline=now()-interval '1 second'",
])
  test(`finite exhausted ${change}`, async () => {
    await db.exec(`UPDATE public.outbox_jobs SET ${change}`);
    const r = await claim();
    assert.equal(r.jobs.length, 0);
    assert.equal(r.held, 1);
    assert.equal((await row()).ops_result, "RETRY_EXHAUSTED");
  });
test("settle before durable send intent is stale", async () => {
  const c = (await claim()).jobs[0];
  assert.equal((await settle(c, "delivered")).code, "STALE");
});
for (const [outcome, state, code] of [
  ["delivered", "done", "DONE"],
  ["ambiguous", "ambiguous", "AMBIGUOUS"],
  ["rejected", "held", "HELD"],
])
  test(`settle ${outcome} is durable and idempotent no double audit`, async () => {
    const { c } = await prepare();
    assert.equal((await settle(c, outcome)).code, code);
    assert.equal((await row()).ops_state, state);
    assert.equal(Boolean((await row()).completed_at), outcome === "delivered");
    assert.equal((await settle(c, outcome)).code, "STALE");
    const logs = (await db.query("SELECT * FROM public.audit_logs")).rows;
    assert.equal(logs.length, 1);
    assert.equal(logs[0].actor_id, null);
    assert.equal(JSON.stringify(logs).includes("Synthetic"), false);
  });
test("429 known rejection releases lease with backoff, keeps deadline and bounded attempts", async () => {
  const { c } = await prepare();
  const deadline = (await row()).ops_deadline;
  assert.equal((await settle(c, "retry", 60)).code, "RETRY");
  let r = await row();
  assert.equal(r.ops_state, "pending");
  assert.equal(r.ops_lease_id, null);
  assert.equal(r.completed_at, null);
  assert.deepEqual(r.ops_deadline, deadline);
  assert.equal((await claim()).jobs.length, 0);
  await db.exec(
    "UPDATE public.outbox_jobs SET available_at=now()-interval '1 second',ops_attempt=4",
  );
  const next = await prepare();
  assert.equal(next.c.attempt, 5);
  assert.equal((await settle(next.c, "retry", 1)).code, "HELD");
  r = await row();
  assert.equal(r.ops_result, "RETRY_EXHAUSTED");
});
test("retry beyond deadline holds instead of shortening Retry-After", async () => {
  const { c } = await prepare();
  assert.equal((await settle(c, "retry", 86400)).code, "HELD");
});
for (const input of [
  { outcome: "made-up", retry_seconds: 0 },
  { outcome: "retry", retry_seconds: -1 },
  { outcome: "retry", retry_seconds: 86401 },
  { outcome: "retry", retry_seconds: 1.1 },
  { outcome: "retry", retry_seconds: "1" },
  { outcome: "delivered", retry_seconds: 1 },
  { outcome: "delivered", retry_seconds: 0, raw: "secret" },
])
  test(`invalid settle ${JSON.stringify(input)}`, async () => {
    const { c } = await prepare();
    assert.equal(
      (await call("settle", { lease_id: c.lease_id, ...input })).code,
      "INVALID_INPUT",
    );
    assert.equal((await row()).ops_state, "started");
  });
for (const value of [
  {},
  { category: "unknown" },
  { category: "capacity" },
  { category: "block", post_version: 4 },
  { category: "block", post_version: 0 },
  { category: "block", post_version: 1.1 },
  { category: "block", post_version: "3" },
  { category: "block", post_version: 3, url: "https://bad" },
  { category: "ban", user_id: "bad" },
  { category: "ban", user_id: randomUUID() },
  { category: "report", report_count: 3 },
  { category: "report", report_count: 1 },
  { category: "appeal", appeal_id: randomUUID() },
])
  test(`invalid notification ${JSON.stringify(value)} is held without IO projection`, async () => {
    await payload(value);
    assert.equal((await prepare()).result.code, "HELD");
    assert.equal((await row()).ops_result, "INVALID_PAYLOAD");
  });
for (const category of [
  "flag",
  "block",
  "ai_error",
  "stream_failure",
  "processing_error",
])
  test(`notification ${category} valid and minimal`, async () => {
    await payload({ category, post_version: 2 });
    const r = (await prepare()).result;
    assert.equal(r.code, "SEND");
    assert.equal(r.notification.category, category);
    assert.equal(r.notification.post_id, post);
  });
for (const report_count of [1, 2])
  test(`report ${report_count} notifies also after hidden`, async () => {
    await db.exec("UPDATE public.posts SET report_count=2");
    await payload({ category: "report", report_count });
    assert.equal(
      (await prepare()).result.notification.report_count,
      report_count,
    );
  });
test("BAN notification can lack post; current ban state not required for historical alert", async () => {
  await payload({ category: "ban", user_id: owner }, "notify", null);
  const r = (await prepare()).result;
  assert.equal(r.code, "SEND");
  assert.equal(r.notification.post_id, null);
});
test("appeal owner resolved from authoritative row without message", async () => {
  const appeal = randomUUID();
  await db.query(
    "INSERT INTO public.appeals(event_id,id,user_id,message) VALUES($1,$2,$3,'not for Discord')",
    [event, appeal, owner],
  );
  await payload({ category: "appeal", appeal_id: appeal }, "notify", null);
  const r = (await prepare()).result;
  assert.equal(r.code, "SEND");
  assert.equal(JSON.stringify(r).includes("not for Discord"), false);
});
test("post/appeal relationship mismatch held", async () => {
  const appeal = randomUUID();
  await db.query(
    "INSERT INTO public.appeals(event_id,id,user_id,message) VALUES($1,$2,$3,'private')",
    [event, appeal, owner],
  );
  await payload({ category: "appeal", appeal_id: appeal });
  assert.equal((await prepare()).result.code, "HELD");
});
test("kill-switch does not silence operations, dedicated flag stops prepare", async () => {
  await db.exec(
    "UPDATE public.event_settings SET publication_stopped=true,uploads_enabled=false",
  );
  const c = (await claim()).jobs[0];
  assert.ok(c);
  await db.exec(
    "UPDATE public.event_settings SET operational_outbox_enabled=false",
  );
  assert.equal(
    (await call("prepare", { lease_id: c.lease_id })).code,
    "DISABLED",
  );
  assert.equal((await row()).ops_state, "running");
});
async function publish() {
  await db.exec(
    "UPDATE public.posts SET status='published',moderation_verdict='PASS',published_at=now()",
  );
}
test("revoke records application gate only, never provider revocation", async () => {
  await payload({ post_version: 3 }, "revoke_delivery");
  const r = (await prepare()).result;
  assert.equal(r.result, "APPLICATION_GATE_CHECKED");
  assert.equal(r.code, "DONE");
  assert.equal((await row()).ops_result, "APPLICATION_GATE_CHECKED");
});
test("old revoke restored newer publication is superseded", async () => {
  await publish();
  await payload({ post_version: 2 }, "revoke_delivery");
  assert.equal((await prepare()).result.result, "SUPERSEDED");
});
test("same-version published revoke cannot claim gate denial", async () => {
  await publish();
  await payload({ post_version: 3 }, "revoke_delivery");
  assert.equal((await prepare()).result.result, "INVALID_PAYLOAD");
});
for (const change of [
  "UPDATE public.event_members SET is_banned=true,banned_at=now()",
  "UPDATE public.event_settings SET publication_stopped=true",
  "UPDATE public.events SET status='private'",
  "DELETE FROM public.consents",
])
  test(`revoke verifies live current gate ${change}`, async () => {
    await publish();
    await db.exec(change);
    await payload({ post_version: 3 }, "revoke_delivery");
    assert.equal((await prepare()).result.result, "APPLICATION_GATE_CHECKED");
  });
async function deletePost() {
  await db.exec(
    "UPDATE public.posts SET status='deleted',deleted_at=now(); UPDATE public.media_assets SET deletion_requested_at=now()",
  );
  await payload({ post_version: 3, asset_id: asset }, "delete_assets");
}
test("unknown original retention is held, zero physical deletion", async () => {
  await deletePost();
  assert.equal((await prepare()).result.result, "RETENTION_UNKNOWN");
  assert.equal((await row()).completed_at, null);
  assert.equal(
    (await db.query("SELECT physically_deleted_at FROM public.media_assets"))
      .rows[0].physically_deleted_at,
    null,
  );
});
test("future retention remains held", async () => {
  await deletePost();
  await db.exec(
    "UPDATE public.media_assets SET retention_until=now()+interval '1 day'",
  );
  assert.equal((await prepare()).result.result, "RETENTION_PENDING");
});
test("elapsed DB retention is NOT proof provider lock allows deletion", async () => {
  await deletePost();
  await db.exec(
    "UPDATE public.media_assets SET retention_until=now()-interval '1 day'",
  );
  assert.equal(
    (await prepare()).result.result,
    "PHYSICAL_DELETION_NOT_ENABLED",
  );
  assert.equal((await row()).completed_at, null);
});
test("existing authoritative physically-deleted evidence can acknowledge reservation", async () => {
  await deletePost();
  await db.exec("UPDATE public.media_assets SET physically_deleted_at=now()");
  assert.equal((await prepare()).result.result, "ALREADY_DELETED");
  assert.ok((await row()).completed_at);
});
for (const change of [
  "UPDATE public.media_assets SET deletion_requested_at=NULL",
  "UPDATE public.posts SET status='uploaded',deleted_at=NULL",
])
  test(`deletion requires logical intent ${change}`, async () => {
    await deletePost();
    await db.exec(change);
    assert.equal((await prepare()).result.result, "INVALID_PAYLOAD");
  });
test("delete asset scope mismatch cannot disclose key/UID", async () => {
  await deletePost();
  await payload({ post_version: 3, asset_id: randomUUID() }, "delete_assets");
  const r = (await prepare()).result;
  assert.equal(r.result, "INVALID_PAYLOAD");
  assert.equal(JSON.stringify(r).includes("object"), false);
});
test("bad prepare shape cannot consume lease", async () => {
  const c = (await claim()).jobs[0];
  for (const input of [
    { lease_id: "bad" },
    { lease_id: c.lease_id, extra: true },
    {},
  ])
    assert.equal((await call("prepare", input)).code, "INVALID_INPUT");
  assert.equal((await row()).ops_state, "running");
});
