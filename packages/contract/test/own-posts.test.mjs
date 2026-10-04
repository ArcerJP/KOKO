import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { before, beforeEach, after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const event = "11111111-1111-4111-8111-111111111111",
  otherEvent = "22222222-2222-4222-8222-222222222222";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id1 = "00000000-0000-4000-8000-000000000001",
  id2 = "00000000-0000-4000-8000-000000000002",
  id3 = "00000000-0000-4000-8000-000000000003";
const stamp = "2026-10-05T00:00:00.123456Z";
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
  await db.query("INSERT INTO auth.users VALUES($1),($2)", [owner, other]);
  for (const [id, slug] of [
    [event, "one"],
    [otherEvent, "two"],
  ]) {
    await db.query(
      `INSERT INTO public.events(event_id,slug,name,status,starts_at,ends_at,archive_at,private_at,terms_version)
      VALUES($1,$2,'Fixture','live','2026-10-01','2026-10-11','2026-11-11','2027-01-11','test')`,
      [id, slug],
    );
    await db.query(
      "INSERT INTO public.event_members(event_id,user_id,display_name) VALUES($1,$2,'Owner'),($1,$3,'Other')",
      [id, owner, other],
    );
    await db.query("INSERT INTO public.event_settings(event_id) VALUES($1)", [
      id,
    ]);
  }
});
after(async () => db.close());
async function insert(
  id = randomUUID(),
  scope = event,
  user = owner,
  time = stamp,
) {
  await db.query(
    "INSERT INTO public.posts(event_id,id,user_id,kind,client_request_id,declared_content_type,original_scope,created_at) VALUES($1,$2,$3,'photo',$2,'image/jpeg','photo_file',$4)",
    [scope, id, user, time],
  );
  return id;
}
async function read({
  scope = event,
  user = owner,
  id = null,
  before = null,
  beforeId = null,
  limit = id ? 1 : 30,
  role = "service_role",
} = {}) {
  assert.ok(["service_role", "anon", "authenticated"].includes(role));
  await db.exec(`SET ROLE ${role}`);
  try {
    return (
      await db.query("SELECT public.read_own_posts($1,$2,$3,$4,$5,$6) result", [
        scope,
        user,
        id,
        before,
        beforeId,
        limit,
      ])
    ).rows[0].result;
  } finally {
    await db.exec("RESET ROLE");
  }
}
test("read-only, stable, invoker with empty search path; no browser execution privilege", async () => {
  const meta = (
    await db.query(
      "SELECT provolatile,prosecdef,proconfig FROM pg_proc WHERE oid='public.read_own_posts(uuid,uuid,uuid,timestamptz,uuid,integer)'::regprocedure",
    )
  ).rows[0];
  assert.equal(meta.provolatile, "s");
  assert.equal(meta.prosecdef, false);
  assert.ok(meta.proconfig.some((v) => /^search_path=(""|)$/.test(v)));
  for (const role of ["anon", "authenticated"])
    await assert.rejects(read({ role }), /permission denied/);
  await insert(id1);
  await db.exec("BEGIN READ ONLY");
  assert.equal((await read()).items.length, 1);
  await db.exec("ROLLBACK");
});
test("projects only own event posts, other owner/event/absent all NOT_FOUND even for admin", async () => {
  await insert(id1);
  await insert(id2, event, other);
  await insert(id3, otherEvent);
  await db.query(
    "UPDATE public.event_members SET role='admin' WHERE user_id=$1",
    [owner],
  );
  assert.deepEqual(
    (await read()).items.map((p) => p.id),
    [id1],
  );
  for (const id of [id2, id3, randomUUID()])
    assert.equal((await read({ id })).code, "NOT_FOUND");
  assert.equal((await read({ user: randomUUID() })).code, "FORBIDDEN");
  assert.equal((await read({ scope: randomUUID() })).code, "FORBIDDEN");
});
test("BAN, no consent, publication stop and private event do not hide one's status", async () => {
  await insert(id1);
  await db.exec(
    "UPDATE public.event_members SET is_banned=true,banned_at=now(); UPDATE public.events SET status='private',terms_version='new'; UPDATE public.event_settings SET publication_stopped=true,uploads_enabled=false",
  );
  assert.equal((await read({ id: id1 })).items[0].id, id1);
  assert.equal((await read()).items.length, 1);
});
test("full status lifecycle is current, not the immutable upload receipt", async () => {
  await insert(id1);
  for (const status of [
    "uploading",
    "upload_failed",
    "uploaded",
    "processing",
    "published",
    "published_flagged",
    "blocked",
    "held",
    "hidden",
    "deleted",
  ]) {
    await db.query(
      `UPDATE public.posts SET status=$1::text::public.post_status,version=version+1,
      moderation_verdict=CASE WHEN $1='published' THEN 'PASS' WHEN $1='published_flagged' THEN 'FLAG' ELSE NULL END,
      published_at=now(),previous_public_status='published',hidden_reason='moderator',
      deleted_at=CASE WHEN $1='deleted' THEN now() ELSE NULL END WHERE id=$2`,
      [status, id1],
    );
    const row = (await read({ id: id1 })).items[0];
    assert.equal(row.status, status);
    assert.ok(row.version >= 2);
  }
});
test("never returns raw processing details, free category, media or owner identity", async () => {
  await insert(id1);
  await db.exec(
    "UPDATE public.posts SET status='blocked',processing_error='private token',block_category='raw OCR private text'",
  );
  assert.deepEqual((await read()).items[0], {
    id: id1,
    event_id: event,
    status: "blocked",
    version: 1,
    created_at: stamp,
    error_code: "CONTENT_BLOCKED",
  });
  await db.exec("UPDATE public.posts SET status='held'");
  assert.equal((await read()).items[0].error_code, "PROCESSING_HELD");
  await db.exec("UPDATE public.posts SET processing_error='VIDEO_TOO_LONG'");
  assert.equal((await read()).items[0].error_code, "VIDEO_TOO_LONG");
  await db.exec(
    "UPDATE public.posts SET status='published',moderation_verdict='PASS',published_at=now()",
  );
  assert.equal((await read()).items[0].error_code, undefined);
});
test("microsecond and UUID ties paginate without loss; later new arrivals do not shift the cursor", async () => {
  await insert(id1);
  await insert(id2);
  await insert(id3, event, owner, "2026-10-05T00:00:00.123457Z");
  const first = await read({ limit: 1 });
  assert.equal(first.has_more, true);
  assert.equal(first.items[0].id, id3);
  const newId = await insert(
    undefined,
    event,
    owner,
    "2026-10-05T00:00:01.000000Z",
  );
  const second = await read({
    limit: 1,
    before: first.items[0].created_at,
    beforeId: id3,
  });
  assert.equal(second.items[0].id, id2);
  // Cursor row need not still exist, and later deletion must not offset-skip rows.
  await db.query("DELETE FROM public.posts WHERE id=$1", [id2]);
  const third = await read({
    limit: 1,
    before: second.items[0].created_at,
    beforeId: id2,
  });
  assert.equal(third.items[0].id, id1);
  assert.equal(third.has_more, false);
  assert.equal((await read({ limit: 1 })).items[0].id, newId);
});
test("membership is rechecked on every call and status is not cached", async () => {
  await insert(id1);
  assert.equal((await read()).items.length, 1);
  // Same-memory isolated database: removal needs posts removed first because of FK.
  await db.exec("DELETE FROM public.posts; DELETE FROM public.event_members");
  assert.equal((await read()).code, "FORBIDDEN");
});
test("empty and exact-size pages have no phantom next page", async () => {
  assert.deepEqual(await read(), { code: "ok", items: [], has_more: false });
  await insert(id1);
  assert.equal((await read({ limit: 1 })).has_more, false);
});
for (const input of [
  { limit: 0 },
  { limit: 101 },
  { limit: null },
  { scope: null },
  { user: null },
  { before: stamp },
  { beforeId: id1 },
  { before: "infinity", beforeId: id1 },
  { id: id1, limit: 30 },
  { id: id1, before: stamp, beforeId: id2 },
])
  test(`rejects invalid RPC arguments ${JSON.stringify(input)}`, async () =>
    assert.equal((await read(input)).code, "INVALID_INPUT"));
