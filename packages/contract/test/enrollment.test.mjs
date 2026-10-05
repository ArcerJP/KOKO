import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { URL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { parse } from "yaml";

const db = new PGlite();
const event = "11111111-1111-4111-8111-111111111111";
const user = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
before(async () => {
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid; $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,service_role;`);
  const directory = new URL(
    "../../../apps/api/supabase/migrations/",
    import.meta.url,
  );
  for (const file of (await readdir(directory))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(await readFile(new URL(file, directory), "utf8"));
});
beforeEach(async () => {
  await db.exec("RESET ROLE; TRUNCATE public.events,auth.users CASCADE;");
  await db.query("INSERT INTO auth.users(id) VALUES($1),($2)", [user, other]);
  await db.query(
    `INSERT INTO public.events(event_id,slug,name,status,starts_at,ends_at,archive_at,private_at,terms_version)
    VALUES($1,'enrollment-fixture','Fixture','live',clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',clock_timestamp()+interval '2 days',clock_timestamp()+interval '3 days','fixture-v1')`,
    [event],
  );
  await db.query(
    "INSERT INTO public.event_settings(event_id,uploads_enabled,publication_stopped) VALUES($1,true,false)",
    [event],
  );
});
after(async () => db.close());

async function call(name, params, role = "service_role") {
  assert.ok(["read_event_enrollment", "enroll_event"].includes(name));
  assert.ok(["service_role", "anon", "authenticated"].includes(role));
  await db.exec(`SET ROLE ${role}`);
  try {
    return (
      await db.query(
        `SELECT public.${name}(${params.map((_, i) => `$${i + 1}`).join(",")}) AS result`,
        params,
      )
    ).rows[0].result;
  } finally {
    await db.exec("RESET ROLE");
  }
}
const read = (e = event, u = user) => call("read_event_enrollment", [e, u]);
const enroll = (name = "Fixture", e = event, u = user) =>
  call("enroll_event", [e, u, name]);
const members = async () =>
  (await db.query("SELECT * FROM public.event_members ORDER BY user_id")).rows;

test("service-only fixed-search-path functions retain RLS and browser denial", async () => {
  for (const [name, args, signature] of [
    ["read_event_enrollment", [event, user], "uuid,uuid"],
    ["enroll_event", [event, user, "Fixture"], "uuid,uuid,text"],
  ]) {
    const info = (
      await db.query(
        "SELECT prosecdef,proconfig,provolatile FROM pg_proc WHERE oid=$1::regprocedure",
        [`public.${name}(${signature})`],
      )
    ).rows[0];
    assert.equal(info.prosecdef, true);
    assert.ok(info.proconfig.some((v) => v === 'search_path=""'));
    assert.equal(
      info.provolatile,
      name === "read_event_enrollment" ? "s" : "v",
    );
    for (const role of ["anon", "authenticated"])
      await assert.rejects(
        call(name, args, role),
        (error) => error.code === "42501",
      );
  }
  const tables = (
    await db.query(
      "SELECT relrowsecurity FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace WHERE n.nspname='public' AND relkind='r'",
    )
  ).rows;
  assert.equal(tables.length, 14);
  assert.ok(tables.every((t) => t.relrowsecurity));
  assert.deepEqual(await members(), []);
});
test("preflight has no writes or profile data; creation has fixed lowest privileges and no consent", async () => {
  assert.deepEqual(await read(), {
    code: "ok",
    status: "not_enrolled",
    can_enroll: true,
  });
  assert.deepEqual(await members(), []);
  assert.equal(await enroll(" 試験名 "), "enrolled");
  const [member] = await members();
  assert.equal(member.display_name, " 試験名 ");
  assert.equal(member.role, "user");
  assert.equal(member.is_banned, false);
  assert.equal(member.crown, "none");
  assert.equal(member.block_count, 0);
  assert.equal(member.published_post_count, 0);
  assert.equal(member.banned_at, null);
  assert.equal(
    (await db.query("SELECT count(*)::integer AS n FROM public.consents"))
      .rows[0].n,
    0,
  );
  assert.deepEqual(await read(), {
    code: "ok",
    status: "enrolled",
    can_enroll: false,
  });
});
test("retries and conflicting names never change an existing BAN/admin membership", async () => {
  await enroll();
  await db.exec(
    "UPDATE public.event_members SET role='admin',is_banned=true,banned_at=clock_timestamp(),block_count=3,crown='gold',published_post_count=4",
  );
  const before = await members();
  assert.equal(await enroll("Replacement"), "enrolled");
  await db.exec(
    "UPDATE public.events SET status='private'; DELETE FROM public.event_settings;",
  );
  assert.equal(await enroll("Other"), "enrolled");
  assert.deepEqual(await members(), before);
  assert.deepEqual(await read(), {
    code: "ok",
    status: "enrolled",
    can_enroll: false,
  });
});
test("repeated asynchronous submissions produce exactly one unchanged member", async () => {
  // PGlite serializes one connection: true multi-connection lock races remain an integration gate.
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      db.query("SELECT public.enroll_event($1,$2,$3) AS result", [
        event,
        user,
        `Fixture ${i}`,
      ]),
    ),
  );
  assert.ok(results.every((r) => r.rows[0].result === "enrolled"));
  assert.equal((await members()).length, 1);
  assert.equal((await members())[0].display_name, "Fixture 0");
});
for (const [name, sql, code] of [
  ["draft", "UPDATE public.events SET status='draft'", "EVENT_CLOSED"],
  ["archive", "UPDATE public.events SET status='archive'", "EVENT_CLOSED"],
  ["private", "UPDATE public.events SET status='private'", "EVENT_CLOSED"],
  [
    "before start",
    "UPDATE public.events SET starts_at=clock_timestamp()+interval '1 hour'",
    "EVENT_CLOSED",
  ],
  [
    "ended",
    "UPDATE public.events SET ends_at=clock_timestamp()",
    "EVENT_CLOSED",
  ],
  [
    "upload stop",
    "UPDATE public.event_settings SET uploads_enabled=false",
    "EVENT_CLOSED",
  ],
  [
    "publication stop",
    "UPDATE public.event_settings SET publication_stopped=true",
    "PUBLICATION_STOPPED",
  ],
  ["missing settings", "DELETE FROM public.event_settings", "INTERNAL_ERROR"],
])
  test(`${name} closes preflight and first enrollment without insertion`, async () => {
    await db.exec(sql);
    const state = await read();
    if (code === "INTERNAL_ERROR") assert.equal(state.code, code);
    else
      assert.deepEqual(state, {
        code: "ok",
        status: "not_enrolled",
        can_enroll: false,
      });
    assert.equal(await enroll(), code);
    assert.deepEqual(await members(), []);
  });
for (const value of [
  null,
  "",
  " ",
  "\n",
  "\t",
  "x\u0001",
  "x\u200b",
  "x\ufeff",
  "x".repeat(51),
])
  test(`invalid display name ${JSON.stringify(value)}`, async () => {
    assert.equal(await enroll(value), "INVALID_INPUT");
    assert.deepEqual(await members(), []);
  });
test("unknown event/user and null identity cannot create membership", async () => {
  for (const [e, u, code] of [
    [other, user, "FORBIDDEN"],
    [event, event, "FORBIDDEN"],
    [null, user, "INVALID_INPUT"],
    [event, null, "INVALID_INPUT"],
  ]) {
    assert.equal(await enroll("Fixture", e, u), code);
    assert.equal((await read(e, u)).code, code);
  }
  assert.deepEqual(await members(), []);
});
test("independent subjects never update or disclose another membership", async () => {
  await enroll("First");
  assert.deepEqual(await read(event, other), {
    code: "ok",
    status: "not_enrolled",
    can_enroll: true,
  });
  assert.equal(await enroll("Second", event, other), "enrolled");
  assert.deepEqual(
    (await members()).map((m) => m.display_name),
    ["First", "Second"],
  );
});
test("suppressed insertion cannot report successful enrollment", async () => {
  await db.exec(`CREATE FUNCTION public.fixture_suppress_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$;
    CREATE TRIGGER fixture_suppress BEFORE INSERT ON public.event_members FOR EACH ROW EXECUTE FUNCTION public.fixture_suppress_enrollment();`);
  try {
    await assert.rejects(enroll(), /Enrollment was not inserted/);
    assert.deepEqual(await members(), []);
  } finally {
    await db.exec(
      "DROP TRIGGER fixture_suppress ON public.event_members; DROP FUNCTION public.fixture_suppress_enrollment();",
    );
  }
});
test("outer rollback and stale-snapshot isolation do not report committed membership", async () => {
  await db.exec("BEGIN");
  try {
    assert.equal(await enroll(), "enrolled");
  } finally {
    await db.exec("ROLLBACK");
  }
  assert.deepEqual(await members(), []);
  await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    await assert.rejects(
      db.query("SELECT public.enroll_event($1,$2,$3)", [
        event,
        user,
        "Fixture",
      ]),
      (e) => e.code === "25001",
    );
  } finally {
    await db.exec("ROLLBACK");
  }
  assert.deepEqual(await members(), []);
});
test("OpenAPI declares separate preflight and explicit enrollment, without role inputs", async () => {
  const api = parse(
    await readFile(new URL("../openapi.yaml", import.meta.url), "utf8"),
  );
  const route = api.paths["/me/enrollment"];
  assert.equal(route.get.operationId, "getEnrollment");
  assert.equal(route.post.operationId, "enrollEvent");
  const input = api.components.schemas.EnrollmentRequest;
  assert.deepEqual(input.required, ["display_name"]);
  assert.deepEqual(Object.keys(input.properties), ["display_name"]);
  assert.equal(input.additionalProperties, false);
  assert.deepEqual(api.components.schemas.EnrollmentStatus.required, [
    "user_id",
    "event_id",
    "enrolled",
    "registration_open",
  ]);
});
