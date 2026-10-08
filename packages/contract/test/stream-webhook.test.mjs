import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite();
const event = "11111111-1111-4111-8111-111111111111",
  owner = "22222222-2222-4222-8222-222222222222",
  post = "33333333-3333-4333-8333-333333333333",
  asset = "44444444-4444-4444-8444-444444444444",
  job = "55555555-5555-4555-8555-555555555555";
const uid = "a".repeat(32),
  etag = "c".repeat(32);
let plan, operation;
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
    "INSERT INTO public.event_settings(event_id,publication_stopped,uploads_enabled,stream_webhook_enabled) VALUES($1,false,true,true)",
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
  VALUES($1,$2,$3,'video','uploaded',$2,'video/mp4','client_trimmed',100,2)`,
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
    `INSERT INTO public.outbox_jobs(event_id,id,post_id,kind,deduplication_key,payload) VALUES($1,$2,$3,'process_media','fixture',$4)`,
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
  const claim = await stream("claim");
  assert.equal(claim.code, "CLAIMED");
  plan = claim.plan;
  const reservation = await stream("reserve", { plan, operation: "source" });
  assert.equal(reservation.code, "RESERVED");
  operation = reservation.operation;
});
after(() => db.close());
async function stream(action, input = {}) {
  await db.exec("SET ROLE service_role");
  try {
    return (
      await db.query(
        "SELECT public.manage_stream_processing($1,$2,$3,$4,$5) result",
        [event, post, job, action, JSON.stringify(input)],
      )
    ).rows[0].result;
  } finally {
    await db.exec("RESET ROLE");
  }
}
async function resolve({
  role = "service_role",
  eventId = event,
  postId = post,
  assetId = asset,
  jobId = job,
  version = 3,
  operationId = operation.operationId,
  streamUid = uid,
  sourceUid = null,
} = {}) {
  assert.ok(["service_role", "anon", "authenticated"].includes(role));
  await db.exec(`SET ROLE ${role}`);
  try {
    return (
      await db.query(
        "SELECT public.resolve_stream_webhook($1,$2,$3,$4,$5,$6,$7,$8) result",
        [
          eventId,
          postId,
          assetId,
          jobId,
          version,
          operationId,
          streamUid,
          sourceUid,
        ],
      )
    ).rows[0].result;
  } finally {
    await db.exec("RESET ROLE");
  }
}
const ready = (jobId = job, version = 3) => ({
  code: "READY",
  message: {
    version: 1,
    kind: "process_media",
    event_id: event,
    post_id: post,
    asset_id: asset,
    job_id: jobId,
    post_version: version,
  },
});
async function observe(
  reference = { operationId: operation.operationId, uid, sourceUid: null },
  operationName = "source",
) {
  const result = await stream("observe", {
    plan,
    operation: operationName,
    observation: {
      reference,
      state: "ready",
      requireSignedURLs: true,
      readyToStream: true,
      processingComplete: true,
      measuredDurationSeconds: 3.8,
      width: 1280,
      height: 720,
      modifiedAt: new Date(Date.now() - 1000).toISOString(),
    },
  });
  assert.equal(result.code, "OBSERVED");
}
const snapshot = async () => ({
  posts: (await db.query("SELECT to_jsonb(p) row FROM public.posts p")).rows,
  assets: (
    await db.query(
      "SELECT to_jsonb(a) row FROM public.media_assets a ORDER BY id",
    )
  ).rows,
  jobs: (
    await db.query(
      "SELECT to_jsonb(j) row FROM public.outbox_jobs j ORDER BY id",
    )
  ).rows,
});
test("durable UID-null reservation resolves an existing DB hint before observe with zero mutations", async () => {
  const before = await snapshot();
  assert.deepEqual(await resolve(), ready());
  assert.deepEqual(await resolve(), ready());
  assert.deepEqual(await snapshot(), before);
  assert.equal(before.assets.length, 1);
});
test("known private Stream UID must match saved reservation and asset", async () => {
  await observe();
  assert.deepEqual(await resolve(), ready());
  assert.deepEqual(await resolve({ streamUid: "b".repeat(32) }), {
    code: "IGNORED",
  });
});
for (const role of ["anon", "authenticated"])
  test(`${role} cannot turn a callback into Queue work`, async () => {
    await assert.rejects(resolve({ role }), /permission denied/);
  });
test("webhook DB flag is default OFF", async () => {
  await db.exec("DELETE FROM public.event_settings");
  await db.query(
    "INSERT INTO public.event_settings(event_id,publication_stopped,uploads_enabled) VALUES($1,false,true)",
    [event],
  );
  assert.equal(
    (await db.query("SELECT stream_webhook_enabled FROM public.event_settings"))
      .rows[0].stream_webhook_enabled,
    false,
  );
  assert.deepEqual(await resolve(), { code: "IGNORED" });
});
for (const change of [
  { eventId: randomUUID() },
  { postId: randomUUID() },
  { assetId: randomUUID() },
  { jobId: randomUUID() },
  { operationId: randomUUID() },
  { version: 2 },
  { version: 4 },
  { version: 0 },
  { version: 2147483648 },
  { streamUid: "private-url" },
  { sourceUid: uid },
  { sourceUid: "b".repeat(32) },
  { eventId: null },
  { operationId: null },
  { version: null },
])
  test(`foreign or invalid proof ${JSON.stringify(change)}`, async () => {
    assert.deepEqual(await resolve(change), { code: "IGNORED" });
  });
for (const statement of [
  "UPDATE public.event_members SET is_banned=true,banned_at=now()",
  "UPDATE public.event_settings SET stream_webhook_enabled=false",
  "UPDATE public.event_settings SET publication_stopped=true",
  "UPDATE public.event_settings SET uploads_enabled=false",
  "DELETE FROM public.consents",
  "UPDATE public.events SET terms_version='new'",
  "UPDATE public.events SET status='archive'",
  "UPDATE public.posts SET ban_latched=true",
  "UPDATE public.posts SET status='deleted',deleted_at=now(),version=4",
  "UPDATE public.posts SET status='held',processing_error='STREAM_TIMEOUT',version=4",
  "UPDATE public.media_assets SET object_version='replaced'",
  "UPDATE public.media_assets SET object_etag='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'",
  "UPDATE public.media_assets SET deletion_requested_at=now()",
  "UPDATE public.outbox_jobs SET completed_at=now()",
  "UPDATE public.outbox_jobs SET stream_state='{}'",
  "UPDATE public.outbox_jobs SET stream_state=jsonb_set(stream_state,'{source,providerPostVersion}','2')",
  "UPDATE public.outbox_jobs SET stream_state=jsonb_set(stream_state,'{source,providerJobId}','\"99999999-9999-4999-8999-999999999999\"')",
])
  test(`changed acceptance/original/generation ignored: ${statement}`, async () => {
    await db.exec(statement);
    assert.deepEqual(await resolve(), { code: "IGNORED" });
  });
test("duplicate active jobs are ambiguous and do not return an arbitrary hint", async () => {
  await db.query(
    "INSERT INTO public.outbox_jobs(event_id,post_id,kind,deduplication_key,payload) SELECT event_id,post_id,kind,'duplicate',payload FROM public.outbox_jobs WHERE id=$1",
    [job],
  );
  assert.deepEqual(await resolve(), { code: "IGNORED" });
});
test("old provider generation wakes a current retry only for the same immutable original", async () => {
  const retry = randomUUID();
  await db.exec(
    "UPDATE public.posts SET version=5; UPDATE public.outbox_jobs SET completed_at=now()",
  );
  await db.query(
    "INSERT INTO public.outbox_jobs(event_id,id,post_id,kind,deduplication_key,payload) SELECT event_id,$1,post_id,kind,'retry',jsonb_set(payload,'{post_version}','5') FROM public.outbox_jobs WHERE id=$2",
    [retry, job],
  );
  assert.deepEqual(await resolve(), ready(retry, 5));
  await db.query("UPDATE public.outbox_jobs SET stream_state=$1 WHERE id=$2", [
    JSON.stringify({ source: { ...operation, operationId: randomUUID() } }),
    retry,
  ]);
  assert.deepEqual(await resolve(), { code: "IGNORED" });
});
test("reuse of known generation accepts matching provenance, never webhook postVersion as current", async () => {
  await observe();
  const retry = randomUUID();
  await db.exec(
    "UPDATE public.posts SET version=5; UPDATE public.outbox_jobs SET completed_at=now()",
  );
  await db.query(
    "INSERT INTO public.outbox_jobs(event_id,id,post_id,kind,deduplication_key,payload,stream_state) SELECT event_id,$1,post_id,kind,'retry',jsonb_set(payload,'{post_version}','5'),stream_state FROM public.outbox_jobs WHERE id=$2",
    [retry, job],
  );
  assert.deepEqual(await resolve(), ready(retry, 5));
});
test("deleted Stream evidence cannot be revived by a signed callback", async () => {
  await observe();
  await db.exec(
    "UPDATE public.media_assets SET deletion_requested_at=now() WHERE purpose='stream_source'",
  );
  assert.deepEqual(await resolve(), { code: "IGNORED" });
});
test("fallback clip source parent and operation are matched before wakeup", async () => {
  await db.exec("UPDATE public.posts SET original_scope='full_video_fallback'");
  await observe();
  const reservation = await stream("reserve", { plan, operation: "clip" });
  assert.equal(reservation.code, "RESERVED");
  const clip = reservation.operation;
  assert.deepEqual(
    await resolve({
      operationId: clip.operationId,
      streamUid: "b".repeat(32),
      sourceUid: uid,
    }),
    ready(),
  );
  assert.deepEqual(
    await resolve({
      operationId: clip.operationId,
      streamUid: "b".repeat(32),
      sourceUid: "c".repeat(32),
    }),
    { code: "IGNORED" },
  );
});
test("repeatable read cannot use stale state as dispatch proof", async () => {
  await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    await assert.rejects(
      db.query(
        "SELECT public.resolve_stream_webhook($1,$2,$3,$4,$5,$6,$7,$8)",
        [event, post, asset, job, 3, operation.operationId, uid, null],
      ),
      /requires READ COMMITTED/,
    );
  } finally {
    await db.exec("ROLLBACK");
  }
});
