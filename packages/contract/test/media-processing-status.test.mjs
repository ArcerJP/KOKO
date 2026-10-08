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
    "INSERT INTO public.event_members(event_id,user_id,display_name) VALUES($1,$2,'Synthetic')",
    [event, owner],
  );
  await db.query(
    "INSERT INTO public.consents(event_id,user_id,terms_version) VALUES($1,$2,'test')",
    [event, owner],
  );
  await db.query(
    `INSERT INTO public.posts(event_id,id,user_id,kind,status,client_request_id,declared_content_type,original_scope,original_bytes,version)
  VALUES($1,$2,$3,'photo','uploaded',$2,'image/heic','photo_file',100,2)`,
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
});
after(() => db.close());
async function status({
  role = "service_role",
  eventId = event,
  postId = post,
  jobId = job,
  assetId = asset,
  version = 2,
} = {}) {
  assert.ok(["anon", "authenticated", "service_role"].includes(role));
  await db.exec(`SET ROLE ${role}`);
  try {
    return (
      await db.query(
        "SELECT public.media_processing_status($1,$2,$3,$4,$5) result",
        [eventId, postId, jobId, assetId, version],
      )
    ).rows[0].result;
  } finally {
    await db.exec("RESET ROLE");
  }
}
async function rpc(name, action, input = {}) {
  assert.ok(
    ["manage_stream_processing", "manage_image_processing"].includes(name),
  );
  await db.exec("SET ROLE service_role");
  try {
    return (
      await db.query(`SELECT public.${name}($1,$2,$3,$4,$5) result`, [
        event,
        post,
        job,
        action,
        JSON.stringify(input),
      ])
    ).rows[0].result;
  } finally {
    await db.exec("RESET ROLE");
  }
}
test("new upload READY is read-only and carries no private asset data", async () => {
  const before = (
    await db.query("SELECT to_jsonb(j) row FROM public.outbox_jobs j")
  ).rows;
  assert.deepEqual(await status(), { code: "READY", kind: "photo" });
  assert.deepEqual(
    (await db.query("SELECT to_jsonb(j) row FROM public.outbox_jobs j")).rows,
    before,
  );
});
for (const role of ["anon", "authenticated"])
  test(`${role} cannot execute private Queue status RPC`, async () => {
    await assert.rejects(status({ role }), /permission denied/);
  });
for (const input of [
  { version: 0 },
  { version: 2147483648 },
  { version: null },
  { eventId: null },
  { postId: null },
  { jobId: null },
  { assetId: null },
])
  test(`invalid parameters ${JSON.stringify(input)}`, async () => {
    assert.deepEqual(await status(input), { code: "INVALID_INPUT" });
  });
for (const field of ["eventId", "postId", "jobId"])
  test(`missing scope ${field} is not found`, async () => {
    assert.deepEqual(await status({ [field]: randomUUID() }), {
      code: "NOT_FOUND",
    });
  });
test("queue asset/version mismatch cannot claim work", async () => {
  assert.deepEqual(await status({ assetId: randomUUID() }), {
    code: "INVALID_INPUT",
  });
  assert.deepEqual(await status({ version: 3 }), { code: "INVALID_INPUT" });
});
test("image runner's real saved receipt is not a terminal moderation receipt", async () => {
  const claim = await rpc("manage_image_processing", "claim");
  assert.equal(claim.code, "CLAIMED");
  assert.deepEqual(await status(), { code: "READY", kind: "photo" });
  const plan = claim.plan;
  const saved = await rpc("manage_image_processing", "finish", {
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
  assert.equal(saved.code, "RECORDED");
  assert.deepEqual(await status(), { code: "READY", kind: "photo" });
});
test("Stream claim's real version transition preserves the initial Queue hint", async () => {
  await db.exec(
    "UPDATE public.posts SET kind='video',declared_content_type='video/mp4',original_scope='client_trimmed'",
  );
  const claim = await rpc("manage_stream_processing", "claim");
  assert.equal(claim.code, "CLAIMED");
  const row = (
    await db.query(
      "SELECT payload,stream_initial_post_version FROM public.outbox_jobs",
    )
  ).rows[0];
  assert.equal(row.payload.post_version, 3);
  assert.equal(row.stream_initial_post_version, 2);
  assert.deepEqual(await status(), { code: "READY", kind: "video" });
  assert.deepEqual(await status({ version: 3 }), {
    code: "READY",
    kind: "video",
  });
  assert.deepEqual(await status({ version: 4 }), { code: "INVALID_INPUT" });
});
test("Stream held state after initial version transition is durable terminal proof", async () => {
  await db.exec(
    "UPDATE public.posts SET kind='video',declared_content_type='video/mp4',original_scope='client_trimmed'",
  );
  const claim = await rpc("manage_stream_processing", "claim");
  assert.equal(claim.code, "CLAIMED");
  const held = await rpc("manage_stream_processing", "hold", {
    plan: claim.plan,
    errorCode: "STREAM_PROCESSING_FAILED",
  });
  assert.equal(held.code, "HELD");
  assert.deepEqual(await status(), { code: "HELD" });
});
for (const decision of ["PASS", "FLAG", "BLOCK", "HELD"])
  test(`persisted completed moderation ${decision} ACK proof`, async () => {
    await db.query(
      "UPDATE public.outbox_jobs SET moderation_completed_at=now(),moderation_receipt=$1,completed_at=now()",
      [JSON.stringify({ decision })],
    );
    assert.deepEqual(await status(), { code: "TERMINAL" });
    // Later acceptance changes do not undo an already committed result.
    await db.exec(
      "UPDATE public.event_settings SET publication_stopped=true; UPDATE public.event_members SET is_banned=true,banned_at=now()",
    );
    assert.deepEqual(await status(), { code: "TERMINAL" });
  });
test("moderation receipt without durable job completion is not an ACK proof", async () => {
  await db.exec(
    `UPDATE public.outbox_jobs SET moderation_completed_at=now(),moderation_receipt='{"decision":"PASS"}'`,
  );
  assert.deepEqual(await status(), { code: "READY", kind: "photo" });
});
test("plain completion without moderation/held/supersession never ACKs", async () => {
  await db.exec("UPDATE public.outbox_jobs SET completed_at=now()");
  assert.deepEqual(await status(), { code: "DEFERRED" });
});
test("superseded generation requires old completion and a new same-post job", async () => {
  const next = randomUUID();
  await db.query(
    `INSERT INTO public.outbox_jobs(event_id,id,post_id,kind,deduplication_key,payload) VALUES($1,$2,$3,'process_media','newer',$4)`,
    [
      event,
      next,
      post,
      JSON.stringify({
        asset_id: asset,
        post_version: 4,
        object_etag: etag,
        object_version: "object-v1",
      }),
    ],
  );
  assert.deepEqual(await status(), { code: "READY", kind: "photo" });
  await db.query(
    "UPDATE public.outbox_jobs SET completed_at=now() WHERE id=$1",
    [job],
  );
  assert.deepEqual(await status(), { code: "SUPERSEDED" });
});
test("deleted generation ACKs without invoking providers", async () => {
  await db.exec(
    "UPDATE public.posts SET status='deleted',deleted_at=now(),version=3",
  );
  assert.deepEqual(await status(), { code: "TERMINAL" });
});
for (const statement of [
  "UPDATE public.event_members SET is_banned=true,banned_at=now()",
  "UPDATE public.event_settings SET publication_stopped=true",
  "UPDATE public.event_settings SET uploads_enabled=false",
  "UPDATE public.events SET status='draft'",
  "UPDATE public.events SET starts_at=now()+interval '1 hour'",
  "UPDATE public.events SET ends_at=now()-interval '2 hours',archive_at=now()-interval '1 hour',private_at=now()-interval '1 minute'",
  "UPDATE public.posts SET ban_latched=true",
  "UPDATE public.posts SET status='processing',version=4",
  "UPDATE public.media_assets SET deletion_requested_at=now()",
  "UPDATE public.media_assets SET object_version='other-version'",
  "UPDATE public.media_assets SET object_etag='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'",
  "DELETE FROM public.consents",
  "UPDATE public.events SET terms_version='newer'",
  "DELETE FROM public.event_settings",
])
  test(`deferred authorization/stale state: ${statement}`, async () => {
    await db.exec(statement);
    assert.deepEqual(await status(), { code: "DEFERRED" });
  });
test("previously accepted work may finish after the upload window but before private_at", async () => {
  await db.exec("UPDATE public.events SET ends_at=now()-interval '1 hour'");
  assert.deepEqual(await status(), { code: "READY", kind: "photo" });
});
test("repeatable read cannot use stale snapshots as proof", async () => {
  await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    await assert.rejects(
      db.query("SELECT public.media_processing_status($1,$2,$3,$4,$5)", [
        event,
        post,
        job,
        asset,
        2,
      ]),
      /requires READ COMMITTED/,
    );
  } finally {
    await db.exec("ROLLBACK");
  }
});
