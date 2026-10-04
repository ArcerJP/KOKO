import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { before, beforeEach, after, test } from "node:test";
import { URL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { originalKey } from "../dist/index.js";

// No cloud credentials, network DB, or real application records are used.
const db = new PGlite();
const eventA = "11111111-1111-4111-8111-111111111111";
const eventB = "22222222-2222-4222-8222-222222222222";
const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const themeA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const themeB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const requestId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const maxR2Bytes = 5 * 1024 ** 4 - 5 * 1024 ** 3;
const input = (overrides = {}) => ({
  client_request_id: requestId,
  kind: "photo",
  content_type: "image/jpeg",
  file_size_bytes: 123,
  original_scope: "photo_file",
  ...overrides,
});

before(async () => {
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, service_role;
  `);
  const migrations = new URL(
    "../../../apps/api/supabase/migrations/",
    import.meta.url,
  );
  for (const name of (await readdir(migrations))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    await db.exec(await readFile(new URL(name, migrations), "utf8"));
  }
});

beforeEach(async () => {
  // This is solely the isolated, in-memory PGlite fixture created above.
  await db.exec("RESET ROLE; TRUNCATE public.events, auth.users CASCADE;");
  await db.query("INSERT INTO auth.users(id) VALUES ($1), ($2)", [
    userA,
    userB,
  ]);
  for (const [event, user, theme, slug] of [
    [eventA, userA, themeA, "fixture-a"],
    [eventB, userB, themeB, "fixture-b"],
  ]) {
    await db.query(
      `INSERT INTO public.events(event_id,slug,name,status,starts_at,ends_at,archive_at,private_at,terms_version)
      VALUES ($1,$2,$2,'live',clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',
        clock_timestamp()+interval '2 days',clock_timestamp()+interval '3 days','fixture-v1')`,
      [event, slug],
    );
    await db.query(
      "INSERT INTO public.event_members(event_id,user_id,display_name) VALUES ($1,$2,'Fixture')",
      [event, user],
    );
    await db.query(
      "INSERT INTO public.event_settings(event_id,uploads_enabled,publication_stopped) VALUES ($1,true,false)",
      [event],
    );
    await db.query(
      "INSERT INTO public.consents(event_id,user_id,terms_version) VALUES ($1,$2,'fixture-v1')",
      [event, user],
    );
    await db.query(
      `INSERT INTO public.themes(event_id,id,title,status,starts_at,ends_at)
      VALUES ($1,$2,'Fixture','published',clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day')`,
      [event, theme],
    );
  }
});
after(async () => db.close());

async function reserve(
  request = input(),
  event = eventA,
  user = userA,
  role = "service_role",
) {
  assert.ok(["anon", "authenticated", "service_role"].includes(role));
  await db.exec(`SET ROLE ${role}`);
  try {
    return (
      await db.query(
        "SELECT public.reserve_upload($1,$2,$3::jsonb) AS result",
        [event, user, JSON.stringify(request)],
      )
    ).rows[0].result;
  } finally {
    await db.exec("RESET ROLE");
  }
}
async function counts() {
  return (
    await db.query(`SELECT
    (SELECT count(*)::integer FROM public.posts) AS posts,
    (SELECT count(*)::integer FROM public.media_assets) AS assets,
    (SELECT count(*)::integer FROM public.upload_sessions) AS sessions,
    (SELECT count(*)::integer FROM public.outbox_jobs) AS jobs`)
  ).rows[0];
}
async function denied(code, request = input(), event = eventA, user = userA) {
  const previous = await counts();
  assert.equal((await reserve(request, event, user)).code, code);
  assert.deepEqual(await counts(), previous);
}

test("all migrations preserve 14 RLS tables; only service_role may execute admission", async () => {
  const tables = (
    await db.query(
      "SELECT relrowsecurity FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace WHERE n.nspname='public' AND relkind='r'",
    )
  ).rows;
  assert.equal(tables.length, 14);
  assert.ok(tables.every((table) => table.relrowsecurity));
  const info = (
    await db.query(
      "SELECT prosecdef,proconfig,pg_get_functiondef(oid) AS body FROM pg_proc WHERE oid='public.reserve_upload(uuid,uuid,jsonb)'::regprocedure",
    )
  ).rows[0];
  assert.equal(info.prosecdef, false);
  assert.ok(
    info.proconfig.some((config) => /^search_path=(""|)$/.test(config)),
  );
  // Definition checks document the intended locking; this is not a multi-connection test.
  assert.match(info.body, /public\.event_members[\s\S]*?FOR UPDATE/);
  assert.match(info.body, /FOR SHARE/);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::integer AS n FROM pg_proc p,LATERAL aclexplode(p.proacl) a WHERE p.oid='public.reserve_upload(uuid,uuid,jsonb)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE'",
      )
    ).rows[0].n,
    0,
  );
  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(
      reserve(input(), eventA, userA, role),
      (error) => error.code === "42501",
    );
  }
  assert.deepEqual(await counts(), {
    posts: 0,
    assets: 0,
    sessions: 0,
    jobs: 0,
  });
});

test("reserves post and canonical original asset, not measured bytes or an upload ticket", async () => {
  const result = await reserve();
  assert.equal(result.code, "reserved");
  assert.equal(result.reused, false);
  assert.equal(
    result.object_key,
    originalKey(eventA, result.post_id, result.asset_id),
  );
  assert.deepEqual(result.request, input({ theme_id: null }));
  assert.equal("put_url" in result, false);
  assert.equal("upload_id" in result, false);
  assert.deepEqual(await counts(), {
    posts: 1,
    assets: 1,
    sessions: 0,
    jobs: 0,
  });
  const post = (
    await db.query(
      "SELECT status,original_bytes,upload_request,created_at,updated_at FROM public.posts WHERE id=$1",
      [result.post_id],
    )
  ).rows[0];
  assert.equal(post.status, "uploading");
  assert.equal(post.original_bytes, null);
  assert.deepEqual(post.upload_request, result.request);
  assert.equal(post.created_at.toISOString(), post.updated_at.toISOString());
  assert.equal(
    (await db.query("SELECT byte_size FROM public.media_assets")).rows[0]
      .byte_size,
    null,
  );
});

test("same request is canonicalized and retried without new rows or changed timestamp", async () => {
  const first = await reserve(input({ theme_id: themeA }));
  const before = (await db.query("SELECT created_at FROM public.posts"))
    .rows[0];
  const second = await reserve(
    input({
      client_request_id: requestId.toUpperCase(),
      theme_id: themeA.toUpperCase(),
      file_size_bytes: 123.0,
    }),
  );
  assert.deepEqual(second, { ...first, reused: true });
  assert.deepEqual(
    (await db.query("SELECT created_at FROM public.posts")).rows[0],
    before,
  );
  assert.deepEqual(await counts(), {
    posts: 1,
    assets: 1,
    sessions: 0,
    jobs: 0,
  });
});

test("omitted and null theme are the same request", async () => {
  const first = await reserve();
  assert.deepEqual(await reserve(input({ theme_id: null })), {
    ...first,
    reused: true,
  });
});

for (const [label, change] of [
  ["size", { file_size_bytes: 124 }],
  ["content type", { content_type: "image/png" }],
  ["kind and scope", { kind: "video", original_scope: "client_trimmed" }],
  ["theme", { theme_id: themeA }],
]) {
  test(`same id with different ${label} conflicts`, async () => {
    await reserve();
    await denied("IDEMPOTENCY_CONFLICT", input(change));
  });
}

const invalidInputs = [
  null,
  [],
  "text",
  {},
  input({ client_request_id: "not-a-uuid" }),
  input({ client_request_id: null }),
  input({ kind: "audio" }),
  input({ kind: null }),
  input({ original_scope: "client_trimmed" }),
  input({ kind: "video" }),
  input({ original_scope: null }),
  input({ theme_id: "../other" }),
  input({ theme_id: 3 }),
  input({ content_type: "" }),
  input({ content_type: " " }),
  input({ content_type: null }),
  input({ content_type: "a".repeat(256) }),
  input({ content_type: "image/jpeg\r\nX: secret" }),
  input({ file_size_bytes: 0 }),
  input({ file_size_bytes: -1 }),
  input({ file_size_bytes: 1.1 }),
  input({ file_size_bytes: "123" }),
  input({ file_size_bytes: null }),
  input({ user_id: userB }),
  input({ status: "published" }),
  input({ object_key: "chosen-key" }),
];
test("invalid shapes, extra fields and mismatched media scopes are rejected without writes", async () => {
  for (const request of invalidInputs) await denied("INVALID_INPUT", request);
  for (const key of Object.keys(input())) {
    const missing = input();
    delete missing[key];
    await denied("INVALID_INPUT", missing);
  }
  await denied("INVALID_INPUT", input(), null, userA);
  await denied("INVALID_INPUT", input(), eventA, null);
});

test("R2 object boundary is exact, without a business format whitelist or single PUT cap", async () => {
  for (const bytes of [1, 5 * 1024 ** 3 + 1, maxR2Bytes]) {
    assert.equal(
      (
        await reserve(
          input({
            client_request_id: randomUUID(),
            file_size_bytes: bytes,
            content_type: "application/octet-stream",
          }),
        )
      ).code,
      "reserved",
    );
  }
  await denied("PROVIDER_LIMIT", input({ file_size_bytes: maxR2Bytes + 1 }));
  await denied("PROVIDER_LIMIT", input({ file_size_bytes: 1e30 }));
});

test("video client trim and full original fallback remain distinct", async () => {
  const video = input({
    kind: "video",
    original_scope: "full_video_fallback",
    content_type: "video/quicktime",
  });
  assert.equal((await reserve(video)).code, "reserved");
  await denied("IDEMPOTENCY_CONFLICT", {
    ...video,
    original_scope: "client_trimmed",
  });
  assert.equal(
    (
      await reserve({
        ...video,
        client_request_id: randomUUID(),
        original_scope: "client_trimmed",
      })
    ).code,
    "reserved",
  );
});

test("unknown event and other event/user cannot reserve or discover another reservation", async () => {
  await reserve();
  await denied("FORBIDDEN", input(), eventA, userB);
  await denied("FORBIDDEN", input(), eventB, userA);
  await denied("FORBIDDEN", input(), randomUUID(), userA);
  const other = await reserve(input(), eventB, userB);
  assert.equal(other.code, "reserved");
  assert.match(other.object_key, new RegExp(`^events/${eventB}/`));
});

const guards = [
  [
    "BAN",
    "UPDATE public.event_members SET is_banned=true,banned_at=clock_timestamp()",
    "ACCOUNT_BANNED",
  ],
  ["draft", "UPDATE public.events SET status='draft'", "EVENT_CLOSED"],
  ["archive", "UPDATE public.events SET status='archive'", "EVENT_CLOSED"],
  ["private", "UPDATE public.events SET status='private'", "EVENT_CLOSED"],
  [
    "before start",
    "UPDATE public.events SET starts_at=clock_timestamp()+interval '1 hour'",
    "EVENT_CLOSED",
  ],
  [
    "after end",
    "UPDATE public.events SET ends_at=clock_timestamp()",
    "EVENT_CLOSED",
  ],
  [
    "uploads disabled",
    "UPDATE public.event_settings SET uploads_enabled=false",
    "EVENT_CLOSED",
  ],
  [
    "publication stopped",
    "UPDATE public.event_settings SET publication_stopped=true",
    "PUBLICATION_STOPPED",
  ],
  ["missing settings", "DELETE FROM public.event_settings", "INTERNAL_ERROR"],
  ["no consent", "DELETE FROM public.consents", "CONSENT_REQUIRED"],
  [
    "old consent",
    "UPDATE public.events SET terms_version='fixture-v2'",
    "CONSENT_REQUIRED",
  ],
  [
    "empty terms",
    "UPDATE public.events SET terms_version=' '",
    "CONSENT_REQUIRED",
  ],
];
for (const [label, sql, code] of guards) {
  test(`${label} is rechecked for new ids AND retries`, async () => {
    await reserve();
    await db.exec(sql);
    await denied(code);
    await denied(code, input({ client_request_id: randomUUID() }));
  });
}

test("theme must exist in this event, be published and inside its period, including retries", async () => {
  await denied("THEME_UNAVAILABLE", input({ theme_id: themeB }));
  await denied("THEME_UNAVAILABLE", input({ theme_id: randomUUID() }));
  const request = input({ theme_id: themeA });
  assert.equal((await reserve(request)).code, "reserved");
  for (const sql of [
    "UPDATE public.themes SET status='draft'",
    "UPDATE public.themes SET status='ended'",
    "UPDATE public.themes SET status='published',starts_at=clock_timestamp()+interval '1 hour'",
    "UPDATE public.themes SET starts_at=clock_timestamp()-interval '1 day',ends_at=clock_timestamp()",
  ]) {
    await db.exec(sql);
    await denied("THEME_UNAVAILABLE", request);
  }
});

test("quota counts new posts per event/user, allows idempotent retries and returns bounded retry time", async () => {
  await reserve();
  for (let i = 1; i < 10; i++)
    assert.equal(
      (await reserve(input({ client_request_id: randomUUID() }))).code,
      "reserved",
    );
  const blocked = await reserve(input({ client_request_id: randomUUID() }));
  assert.equal(blocked.code, "RATE_LIMITED");
  assert.ok(
    Number.isInteger(blocked.retry_after_seconds) &&
      blocked.retry_after_seconds >= 1 &&
      blocked.retry_after_seconds <= 60,
  );
  assert.equal((await reserve()).reused, true);
  assert.equal((await reserve(input(), eventB, userB)).code, "reserved");
  await db.query(
    "INSERT INTO public.event_members(event_id,user_id,display_name) VALUES ($1,$2,'Other')",
    [eventA, userB],
  );
  await db.query(
    "INSERT INTO public.consents(event_id,user_id,terms_version) VALUES ($1,$2,'fixture-v1')",
    [eventA, userB],
  );
  assert.equal((await reserve(input(), eventA, userB)).code, "reserved");
  await db.exec(
    "UPDATE public.posts SET created_at=clock_timestamp()-interval '61 seconds'",
  );
  assert.equal(
    (await reserve(input({ client_request_id: randomUUID() }))).code,
    "reserved",
  );
});

test("settings may tighten quota but not raise the requirement above ten; deleted posts still count", async () => {
  await db.exec("UPDATE public.event_settings SET posts_per_minute=1");
  await reserve();
  await denied("RATE_LIMITED", input({ client_request_id: randomUUID() }));
  await db.exec("UPDATE public.event_settings SET posts_per_minute=100");
  for (let i = 1; i < 10; i++)
    await reserve(input({ client_request_id: randomUUID() }));
  await db.exec(
    "UPDATE public.posts SET status='deleted',deleted_at=clock_timestamp()",
  );
  await denied("RATE_LIMITED", input({ client_request_id: randomUUID() }));
});

test("completed/failed/deleted or ban-latched posts cannot be reopened by retry", async () => {
  const first = await reserve();
  for (const state of [
    "uploaded",
    "processing",
    "held",
    "blocked",
    "upload_failed",
    "deleted",
  ]) {
    await db.query(
      "UPDATE public.posts SET status=$1::public.post_status,deleted_at=CASE WHEN $1::public.post_status='deleted' THEN clock_timestamp() ELSE NULL END WHERE id=$2",
      [state, first.post_id],
    );
    await denied("STATE_CONFLICT");
  }
  await db.exec(
    "UPDATE public.posts SET status='uploading',deleted_at=NULL,ban_latched=true",
  );
  await denied("STATE_CONFLICT");
});

test("legacy declarations, missing assets and deletion requests fail closed", async () => {
  await reserve();
  await db.exec("UPDATE public.posts SET upload_request=NULL");
  await denied("STATE_CONFLICT");
  await db.query("UPDATE public.posts SET upload_request=$1::jsonb", [
    JSON.stringify(input({ theme_id: null })),
  ]);
  await db.exec(
    "UPDATE public.media_assets SET deletion_requested_at=clock_timestamp()",
  );
  await denied("STATE_CONFLICT");
  await db.exec(
    "UPDATE public.media_assets SET deletion_requested_at=NULL,physically_deleted_at=clock_timestamp()",
  );
  await denied("STATE_CONFLICT");
  await db.exec("DELETE FROM public.media_assets");
  await denied("INTERNAL_ERROR");
});

test("theme reassignment does not replace the initial declaration or mint a new reservation", async () => {
  await reserve();
  await db.query("UPDATE public.posts SET theme_id=$1", [themeA]);
  await denied("STATE_CONFLICT");
  await denied("IDEMPOTENCY_CONFLICT", input({ theme_id: themeA }));
});

test("asset insertion failure atomically rolls back the new post", async () => {
  await db.exec(`CREATE FUNCTION public.fixture_asset_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic asset failure'; END; $$;
    CREATE TRIGGER fixture_fail BEFORE INSERT ON public.media_assets FOR EACH ROW EXECUTE FUNCTION public.fixture_asset_failure();`);
  try {
    await assert.rejects(reserve(), /synthetic asset failure/);
    assert.deepEqual(await counts(), {
      posts: 0,
      assets: 0,
      sessions: 0,
      jobs: 0,
    });
  } finally {
    await db.exec(
      "DROP TRIGGER fixture_fail ON public.media_assets; DROP FUNCTION public.fixture_asset_failure();",
    );
  }
});

for (const table of ["posts", "media_assets"]) {
  test(`trigger-suppressed ${table} insert cannot report success or leave an orphan`, async () => {
    await db.exec(`CREATE FUNCTION public.fixture_suppress_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN NULL; END; $$;
      CREATE TRIGGER fixture_suppress BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.fixture_suppress_insert();`);
    try {
      await assert.rejects(reserve(), /reservation was not inserted/);
      assert.deepEqual(await counts(), {
        posts: 0,
        assets: 0,
        sessions: 0,
        jobs: 0,
      });
    } finally {
      await db.exec(
        `DROP TRIGGER fixture_suppress ON public.${table}; DROP FUNCTION public.fixture_suppress_insert();`,
      );
    }
  });
}

test("outer transaction rollback removes the entire reservation", async () => {
  await db.exec("BEGIN");
  try {
    assert.equal((await reserve()).code, "reserved");
  } finally {
    await db.exec("ROLLBACK");
  }
  assert.deepEqual(await counts(), {
    posts: 0,
    assets: 0,
    sessions: 0,
    jobs: 0,
  });
});

test("rejects stale-snapshot isolation instead of silently violating the per-member quota", async () => {
  await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    await assert.rejects(
      db.query("SELECT public.reserve_upload($1,$2,$3::jsonb)", [
        eventA,
        userA,
        JSON.stringify(input()),
      ]),
      (error) => error.code === "25001",
    );
  } finally {
    await db.exec("ROLLBACK");
  }
  assert.deepEqual(await counts(), {
    posts: 0,
    assets: 0,
    sessions: 0,
    jobs: 0,
  });
});
