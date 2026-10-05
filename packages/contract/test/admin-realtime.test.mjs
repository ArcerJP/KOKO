import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { URL } from "node:url";
import { before, beforeEach, after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite();
const event = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222",
  user = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const topic = `koko:admin:${event}`;
const claims = {
  role: "authenticated",
  is_anonymous: false,
  sub: user,
  app_metadata: { provider: "google", providers: ["google"] },
};
before(async () => {
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    CREATE SCHEMA realtime;
    CREATE TABLE realtime.messages(id serial,topic text,extension text,payload jsonb,event text,private boolean);
    ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA realtime TO anon,authenticated,service_role;
    GRANT SELECT,INSERT ON realtime.messages TO anon,authenticated,service_role;
    GRANT USAGE ON SEQUENCE realtime.messages_id_seq TO anon,authenticated,service_role;
    CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('realtime.topic',true) $$;
    CREATE FUNCTION realtime.send(jsonb,text,text,boolean) RETURNS void LANGUAGE sql AS $$ INSERT INTO realtime.messages(payload,event,topic,private,extension) VALUES($1,$2,$3,$4,'broadcast') $$;
    CREATE POLICY preexisting_read ON realtime.messages FOR SELECT TO anon,authenticated USING(true);
    CREATE POLICY preexisting_write ON realtime.messages FOR INSERT TO anon,authenticated WITH CHECK(true);`);
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
  await db.exec(
    "RESET ROLE; CREATE OR REPLACE FUNCTION realtime.send(jsonb,text,text,boolean) RETURNS void LANGUAGE sql AS $$ INSERT INTO realtime.messages(payload,event,topic,private,extension) VALUES($1,$2,$3,$4,'broadcast') $$",
  );
  await db.exec(
    "RESET ROLE; TRUNCATE public.events,auth.users,realtime.messages CASCADE",
  );
  await db.query("INSERT INTO auth.users VALUES($1)", [user]);
  await db.query(
    `INSERT INTO public.events(event_id,slug,name,status,starts_at,ends_at,archive_at,private_at,terms_version) VALUES($1,'fixture','Fixture','live','2020-01-01','2099-01-01','2099-02-01','2099-03-01','test')`,
    [event],
  );
  await db.query("INSERT INTO public.event_settings(event_id) VALUES($1)", [
    event,
  ]);
  await db.query(
    "INSERT INTO public.event_members(event_id,user_id,display_name,role) VALUES($1,$2,'Fixture','admin')",
    [event, user],
  );
  await db.query(
    "INSERT INTO public.consents(event_id,user_id,terms_version) VALUES($1,$2,'test')",
    [event, user],
  );
  await db.query(
    "SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false),set_config('realtime.topic',$3,false)",
    [user, JSON.stringify(claims), topic],
  );
});
after(() => db.close());
const allowed = async (value = topic) =>
  (
    await db.query(
      "SELECT koko_private.can_receive_admin_invalidation($1) ok",
      [value],
    )
  ).rows[0].ok;
const enable = () =>
  db.exec("UPDATE public.event_settings SET admin_realtime_enabled=true");
test("disabled by default; explicit admin/moderator + current Google consent needed", async () => {
  assert.equal(await allowed(), false);
  await enable();
  assert.equal(await allowed(), true);
  await db.exec("UPDATE public.event_members SET role='moderator'");
  assert.equal(await allowed(), true);
  await db.exec("UPDATE public.event_members SET role='user'");
  assert.equal(await allowed(), false);
});
for (const mutation of [
  "UPDATE public.event_members SET is_banned=true,banned_at=now()",
  "DELETE FROM public.consents",
  "UPDATE public.events SET terms_version='new'",
  "DELETE FROM public.consents; DELETE FROM public.event_members",
  "UPDATE public.events SET terms_version=''; INSERT INTO public.consents(event_id,user_id,terms_version) SELECT event_id,user_id,'' FROM public.event_members",
])
  test(`revoked scope ${mutation}`, async () => {
    await enable();
    await db.exec(mutation);
    assert.equal(await allowed(), false);
  });
for (const replacement of [
  { ...claims, role: "anon" },
  { ...claims, is_anonymous: true },
  { ...claims, sub: other },
  { ...claims, app_metadata: { provider: "email", providers: ["email"] } },
  {
    ...claims,
    app_metadata: { provider: "google", providers: ["google", "email"] },
  },
  {},
  null,
])
  test(`reject claims ${JSON.stringify(replacement)}`, async () => {
    await enable();
    await db.query("SELECT set_config('request.jwt.claims',$1,false)", [
      JSON.stringify(replacement),
    ]);
    assert.equal(await allowed(), false);
  });
for (const value of [
  "",
  `koko:admin:${other}`,
  `${topic}:x`,
  "koko:public:x",
  "admin",
  "koko:admin:bad",
])
  test(`topic isolation ${value}`, async () => {
    await enable();
    assert.equal(await allowed(value), false);
  });
test("private minimal broadcast never contains row contents, event change uses same topic", async () => {
  await enable();
  await db.exec(
    "TRUNCATE realtime.messages; UPDATE public.event_members SET display_name='Sensitive synthetic name'",
  );
  const { rows } = await db.query(
    "SELECT topic,event,payload,private FROM realtime.messages",
  );
  assert.deepEqual(rows, [
    { topic, event: "invalidate", payload: { changed: true }, private: true },
  ]);
});
test("restrictive namespace guard withstands pre-existing permissive policies", async () => {
  await enable();
  await db.query(
    "INSERT INTO realtime.messages(topic,extension,payload) VALUES($1,'broadcast','{}'),($2,'broadcast','{}'),('other','broadcast','{}')",
    [topic, `koko:admin:${other}`],
  );
  await db.exec("SET ROLE authenticated");
  assert.ok(
    (await db.query("SELECT topic FROM realtime.messages")).rows.every(
      (row) => row.topic === topic,
    ),
  );
  await assert.rejects(
    db.query(
      "INSERT INTO realtime.messages(topic,extension) VALUES($1,'broadcast')",
      [topic],
    ),
    /row-level security/,
  );
  await db.exec(
    "RESET ROLE; UPDATE public.event_members SET role='user'; SET ROLE authenticated",
  );
  assert.equal(
    (await db.query("SELECT * FROM realtime.messages")).rows.length,
    0,
  );
  await db.exec("RESET ROLE");
});
test("service trigger failure cannot prevent a safety mutation", async () => {
  await enable();
  await db.exec(
    `CREATE OR REPLACE FUNCTION realtime.send(jsonb,text,text,boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$; UPDATE public.event_members SET is_banned=true,banned_at=now()`,
  );
  assert.equal(
    (await db.query("SELECT is_banned FROM public.event_members")).rows[0]
      .is_banned,
    true,
  );
});

test("anon gets no KOKO namespace read or send despite permissive policies, without private-schema grants", async () => {
  await enable();
  await db.query(
    "INSERT INTO realtime.messages(topic,extension,payload) VALUES($1,'broadcast','{}'),('other','broadcast','{}')",
    [topic],
  );
  await db.exec("SET ROLE anon");
  try {
    assert.equal(
      (
        await db.query(
          "SELECT has_schema_privilege(current_user,'koko_private','USAGE') allowed",
        )
      ).rows[0].allowed,
      false,
    );
    assert.equal(
      (await db.query("SELECT * FROM realtime.messages")).rows.length,
      0,
    );
    await assert.rejects(
      db.query(
        "INSERT INTO realtime.messages(topic,extension) VALUES($1,'broadcast')",
        [topic],
      ),
      /row-level security/,
    );
    await assert.rejects(allowed(), /permission denied/);
    await db.query("SELECT set_config('realtime.topic','other',false)");
    assert.deepEqual(
      (await db.query("SELECT topic FROM realtime.messages")).rows,
      [{ topic: "other" }],
    );
    await db.query(
      "INSERT INTO realtime.messages(topic,extension) VALUES('other','broadcast')",
    );
  } finally {
    await db.exec("RESET ROLE");
  }
});

test("authenticated non-Google and revoked claims cannot exploit broad SELECT policy", async () => {
  await enable();
  await db.exec("SET ROLE authenticated");
  try {
    assert.ok(
      (await db.query("SELECT * FROM realtime.messages")).rows.length > 0,
    );
    await db.query("SELECT set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({
        ...claims,
        app_metadata: { provider: "email", providers: ["email"] },
      }),
    ]);
    assert.equal(
      (await db.query("SELECT * FROM realtime.messages")).rows.length,
      0,
    );
    await assert.rejects(
      db.query(
        "INSERT INTO realtime.messages(topic,extension) VALUES($1,'broadcast')",
        [topic],
      ),
      /row-level security/,
    );
  } finally {
    await db.exec("RESET ROLE");
  }
});

for (const hasRealtime of [false, true])
  test(`Realtime schema preflight: present=${hasRealtime}, never changes table RLS`, async () => {
    const isolated = new PGlite();
    try {
      await isolated.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
      CREATE SCHEMA koko_private; CREATE TABLE public.event_settings(event_id uuid);`);
      for (const table of [
        "posts",
        "reports",
        "appeals",
        "themes",
        "event_members",
        "events",
      ])
        await isolated.exec(`CREATE TABLE public.${table}(event_id uuid)`);
      if (hasRealtime)
        await isolated.exec(
          "CREATE SCHEMA realtime; CREATE TABLE realtime.messages(topic text,extension text)",
        );
      const migration = await readFile(
        new URL(
          "../../../apps/api/supabase/migrations/20261006070000_admin_realtime.sql",
          import.meta.url,
        ),
        "utf8",
      );
      if (hasRealtime) {
        await assert.rejects(
          isolated.exec(migration),
          /KOKO_ADMIN_REALTIME_PREFLIGHT_FAILED/,
        );
        await isolated.exec("ROLLBACK");
        assert.equal(
          (
            await isolated.query(
              "SELECT relrowsecurity FROM pg_class WHERE oid='realtime.messages'::regclass",
            )
          ).rows[0].relrowsecurity,
          false,
        );
      } else {
        await isolated.exec(migration);
        await isolated.exec(
          "INSERT INTO public.event_settings(event_id) VALUES('11111111-1111-4111-8111-111111111111')",
        );
        assert.equal(
          (
            await isolated.query(
              "SELECT admin_realtime_enabled FROM public.event_settings",
            )
          ).rows[0].admin_realtime_enabled,
          false,
        );
      }
    } finally {
      await isolated.close();
    }
  });
