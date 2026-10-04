import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { before, beforeEach, after, test } from "node:test";
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const event = "11111111-1111-4111-8111-111111111111";
const user = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const theme = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const request = {
  client_request_id: randomUUID(),
  kind: "photo",
  content_type: "image/jpeg",
  file_size_bytes: 123,
  original_scope: "photo_file",
};
const parts = Array.from({ length: 9 }, (_, i) => ({
  part_number: i + 1,
  etag: (i + 1).toString(16).repeat(32),
}));
const multiEtag =
  createHash("md5")
    .update(Buffer.from(parts.map((p) => p.etag).join(""), "hex"))
    .digest("hex") + "-9";
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
  // Isolated in-memory fixture only, never an external database.
  await db.exec("RESET ROLE; TRUNCATE public.events,auth.users CASCADE;");
  await db.query("INSERT INTO auth.users(id) VALUES($1),($2)", [user, other]);
  await db.query(
    `INSERT INTO public.events(event_id,slug,name,status,starts_at,ends_at,archive_at,private_at,terms_version)
    VALUES($1,'fixture','Fixture','live',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days',now()+interval '3 days','v1')`,
    [event],
  );
  await db.query(
    "INSERT INTO public.event_settings(event_id,uploads_enabled,publication_stopped) VALUES($1,true,false)",
    [event],
  );
  await db.query(
    "INSERT INTO public.event_members(event_id,user_id,display_name) VALUES($1,$2,'Fixture'),($1,$3,'Other')",
    [event, user, other],
  );
  await db.query(
    "INSERT INTO public.consents(event_id,user_id,terms_version) VALUES($1,$2,'v1'),($1,$3,'v1')",
    [event, user, other],
  );
  await db.query(
    `INSERT INTO public.themes(event_id,id,title,status,starts_at,ends_at) VALUES($1,$2,'Fixture','published',now()-interval '1 day',now()+interval '1 day')`,
    [event, theme],
  );
});
after(async () => db.close());
async function session(overrides = {}) {
  const attempt = randomUUID();
  let row = (
    await db.query(
      "SELECT public.manage_upload_session($1,$2,'open',$3) result",
      [
        event,
        user,
        JSON.stringify({
          request: { ...request, ...overrides },
          attempt_id: attempt,
        }),
      ],
    )
  ).rows[0].result;
  assert.ok(["ready", "provision"].includes(row.code));
  if (row.code === "provision")
    row = (
      await db.query(
        "SELECT public.manage_upload_session($1,$2,'attach',$3) result",
        [
          event,
          user,
          JSON.stringify({
            upload_id: row.upload_id,
            attempt_id: attempt,
            provider_upload_id: "provider-fixture",
          }),
        ],
      )
    ).rows[0].result;
  return row;
}
async function rpc(
  s,
  action = "prepare",
  input = { parts: [] },
  actor = user,
  scope = event,
  role = "service_role",
) {
  assert.ok(["service_role", "anon", "authenticated"].includes(role));
  await db.exec(`SET ROLE ${role}`);
  try {
    return (
      await db.query(
        "SELECT public.complete_upload($1,$2,$3,$4,$5,$6) result",
        [scope, actor, s.post_id, s.upload_id, action, JSON.stringify(input)],
      )
    ).rows[0].result;
  } finally {
    await db.exec("RESET ROLE");
  }
}
const observation = (s) => ({
  object_key: s.object_key,
  size: s.request.file_size_bytes,
  etag: s.mode === "multipart" ? multiEtag : "a".repeat(32),
  version: "r2-version-fixture",
});
const commit = (s, list = [], extra = {}) =>
  rpc(s, "commit", {
    parts: list,
    post_version: 1,
    observation: observation(s),
    ...extra,
  });
async function unchanged() {
  assert.deepEqual(
    (await db.query("SELECT status,original_bytes,version FROM public.posts"))
      .rows[0],
    { status: "uploading", original_bytes: null, version: 1 },
  );
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM public.outbox_jobs")).rows[0]
      .n,
    0,
  );
  assert.equal(
    (await db.query("SELECT byte_size FROM public.media_assets")).rows[0]
      .byte_size,
    null,
  );
}
test("service-only invoker, empty search path and nondefault isolation refusal", async () => {
  const s = await session();
  for (const role of ["anon", "authenticated"])
    await assert.rejects(
      rpc(s, "prepare", { parts: [] }, user, event, role),
      (e) => e.code === "42501",
    );
  const info = (
    await db.query(
      "SELECT prosecdef,proconfig FROM pg_proc WHERE oid='public.complete_upload(uuid,uuid,uuid,uuid,text,jsonb)'::regprocedure",
    )
  ).rows[0];
  assert.equal(info.prosecdef, false);
  assert.ok(info.proconfig.some((v) => /^search_path=(""|)$/.test(v)));
  await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    await assert.rejects(
      db.query("SELECT public.complete_upload($1,$2,$3,$4,'prepare',$5)", [
        event,
        user,
        s.post_id,
        s.upload_id,
        '{"parts":[]}',
      ]),
      (e) => e.code === "25001",
    );
  } finally {
    await db.exec("ROLLBACK");
  }
});
test("single HEAD commit atomically records bytes/version, one outbox and stable receipt", async () => {
  const s = await session();
  assert.equal((await rpc(s)).code, "prepared");
  await unchanged();
  const result = await commit(s);
  assert.equal(result.code, "completed");
  assert.equal(result.post.status, "uploaded");
  assert.equal(result.post.version, 2);
  assert.deepEqual(await rpc(s), result);
  assert.deepEqual(await commit(s), result);
  const asset = (
    await db.query(
      "SELECT byte_size,object_etag,object_version,sha256 FROM public.media_assets",
    )
  ).rows[0];
  assert.deepEqual(asset, {
    byte_size: 123,
    object_etag: "a".repeat(32),
    object_version: "r2-version-fixture",
    sha256: null,
  });
  assert.equal(
    (await db.query("SELECT detected_content_type FROM public.posts")).rows[0]
      .detected_content_type,
    null,
  );
  const jobs = (
    await db.query(
      "SELECT kind,deduplication_key,payload FROM public.outbox_jobs",
    )
  ).rows;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, "process_media");
  assert.equal(
    jobs[0].deduplication_key,
    `upload:${s.upload_id}:process_media`,
  );
  assert.equal(jobs[0].payload.post_version, 2);
  assert.equal(jobs[0].payload.asset_id, s.asset_id);
});
test("multipart freezes exact manifest, independent MD5 and same acknowledgement", async () => {
  const s = await session({ file_size_bytes: 67108865 });
  assert.equal((await rpc(s, "prepare", { parts })).code, "prepared");
  const changed = parts.map((p, i) => (i ? p : { ...p, etag: "f".repeat(32) }));
  assert.equal(
    (await rpc(s, "prepare", { parts: changed })).code,
    "IDEMPOTENCY_CONFLICT",
  );
  assert.equal(
    (
      await commit(s, parts, {
        observation: { ...observation(s), etag: "b".repeat(32) + "-9" },
      })
    ).code,
    "UPLOAD_INCOMPLETE",
  );
  const done = await commit(s, parts);
  assert.equal(done.code, "completed");
  assert.deepEqual(await rpc(s, "prepare", { parts }), done);
  assert.equal(
    (await rpc(s, "prepare", { parts: changed })).code,
    "IDEMPOTENCY_CONFLICT",
  );
});
test("foreign user/event/post/session and malformed requests never advance state", async () => {
  const s = await session();
  assert.equal(
    (await rpc(s, "prepare", { parts: [] }, other)).code,
    "NOT_FOUND",
  );
  assert.equal(
    (await rpc(s, "prepare", { parts: [] }, user, randomUUID())).code,
    "FORBIDDEN",
  );
  for (const altered of [
    { ...s, post_id: randomUUID() },
    { ...s, upload_id: randomUUID() },
  ])
    assert.equal((await rpc(altered)).code, "NOT_FOUND");
  for (const input of [
    null,
    [],
    {},
    { parts: null },
    { parts: [], user_id: user },
    { parts: [{ part_number: 1, etag: "x" }] },
    { parts: [{ part_number: 2, etag: "a".repeat(32) }] },
  ])
    assert.equal((await rpc(s, "prepare", input)).code, "INVALID_INPUT");
  assert.equal((await rpc(s, "other")).code, "INVALID_INPUT");
  await unchanged();
});
test("multipart rejects missing, gapped, extra, duplicate and noncanonical parts", async () => {
  const s = await session({ file_size_bytes: 67108865 });
  for (const list of [
    [],
    parts.slice(1),
    [...parts, parts[0]],
    parts.map((p) => ({ ...p, etag: '"' + p.etag + '"' })),
    parts.map((p) => ({ ...p, extra: 1 })),
  ])
    assert.equal(
      (await rpc(s, "prepare", { parts: list })).code,
      "INVALID_INPUT",
    );
  await unchanged();
});
for (const [label, sql, code] of [
  [
    "ban",
    `UPDATE public.event_members SET is_banned=true,banned_at=now() WHERE user_id='${user}'`,
    "ACCOUNT_BANNED",
  ],
  ["consent", "DELETE FROM public.consents", "CONSENT_REQUIRED"],
  [
    "stopped",
    "UPDATE public.event_settings SET publication_stopped=true",
    "PUBLICATION_STOPPED",
  ],
  [
    "closed",
    "UPDATE public.event_settings SET uploads_enabled=false",
    "EVENT_CLOSED",
  ],
  ["theme", "UPDATE public.themes SET status='draft'", "THEME_UNAVAILABLE"],
  [
    "asset deletion",
    "UPDATE public.media_assets SET deletion_requested_at=now()",
    "STATE_CONFLICT",
  ],
  ["latched", "UPDATE public.posts SET ban_latched=true", "STATE_CONFLICT"],
])
  test(`commit rechecks ${label} changed after prepare`, async () => {
    const s = await session({ theme_id: theme });
    assert.equal((await rpc(s)).code, "prepared");
    await db.exec(sql);
    assert.equal((await commit(s)).code, code);
    await unchanged();
  });
test("signature expiry does not grant a URL or prevent verification; event expiry does", async () => {
  const s = await session();
  await db.exec(
    "UPDATE public.upload_sessions SET expires_at=now()-interval '1 second'",
  );
  assert.equal((await rpc(s)).code, "prepared");
  await db.exec("UPDATE public.events SET ends_at=now()-interval '1 second'");
  assert.equal((await commit(s)).code, "EVENT_CLOSED");
  await unchanged();
});
test("commit requires prepare and matching observation/post version", async () => {
  const s = await session();
  assert.equal((await commit(s)).code, "STATE_CONFLICT");
  await rpc(s);
  for (const observed of [
    { ...observation(s), size: 124 },
    { ...observation(s), object_key: "other" },
    { ...observation(s), etag: "a".repeat(32) + "-2" },
  ])
    assert.equal(
      (await commit(s, [], { observation: observed })).code,
      "UPLOAD_INCOMPLETE",
    );
  for (const observed of [
    null,
    {},
    { ...observation(s), version: "" },
    { ...observation(s), size: "123" },
    { ...observation(s), extra: true },
  ])
    assert.ok(
      ["INVALID_INPUT", "UPLOAD_INCOMPLETE"].includes(
        (await commit(s, [], { observation: observed })).code,
      ),
    );
  assert.equal(
    (await commit(s, [], { post_version: 2 })).code,
    "STATE_CONFLICT",
  );
  await unchanged();
});
test("outbox failure rolls back all completion updates, not the previous prepare", async () => {
  const s = await session();
  await rpc(s);
  await db.exec(`CREATE FUNCTION public.fixture_no_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER fixture_no_job BEFORE INSERT ON public.outbox_jobs FOR EACH ROW EXECUTE FUNCTION public.fixture_no_job();`);
  try {
    await assert.rejects(commit(s), /Processing job was not inserted/);
    await unchanged();
    assert.deepEqual(
      (
        await db.query(
          "SELECT completion_parts,completed_at,completion_result FROM public.upload_sessions",
        )
      ).rows[0],
      { completion_parts: [], completed_at: null, completion_result: null },
    );
  } finally {
    await db.exec(
      "DROP TRIGGER fixture_no_job ON public.outbox_jobs; DROP FUNCTION public.fixture_no_job()",
    );
  }
  assert.equal((await commit(s)).code, "completed");
});
test("completed receipt survives closing and processing advance; deletion/BAN do not resurrect", async () => {
  const s = await session();
  await rpc(s);
  const done = await commit(s);
  await db.exec(
    "UPDATE public.event_settings SET uploads_enabled=false,publication_stopped=true; UPDATE public.posts SET status='processing',version=3",
  );
  assert.deepEqual(await rpc(s), done);
  assert.equal(
    (await db.query("SELECT version FROM public.posts")).rows[0].version,
    3,
  );
  await db.exec(
    "UPDATE public.posts SET status='deleted',deleted_at=now(),version=4",
  );
  assert.equal((await rpc(s)).code, "STATE_CONFLICT");
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM public.outbox_jobs")).rows[0]
      .n,
    1,
  );
});

test("completed retry still requires current consent and never revives BAN", async () => {
  const s = await session();
  await rpc(s);
  await commit(s);
  await db.exec("UPDATE public.events SET terms_version='v2'");
  assert.equal((await rpc(s)).code, "CONSENT_REQUIRED");
  await db.query(
    "INSERT INTO public.consents(event_id,user_id,terms_version) VALUES($1,$2,'v2')",
    [event, user],
  );
  await db.query(
    "UPDATE public.event_members SET is_banned=true,banned_at=now() WHERE user_id=$1",
    [user],
  );
  assert.equal((await rpc(s)).code, "ACCOUNT_BANNED");
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM public.outbox_jobs")).rows[0]
      .n,
    1,
  );
});
test("provisioning cannot be completed before a provider is attached", async () => {
  const s = await session({ file_size_bytes: 67108865 });
  await db.exec(
    "UPDATE public.upload_sessions SET provider_upload_id=null,provisioning_state='provisioning'",
  );
  assert.equal((await rpc(s, "prepare", { parts })).code, "UPLOAD_INCOMPLETE");
  await unchanged();
});
