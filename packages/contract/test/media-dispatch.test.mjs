import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { before, beforeEach, after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const event = "11111111-1111-4111-8111-111111111111";
const otherEvent = "22222222-2222-4222-8222-222222222222";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const post = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const asset = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
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
  for (const scope of [event, otherEvent]) {
    await db.query(
      `INSERT INTO public.events(event_id,slug,name,status,starts_at,ends_at,archive_at,private_at,terms_version)
      VALUES($1::uuid,$1::text,'Fixture','live','2026-10-01','2026-10-11','2026-11-11','2027-01-11','test')`,
      [scope],
    );
    await db.query(
      "INSERT INTO public.event_members(event_id,user_id,display_name) VALUES($1,$2,'Owner')",
      [scope, owner],
    );
  }
  await db.query(
    "INSERT INTO public.posts(event_id,id,user_id,kind,client_request_id,declared_content_type,original_scope,status) VALUES($1,$2,$3,'photo',$2,'image/jpeg','photo_file','uploaded')",
    [event, post, owner],
  );
});
after(async () => db.close());
async function insert({
  scope = event,
  kind = "process_media",
  payload = {
    asset_id: asset,
    post_version: 2,
    object_version: "private",
    object_etag: "private",
  },
} = {}) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO public.outbox_jobs(id,event_id,post_id,kind,deduplication_key,payload) VALUES($1::uuid,$2,$3,$4,$1::text,$5)",
    [id, scope, scope === event ? post : null, kind, JSON.stringify(payload)],
  );
  return id;
}
async function rpc(name, input, role = "service_role") {
  assert.ok(["claim_media_dispatch", "settle_media_dispatch"].includes(name));
  assert.ok(["service_role", "anon", "authenticated"].includes(role));
  await db.exec(`SET ROLE ${role}`);
  try {
    return (await db.query(`SELECT public.${name}($1) result`, [input])).rows[0]
      .result;
  } finally {
    await db.exec("RESET ROLE");
  }
}
const claim = (limit = 10, role) => rpc("claim_media_dispatch", limit, role);
const settle = (items, role) =>
  rpc("settle_media_dispatch", JSON.stringify(items), role);
const ack = (job, outcome = "sent") => ({
  job_id: job.job_id,
  attempt: job.attempt,
  outcome,
});
const row = async (id) =>
  (await db.query("SELECT * FROM public.outbox_jobs WHERE id=$1", [id]))
    .rows[0];
test("service-only invoker functions, empty search path and outbox RLS retained", async () => {
  for (const [name, signature, input] of [
    ["claim_media_dispatch", "integer", 10],
    ["settle_media_dispatch", "jsonb", "[]"],
  ]) {
    const meta = (
      await db.query(
        "SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure",
        [`public.${name}(${signature})`],
      )
    ).rows[0];
    assert.equal(meta.prosecdef, false);
    assert.ok(meta.proconfig.some((v) => /^search_path=(""|)$/.test(v)));
    for (const role of ["anon", "authenticated"])
      await assert.rejects(rpc(name, input, role), /permission denied/);
  }
  assert.equal(
    (
      await db.query(
        "SELECT relrowsecurity FROM pg_class WHERE oid='public.outbox_jobs'::regclass",
      )
    ).rows[0].relrowsecurity,
    true,
  );
});
test("claim leases once, projects minimal identifiers, and preserves processing fields", async () => {
  const id = await insert();
  const original = await row(id);
  const first = await claim();
  assert.deepEqual(first, {
    code: "ok",
    exhausted: false,
    jobs: [
      {
        job_id: id,
        event_id: event,
        post_id: post,
        asset_id: asset,
        post_version: 2,
        attempt: 1,
      },
    ],
  });
  assert.equal((await claim()).jobs.length, 0);
  const current = await row(id);
  assert.ok(current.dispatch_locked_until > current.dispatch_available_at);
  for (const key of [
    "attempt",
    "available_at",
    "locked_until",
    "completed_at",
    "payload",
  ])
    assert.deepEqual(current[key], original[key]);
});
test("claim is bounded and oldest-first across events, without taking other job kinds", async () => {
  const oldest = await insert({ scope: otherEvent });
  await db.query(
    "UPDATE public.outbox_jobs SET dispatch_available_at=now()-interval '1 hour' WHERE id=$1",
    [oldest],
  );
  for (let i = 0; i < 12; i++) await insert();
  for (const kind of ["notify", "delete_assets", "revoke_delivery", "export"])
    await insert({ kind });
  const result = await claim();
  assert.equal(result.jobs.length, 10);
  assert.equal(result.jobs[0].job_id, oldest);
  assert.equal((await claim()).jobs.length, 3);
  assert.equal((await claim()).jobs.length, 0);
});
test("fifty-row batch admits the thirty-per-minute target with bounded retry headroom", async () => {
  for (let i = 0; i < 51; i++) await insert();
  const batch = await claim(50);
  assert.equal(batch.jobs.length, 50);
  assert.equal(new Set(batch.jobs.map((j) => j.job_id)).size, 50);
  assert.deepEqual(await settle(batch.jobs.map((j) => ack(j))), {
    code: "ok",
    settled: 50,
    stale: 0,
  });
  assert.equal((await claim(50)).jobs.length, 1);
});

test("skips future, leased, completed, dispatched, and exhausted work", async () => {
  for (const expr of [
    "dispatch_available_at=now()+interval '1 hour'",
    "dispatch_locked_until=now()+interval '1 hour'",
    "completed_at=now()",
    "dispatched_at=now()",
    "dispatch_attempt=8",
  ]) {
    const id = await insert();
    await db.query(`UPDATE public.outbox_jobs SET ${expr} WHERE id=$1`, [id]);
  }
  assert.deepEqual(await claim(), { code: "ok", jobs: [], exhausted: true });
});
test("sent acknowledgement only records delivery, idempotently; never publishes or completes", async () => {
  const id = await insert();
  const [job] = (await claim()).jobs;
  assert.deepEqual(await settle([ack(job)]), {
    code: "ok",
    settled: 1,
    stale: 0,
  });
  assert.deepEqual(await settle([ack(job)]), {
    code: "ok",
    settled: 0,
    stale: 1,
  });
  const current = await row(id);
  assert.ok(current.dispatched_at);
  assert.equal(current.completed_at, null);
  assert.equal(current.locked_until, null);
  assert.equal(current.attempt, 0);
  assert.equal(current.dispatch_locked_until, null);
  assert.deepEqual(
    (
      await db.query("SELECT status,version FROM public.posts WHERE id=$1", [
        post,
      ])
    ).rows[0],
    { status: "uploaded", version: 1 },
  );
});
test("retry uses capped exponential backoff, stops after eight attempts and retains poison work", async () => {
  const id = await insert({
    payload: {
      asset_id: "sensitive".repeat(10000),
      post_version: "invalid",
      private: "secret",
    },
  });
  for (let attempt = 1; attempt <= 8; attempt++) {
    const [job] = (await claim()).jobs;
    assert.equal(job.attempt, attempt);
    assert.equal(job.asset_id, null);
    assert.equal(job.post_version, null);
    const start = Date.now();
    await settle([ack(job, "retry")]);
    const current = await row(id);
    const delay = new Date(current.dispatch_available_at).getTime() - start;
    assert.ok(delay >= Math.min(900, 15 * 2 ** (attempt - 1)) * 1000 - 1000);
    assert.ok(delay < Math.min(900, 15 * 2 ** (attempt - 1)) * 1000 + 10000);
    assert.equal((await claim()).jobs.length, 0);
    await db.query(
      "UPDATE public.outbox_jobs SET dispatch_available_at=now()-interval '1 second' WHERE id=$1",
      [id],
    );
  }
  assert.deepEqual(await claim(), { code: "ok", jobs: [], exhausted: true });
  assert.equal((await row(id)).payload.private, "secret");
  await insert();
  assert.equal((await claim()).jobs.length, 1);
});
test("expired and older attempts cannot settle a renewed lease", async () => {
  const id = await insert();
  const [old] = (await claim()).jobs;
  await db.query(
    "UPDATE public.outbox_jobs SET dispatch_locked_until=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  assert.equal((await settle([ack(old)])).stale, 1);
  const [newer] = (await claim()).jobs;
  assert.equal(newer.attempt, 2);
  assert.equal((await settle([ack(old)])).stale, 1);
  assert.equal((await settle([ack(newer)])).settled, 1);
});
test("last attempt is not exhausted while leased; a crash becomes visible after expiry", async () => {
  const id = await insert();
  await db.query(
    "UPDATE public.outbox_jobs SET dispatch_attempt=7 WHERE id=$1",
    [id],
  );
  assert.equal((await claim()).exhausted, false);
  assert.equal((await claim()).exhausted, false);
  await db.query(
    "UPDATE public.outbox_jobs SET dispatch_locked_until=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  assert.deepEqual(await claim(), { code: "ok", jobs: [], exhausted: true });
  assert.equal((await row(id)).completed_at, null);
});
test("null assets and fractional/oversized/string versions never expose raw payload", async () => {
  for (const version of [null, "2", 0, -1, 1.5, 2147483648]) {
    await insert({
      payload: { asset_id: null, post_version: version, secret: "private" },
    });
  }
  const result = await claim();
  assert.equal(result.jobs.length, 6);
  for (const job of result.jobs) {
    assert.equal(job.asset_id, null);
    assert.equal(job.post_version, null);
    assert.equal(Object.keys(job).length, 6);
  }
});
test("claim and settle are transactional; rollback preserves pending work", async () => {
  const id = await insert();
  await db.exec("BEGIN");
  const [job] = (await claim()).jobs;
  await settle([ack(job)]);
  await db.exec("ROLLBACK");
  assert.equal((await row(id)).dispatch_attempt, 0);
  assert.equal((await row(id)).dispatched_at, null);
  assert.equal((await claim()).jobs[0].attempt, 1);
});
test("rejects stronger isolation instead of accepting stale snapshots", async () => {
  await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
  await assert.rejects(
    db.query("SELECT public.claim_media_dispatch(10)"),
    /requires READ COMMITTED/,
  );
  await db.exec("ROLLBACK");
  await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
  await assert.rejects(
    db.query("SELECT public.settle_media_dispatch('[]')"),
    /requires READ COMMITTED/,
  );
  await db.exec("ROLLBACK");
});
for (const value of [null, 0, -1, 51])
  test(`invalid limit ${value}`, async () => {
    const id = await insert();
    assert.equal((await claim(value)).code, "INVALID_INPUT");
    assert.equal((await row(id)).dispatch_attempt, 0);
  });
for (const patch of [
  {},
  { attempt: null },
  { attempt: "1" },
  { attempt: 0 },
  { attempt: 9 },
  { attempt: 1.5 },
  { job_id: "bad" },
  { outcome: null },
  { outcome: "completed" },
  { extra: true },
])
  test(`invalid batch rolls back before any settlement ${JSON.stringify(patch)}`, async () => {
    await insert();
    await insert();
    const [first, second] = (await claim()).jobs;
    const bad = Object.keys(patch).length ? { ...ack(second), ...patch } : {};
    assert.equal((await settle([ack(first), bad])).code, "INVALID_INPUT");
    for (const job of [first, second])
      assert.equal((await row(job.job_id)).dispatched_at, null);
  });
test("empty, oversized, duplicate, non-array and null settlement inputs are rejected", async () => {
  await insert();
  const [job] = (await claim()).jobs;
  for (const input of [
    [],
    null,
    {},
    [null],
    [ack(job), ack(job)],
    Array(51).fill(ack(job)),
  ])
    assert.equal((await settle(input)).code, "INVALID_INPUT");
  assert.equal((await row(job.job_id)).dispatched_at, null);
});
test("absent, finished, wrong-kind and unleased acknowledgements are stale", async () => {
  const ids = [randomUUID(), await insert({ kind: "notify" }), await insert()];
  const response = await settle(
    ids.map((job_id) => ({
      job_id,
      attempt: 1,
      outcome: "sent",
    })),
  );
  assert.equal(response.settled, 0);
  assert.equal(response.stale, 3);
  const [job] = (await claim(1)).jobs;
  await db.query(
    "UPDATE public.outbox_jobs SET completed_at=now() WHERE id=$1",
    [job.job_id],
  );
  assert.equal((await settle([ack(job)])).stale, 1);
});
