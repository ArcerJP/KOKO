import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { originalKey, postStates } from "../dist/index.js";

const db = new PGlite();
const eventA = "11111111-1111-4111-8111-111111111111";
const eventB = "22222222-2222-4222-8222-222222222222";
const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const postA = "33333333-3333-4333-8333-333333333333";
const postB = "44444444-4444-4444-8444-444444444444";
const assetA = "55555555-5555-4555-8555-555555555555";
const themeB = "66666666-6666-4666-8666-666666666666";

before(async () => {
  // Supabase管理領域だけをテスト用に模擬。Google OAuthそのものはテストしない。
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
  await db.exec(
    await readFile(
      new URL(
        "../../../apps/api/supabase/migrations/20260921000000_initial_contract.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.query("INSERT INTO auth.users (id) VALUES ($1), ($2)", [
    userA,
    userB,
  ]);
  for (const [event, user, slug] of [
    [eventA, userA, "fixture-a"],
    [eventB, userB, "fixture-b"],
  ]) {
    await db.query(
      "INSERT INTO public.events (event_id,slug,name,starts_at,ends_at,archive_at,private_at,terms_version) VALUES ($1,$2,$2,'2026-10-10','2026-10-12','2026-11-12','2027-01-12','fixture-v1')",
      [event, slug],
    );
    await db.query(
      "INSERT INTO public.event_members (event_id,user_id,display_name) VALUES ($1,$2,'テスト利用者')",
      [event, user],
    );
    await db.query("INSERT INTO public.event_settings (event_id) VALUES ($1)", [
      event,
    ]);
  }
  for (const [event, user, post] of [
    [eventA, userA, postA],
    [eventB, userB, postB],
  ]) {
    await db.query(
      "INSERT INTO public.posts (event_id,id,user_id,kind,client_request_id,declared_content_type,original_scope) VALUES ($1,$2,$3,'photo',$2,'image/jpeg','photo_file')",
      [event, post, user],
    );
  }
  await db.query(
    "INSERT INTO public.themes (event_id,id,title,starts_at,ends_at) VALUES ($1,$2,'別イベントのお題','2026-10-10','2026-10-12')",
    [eventB, themeB],
  );
  await db.query(
    "INSERT INTO public.media_assets (event_id,id,post_id,purpose,provider,object_key) VALUES ($1,$2,$3,'original','r2_original',$4)",
    [eventA, assetA, postA, originalKey(eventA, postA, assetA)],
  );
});
after(async () => {
  await db.close();
});

async function asRole(role, user, run) {
  assert.ok(["anon", "authenticated", "service_role"].includes(role));
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [
    user ?? "",
  ]);
  await db.exec(`SET ROLE ${role}`);
  try {
    await run();
  } finally {
    await db.exec("RESET ROLE");
  }
}
const sqlError = (code) => (error) => error.code === code;

test("初期migrationを実行でき、全14アプリテーブルにevent_idとRLSがある", async () => {
  const { rows } = await db.query(
    "SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'",
  );
  assert.equal(rows.length, 14);
  for (const table of rows) {
    assert.equal(table.relrowsecurity, true, table.relname);
    const columns = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='event_id'",
      [table.relname],
    );
    assert.equal(columns.rows.length, 1, table.relname);
  }
  const states = await db.query(
    "SELECT enumlabel FROM pg_enum WHERE enumtypid = 'public.post_status'::regtype ORDER BY enumsortorder",
  );
  assert.deepEqual(
    states.rows.map((row) => row.enumlabel),
    [...postStates],
  );
});

test("匿名はプロフィール・投稿・原本・監査へアクセスできない", async () => {
  await asRole("anon", null, async () => {
    for (const table of [
      "events",
      "event_members",
      "posts",
      "media_assets",
      "audit_logs",
    ])
      await assert.rejects(
        db.query(`SELECT * FROM public.${table}`),
        sqlError("42501"),
      );
  });
});

test("認証利用者は自分の所属だけを読み、他イベントや管理設定を読めない", async () => {
  await asRole("authenticated", userA, async () => {
    assert.deepEqual(
      (await db.query("SELECT user_id FROM public.event_members")).rows.map(
        (row) => row.user_id,
      ),
      [userA],
    );
    assert.deepEqual(
      (await db.query("SELECT event_id FROM public.events")).rows.map(
        (row) => row.event_id,
      ),
      [eventA],
    );
    for (const table of [
      "posts",
      "media_assets",
      "upload_sessions",
      "moderation_runs",
      "event_settings",
      "audit_logs",
      "outbox_jobs",
    ])
      await assert.rejects(
        db.query(`SELECT * FROM public.${table}`),
        sqlError("42501"),
      );
  });
});

test("一般利用者は自分のrole/BANを更新したり投稿を直接公開したりできない", async () => {
  await asRole("authenticated", userA, async () => {
    await assert.rejects(
      db.query(
        "UPDATE public.event_members SET role='admin' WHERE user_id=$1",
        [userA],
      ),
      sqlError("42501"),
    );
    await assert.rejects(
      db.query("UPDATE public.posts SET status='published' WHERE id=$1", [
        postA,
      ]),
      sqlError("42501"),
    );
    await assert.rejects(
      db.query(
        "INSERT INTO public.likes(event_id,post_id,user_id) VALUES ($1,$2,$3)",
        [eventA, postA, userA],
      ),
      sqlError("42501"),
    );
  });
});

test("service_roleはAPI認可を代替しない（意図したRLSバイパスを可視化）", async () => {
  await asRole("service_role", null, async () => {
    assert.equal((await db.query("SELECT * FROM public.posts")).rows.length, 2);
    assert.equal(
      (await db.query("SELECT * FROM public.media_assets")).rows.length,
      1,
    );
  });
});

test("同じイベントの所有者・お題・原本だけを関連付けられる", async () => {
  await assert.rejects(
    db.query("UPDATE public.posts SET theme_id=$1 WHERE id=$2", [
      themeB,
      postA,
    ]),
    sqlError("23503"),
  );
  await assert.rejects(
    db.query("UPDATE public.posts SET user_id=$1 WHERE id=$2", [userB, postA]),
    sqlError("23503"),
  );
  await assert.rejects(
    db.query(
      "INSERT INTO public.upload_sessions(event_id,post_id,asset_id,mode,expires_at) VALUES ($1,$2,$3,'single',now()+interval '1 hour')",
      [eventB, postB, assetA],
    ),
    sqlError("23503"),
  );
  await assert.rejects(
    db.query(
      "INSERT INTO public.appeals(event_id,user_id,post_id,message) VALUES ($1,$2,$3,'誤判定の申立て')",
      [eventA, userA, postB],
    ),
    sqlError("23503"),
  );
});

test("原本欄に公開URLや別パスを保存できない", async () => {
  for (const key of [
    "https://example.com/original.jpg",
    `events/${eventB}/secret`,
    "../private",
  ])
    await assert.rejects(
      db.query("UPDATE public.media_assets SET object_key=$1 WHERE id=$2", [
        key,
        assetA,
      ]),
      sqlError("23514"),
    );
});

test("未判定・4秒超・BANラッチ中の公開をDBも拒否する", async () => {
  await assert.rejects(
    db.query(
      "UPDATE public.posts SET status='published',published_at=now() WHERE id=$1",
      [postA],
    ),
    sqlError("23514"),
  );
  await assert.rejects(
    db.query(
      "UPDATE public.posts SET status='published',kind='video',original_scope='client_trimmed',moderation_verdict='PASS',published_at=now(),measured_duration_seconds=4.01 WHERE id=$1",
      [postA],
    ),
    sqlError("23514"),
  );
  await assert.rejects(
    db.query(
      "UPDATE public.posts SET status='published',moderation_verdict='PASS',published_at=now(),ban_latched=true WHERE id=$1",
      [postA],
    ),
    sqlError("23514"),
  );
});

test("冪等キー・いいね・通報の重複と負カウンタをDBで拒否する", async () => {
  await assert.rejects(
    db.query(
      "INSERT INTO public.posts(event_id,user_id,kind,client_request_id,declared_content_type,original_scope) VALUES ($1,$2,'photo',$3,'image/jpeg','photo_file')",
      [eventA, userA, postA],
    ),
    sqlError("23505"),
  );
  await db.query(
    "INSERT INTO public.likes(event_id,post_id,user_id) VALUES ($1,$2,$3)",
    [eventA, postA, userA],
  );
  await assert.rejects(
    db.query(
      "INSERT INTO public.likes(event_id,post_id,user_id) VALUES ($1,$2,$3)",
      [eventA, postA, userA],
    ),
    sqlError("23505"),
  );
  await db.query(
    "INSERT INTO public.reports(event_id,post_id,reporter_id,reason) VALUES ($1,$2,$3,'privacy')",
    [eventA, postA, userA],
  );
  await assert.rejects(
    db.query(
      "INSERT INTO public.reports(event_id,post_id,reporter_id,reason) VALUES ($1,$2,$3,'privacy')",
      [eventA, postA, userA],
    ),
    sqlError("23505"),
  );
  await assert.rejects(
    db.query("UPDATE public.posts SET like_count=-1 WHERE id=$1", [postA]),
    sqlError("23514"),
  );
});

test("初期設定は公開停止・受付停止でfail-closed", async () => {
  const { rows } = await db.query(
    "SELECT publication_stopped, uploads_enabled, thresholds_approved FROM public.event_settings",
  );
  assert.ok(
    rows.every(
      (row) =>
        row.publication_stopped &&
        !row.uploads_enabled &&
        !row.thresholds_approved,
    ),
  );
});
