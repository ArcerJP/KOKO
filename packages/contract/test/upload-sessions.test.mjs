import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { before, beforeEach, after, test } from "node:test";
import { URL } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const event = "11111111-1111-4111-8111-111111111111";
const user = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const theme = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const attempt = randomUUID();
const request = {
  client_request_id: randomUUID(),
  kind: "photo",
  content_type: "image/jpeg",
  file_size_bytes: 123,
  original_scope: "photo_file",
};
const multipart = {
  ...request,
  kind: "video",
  original_scope: "full_video_fallback",
  file_size_bytes: 67108865,
};
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
  // Isolated in-memory fixture only; never uses Supabase credentials.
  await db.exec("RESET ROLE; TRUNCATE public.events,auth.users CASCADE;");
  await db.query("INSERT INTO auth.users(id) VALUES ($1),($2)", [user, other]);
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
    "INSERT INTO public.consents(event_id,user_id,terms_version) VALUES($1,$2,'v1')",
    [event, user],
  );
  await db.query(
    `INSERT INTO public.themes(event_id,id,title,status,starts_at,ends_at) VALUES($1,$2,'Fixture','published',now()-interval '1 day',now()+interval '1 day')`,
    [event, theme],
  );
});
after(async () => db.close());
async function rpc(
  action,
  input,
  actor = user,
  scope = event,
  role = "service_role",
) {
  assert.ok(["anon", "authenticated", "service_role"].includes(role));
  await db.exec(`SET ROLE ${role}`);
  try {
    return (
      await db.query(
        "SELECT public.manage_upload_session($1,$2,$3,$4::jsonb) AS result",
        [scope, actor, action, JSON.stringify(input)],
      )
    ).rows[0].result;
  } finally {
    await db.exec("RESET ROLE");
  }
}
const open = (input = request, attemptId = attempt) =>
  rpc("open", { request: input, attempt_id: attemptId });
const attach = (
  session,
  provider = "opaque-provider-id",
  attemptId = attempt,
) =>
  rpc("attach", {
    upload_id: session.upload_id,
    attempt_id: attemptId,
    provider_upload_id: provider,
  });
const count = async () =>
  (await db.query("SELECT count(*)::integer AS n FROM public.upload_sessions"))
    .rows[0].n;
const storedSession = async (session) =>
  (
    await db.query("SELECT * FROM public.upload_sessions WHERE id=$1", [
      session.upload_id,
    ])
  ).rows[0];
const expireProvision = async (session) =>
  db.query(
    "UPDATE public.upload_sessions SET provisioning_locked_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [session.upload_id],
  );

test("service-only invoker RPC preserves RLS and empty search path", async () => {
  for (const role of ["anon", "authenticated"])
    await assert.rejects(
      rpc("open", { request, attempt_id: attempt }, user, event, role),
      (e) => e.code === "42501",
    );
  const info = (
    await db.query(
      "SELECT prosecdef,proconfig,proacl::text AS acl FROM pg_proc WHERE oid='public.manage_upload_session(uuid,uuid,text,jsonb)'::regprocedure",
    )
  ).rows[0];
  assert.equal(info.prosecdef, false);
  assert.ok(info.proconfig.some((v) => /^search_path=(""|)$/.test(v)));
  assert.ok(!info.acl.includes("{=X/"));
  assert.equal(
    (
      await db.query(
        "SELECT relrowsecurity FROM pg_class WHERE oid='public.upload_sessions'::regclass",
      )
    ).rows[0].relrowsecurity,
    true,
  );
});
test("single opens once, retries/refresh keep IDs and immutable metadata", async () => {
  const first = await open();
  assert.equal(first.code, "ready");
  assert.equal(first.mode, "single");
  assert.equal(first.provider_upload_id, null);
  assert.ok(Date.parse(first.expires_at) > Date.now());
  assert.ok(Date.parse(first.expires_at) <= Date.now() + 900000);
  for (const result of [
    await open(),
    await open(request, randomUUID()),
    await rpc("refresh", { upload_id: first.upload_id }),
  ]) {
    assert.equal(result.code, "ready");
    assert.equal(result.upload_id, first.upload_id);
    assert.equal(result.post_id, first.post_id);
  }
  assert.equal(await count(), 1);
  assert.deepEqual(
    (await db.query("SELECT original_bytes,status FROM public.posts")).rows[0],
    { original_bytes: null, status: "uploading" },
  );
  assert.equal(
    (await open({ ...request, file_size_bytes: 124 })).code,
    "IDEMPOTENCY_CONFLICT",
  );
});
test("unique constraint disallows a second session even outside RPC", async () => {
  await open();
  await assert.rejects(
    db.exec(`INSERT INTO public.upload_sessions(event_id,post_id,asset_id,mode,expires_at)
    SELECT event_id,post_id,asset_id,mode,expires_at FROM public.upload_sessions`),
    (e) => e.code === "23505",
  );
});
test("only first multipart claim provisions; same/different attempts do not retry unknown create", async () => {
  const first = await open(multipart);
  assert.equal(first.code, "provision");
  assert.equal(first.provider_upload_id, null);
  assert.equal(first.provisioning_attempt, attempt);
  assert.ok(Date.parse(first.provisioning_locked_until) > Date.now());
  assert.ok(Date.parse(first.provisioning_locked_until) <= Date.now() + 120000);
  assert.equal((await storedSession(first)).provisioning_attempts, 1);
  for (const result of [
    await open(multipart),
    await open(multipart, randomUUID()),
    await rpc("refresh", { upload_id: first.upload_id }),
    await rpc("parts", { upload_id: first.upload_id }),
  ])
    assert.equal(result.code, "UPLOAD_INCOMPLETE");
  assert.equal(await count(), 1);
  assert.equal(
    (await attach(first, "other", randomUUID())).code,
    "STATE_CONFLICT",
  );
  const ready = await attach(first);
  assert.equal(ready.code, "ready");
  assert.equal(ready.provider_upload_id, "opaque-provider-id");
  assert.equal((await attach(first)).code, "ready");
  assert.equal((await attach(first, "different")).code, "STATE_CONFLICT");
  assert.equal(
    (await open(multipart)).provider_upload_id,
    "opaque-provider-id",
  );
});
test("expired unknown create permits exactly one new generation and rejects the old attach", async () => {
  const first = await open(multipart);
  await expireProvision(first);
  assert.equal((await attach(first)).code, "STATE_CONFLICT");
  for (const result of [
    await open(multipart),
    await rpc("refresh", { upload_id: first.upload_id }),
    await rpc("parts", { upload_id: first.upload_id }),
  ])
    assert.equal(result.code, "UPLOAD_INCOMPLETE");
  const replacement = randomUUID();
  const second = await open(multipart, replacement);
  assert.equal(second.code, "provision");
  for (const key of ["upload_id", "post_id", "asset_id", "object_key"])
    assert.equal(second[key], first[key]);
  assert.equal(second.provisioning_attempt, replacement);
  assert.equal((await storedSession(first)).provisioning_attempts, 2);
  assert.equal((await open(multipart, randomUUID())).code, "UPLOAD_INCOMPLETE");
  assert.equal((await open(multipart, replacement)).code, "UPLOAD_INCOMPLETE");
  const before = await storedSession(first);
  assert.equal((await attach(first)).code, "STATE_CONFLICT");
  assert.deepEqual(await storedSession(first), before);
  assert.equal(
    (await attach(second, "replacement-provider", replacement)).code,
    "ready",
  );
  assert.equal((await attach(first)).code, "STATE_CONFLICT");
  assert.equal(
    (await open(multipart, randomUUID())).provider_upload_id,
    "replacement-provider",
  );
  assert.equal(await count(), 1);
});
test("at most three provisioning generations are granted, without unbounded lease extension", async () => {
  const first = await open(multipart);
  for (let number = 2; number <= 3; number++) {
    await expireProvision(first);
    assert.equal((await open(multipart, randomUUID())).code, "provision");
    assert.equal((await storedSession(first)).provisioning_attempts, number);
  }
  await expireProvision(first);
  const before = await storedSession(first);
  for (let i = 0; i < 4; i++)
    assert.equal(
      (await open(multipart, randomUUID())).code,
      "UPLOAD_INCOMPLETE",
    );
  assert.deepEqual(await storedSession(first), before);
  assert.equal(await count(), 1);
});
test("the last allowed generation may attach while current but cannot replace its ready provider", async () => {
  const first = await open(multipart);
  let currentAttempt = attempt;
  for (let number = 2; number <= 3; number++) {
    await expireProvision(first);
    currentAttempt = randomUUID();
    assert.equal((await open(multipart, currentAttempt)).code, "provision");
  }
  assert.equal(
    (await attach(first, "last-provider", currentAttempt)).code,
    "ready",
  );
  assert.equal(
    (await open(multipart, randomUUID())).provider_upload_id,
    "last-provider",
  );
  assert.equal((await storedSession(first)).provisioning_attempts, 3);
  assert.equal(
    (await attach(first, "old-provider", attempt)).code,
    "STATE_CONFLICT",
  );
});
test("an attach committed before response loss is reused even after the old lease time", async () => {
  const first = await open(multipart);
  await attach(first);
  await db.query(
    "UPDATE public.upload_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [first.upload_id],
  );
  const ready = await open(multipart, randomUUID());
  assert.equal(ready.code, "ready");
  assert.equal(ready.provider_upload_id, "opaque-provider-id");
  assert.equal((await storedSession(first)).provisioning_attempts, 1);
  assert.equal((await storedSession(first)).provisioning_locked_until, null);
  assert.equal((await attach(first)).code, "ready");
  assert.equal((await attach(first, "different")).code, "STATE_CONFLICT");
});
test("provisioning lease is bounded by event/theme end and unknown legacy lease stays closed", async () => {
  await db.exec(
    "UPDATE public.themes SET ends_at=clock_timestamp()+interval '30 seconds'",
  );
  const first = await open({ ...multipart, theme_id: theme });
  assert.ok(Date.parse(first.provisioning_locked_until) <= Date.now() + 30000);
  assert.ok(
    Date.parse(first.provisioning_locked_until) <= Date.parse(first.expires_at),
  );
  await db.query(
    "UPDATE public.upload_sessions SET provisioning_locked_until=NULL WHERE id=$1",
    [first.upload_id],
  );
  const before = await storedSession(first);
  assert.equal(
    (await open({ ...multipart, theme_id: theme }, randomUUID())).code,
    "UPLOAD_INCOMPLETE",
  );
  assert.equal((await attach(first)).code, "STATE_CONFLICT");
  assert.deepEqual(await storedSession(first), before);
});
test("rollback of a replacement leaves the old generation and count unchanged", async () => {
  const first = await open(multipart);
  await expireProvision(first);
  const before = await storedSession(first);
  await db.exec("BEGIN");
  assert.equal((await open(multipart, randomUUID())).code, "provision");
  await db.exec("ROLLBACK");
  assert.deepEqual(await storedSession(first), before);
});
test("expired multipart refuses parts but refresh renews same provider without create", async () => {
  const pending = await open(multipart);
  await attach(pending);
  await db.exec(
    "UPDATE public.upload_sessions SET expires_at=clock_timestamp()-interval '1 second'",
  );
  assert.equal(
    (await rpc("parts", { upload_id: pending.upload_id })).code,
    "UPLOAD_EXPIRED",
  );
  const refreshed = await rpc("refresh", { upload_id: pending.upload_id });
  assert.equal(refreshed.code, "ready");
  assert.equal(refreshed.upload_id, pending.upload_id);
  assert.equal(refreshed.provider_upload_id, "opaque-provider-id");
  assert.equal(
    (await rpc("parts", { upload_id: pending.upload_id })).code,
    "ready",
  );
});
test("expiry never outlives latest event/theme end, including parts without refresh", async () => {
  const pending = await open({ ...multipart, theme_id: theme });
  await attach(pending);
  await db.exec(
    "UPDATE public.events SET ends_at=clock_timestamp()+interval '5 minutes'; UPDATE public.themes SET ends_at=clock_timestamp()+interval '2 minutes'",
  );
  for (const action of ["parts", "refresh"]) {
    const result = await rpc(action, { upload_id: pending.upload_id });
    assert.equal(result.code, "ready");
    assert.ok(Date.parse(result.expires_at) <= Date.now() + 120000);
  }
});
test("unknown session, other owner and other event do not reveal IDs", async () => {
  const pending = await open(multipart);
  for (const action of ["refresh", "parts", "attach"]) {
    const input = {
      upload_id: pending.upload_id,
      ...(action === "attach"
        ? { attempt_id: attempt, provider_upload_id: "opaque" }
        : {}),
    };
    assert.deepEqual(await rpc(action, input, other), { code: "NOT_FOUND" });
    assert.deepEqual(await rpc(action, input, user, randomUUID()), {
      code: "NOT_FOUND",
    });
    assert.deepEqual(await rpc(action, { ...input, upload_id: randomUUID() }), {
      code: "NOT_FOUND",
    });
  }
});
for (const [label, sql, code] of [
  [
    "BAN",
    "UPDATE public.event_members SET is_banned=true,banned_at=now()",
    "ACCOUNT_BANNED",
  ],
  ["terms", "UPDATE public.events SET terms_version='v2'", "CONSENT_REQUIRED"],
  [
    "uploads off",
    "UPDATE public.event_settings SET uploads_enabled=false",
    "EVENT_CLOSED",
  ],
  [
    "publication stop",
    "UPDATE public.event_settings SET publication_stopped=true",
    "PUBLICATION_STOPPED",
  ],
  ["event end", "UPDATE public.events SET ends_at=now()", "EVENT_CLOSED"],
  ["theme end", "UPDATE public.themes SET ends_at=now()", "THEME_UNAVAILABLE"],
  [
    "deleted post",
    "UPDATE public.posts SET status='deleted',deleted_at=now()",
    "STATE_CONFLICT",
  ],
  [
    "asset deletion",
    "UPDATE public.media_assets SET deletion_requested_at=now()",
    "STATE_CONFLICT",
  ],
])
  test(`every issuance and provider attach recheck ${label}`, async () => {
    const input = { ...multipart, theme_id: theme };
    const session = await open(input);
    await expireProvision(session);
    await db.exec(sql);
    assert.equal((await open(input, randomUUID())).code, code);
    assert.equal(
      (await rpc("refresh", { upload_id: session.upload_id })).code,
      code,
    );
    assert.equal(
      (await rpc("parts", { upload_id: session.upload_id })).code,
      code,
    );
    assert.equal((await attach(session)).code, code);
    assert.equal(
      (await db.query("SELECT provisioning_state FROM public.upload_sessions"))
        .rows[0].provisioning_state,
      "provisioning",
    );
    assert.equal((await storedSession(session)).provisioning_attempts, 1);
  });
test("completed sessions and single parts are rejected without renewal", async () => {
  const first = await open();
  assert.equal(
    (await rpc("parts", { upload_id: first.upload_id })).code,
    "STATE_CONFLICT",
  );
  await db.exec("UPDATE public.upload_sessions SET completed_at=now()");
  assert.equal((await open()).code, "STATE_CONFLICT");
  assert.equal(
    (await rpc("refresh", { upload_id: first.upload_id })).code,
    "STATE_CONFLICT",
  );
});
test("malformed operations cannot write or change provider", async () => {
  for (const [action, input] of [
    ["unknown", {}],
    [null, {}],
    ["open", null],
    ["open", { request, attempt_id: "bad" }],
    ["open", { request, attempt_id: attempt, extra: true }],
    ["refresh", {}],
    ["parts", { upload_id: "bad" }],
  ])
    assert.equal((await rpc(action, input)).code, "INVALID_INPUT");
  assert.equal(await count(), 0);
  const session = await open(multipart);
  for (const provider of [null, "", "bad\nvalue", "é", "x".repeat(2049)])
    assert.equal((await attach(session, provider)).code, "INVALID_INPUT");
});
test("failed session insert rolls back the post and asset reservation", async () => {
  await db.exec(`CREATE FUNCTION public.reject_fixture_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER reject_fixture_session BEFORE INSERT ON public.upload_sessions FOR EACH ROW EXECUTE FUNCTION public.reject_fixture_session();`);
  try {
    await assert.rejects(open(), (e) => e.code === "P0001");
    assert.equal(
      (await db.query("SELECT count(*)::integer AS n FROM public.posts"))
        .rows[0].n,
      0,
    );
  } finally {
    await db.exec(
      "DROP TRIGGER reject_fixture_session ON public.upload_sessions; DROP FUNCTION public.reject_fixture_session()",
    );
  }
});
test("snapshot isolation is rejected before admission/session writes", async () => {
  await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    await assert.rejects(
      db.query("SELECT public.manage_upload_session($1,$2,'open',$3::jsonb)", [
        event,
        user,
        JSON.stringify({ request, attempt_id: attempt }),
      ]),
      (e) => e.code === "25001",
    );
  } finally {
    await db.exec("ROLLBACK");
  }
  assert.equal(await count(), 0);
});
