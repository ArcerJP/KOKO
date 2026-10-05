import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { before, beforeEach, after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite(),
  event = "11111111-1111-4111-8111-111111111111",
  account = "a".repeat(32);
before(async () => {
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,service_role;`);
  const root = new URL(
    "../../../apps/api/supabase/migrations/",
    import.meta.url,
  );
  for (const file of (await readdir(root))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await db.exec(await readFile(new URL(file, root), "utf8"));
});
beforeEach(async () => {
  await db.exec("RESET ROLE;TRUNCATE public.events,auth.users CASCADE");
  await db.query(
    `INSERT INTO public.events(event_id,slug,name,status,starts_at,ends_at,archive_at,private_at,terms_version)
    VALUES($1,'synthetic','Synthetic','live',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days',now()+interval '3 days','test')`,
    [event],
  );
  await db.query(
    "INSERT INTO public.event_settings(event_id,operational_outbox_enabled,capacity_limit_bytes,capacity_limit_approved) VALUES($1,true,1000,true)",
    [event],
  );
});
after(async () => db.close());
async function call(
  action = "claim",
  input = { account_id: account },
  role = "service_role",
  scope = event,
) {
  assert.ok(["service_role", "anon", "authenticated"].includes(role));
  await db.exec(`SET ROLE ${role}`);
  try {
    return (
      await db.query("SELECT public.manage_capacity_monitor($1,$2,$3) result", [
        scope,
        action,
        JSON.stringify(input),
      ])
    ).rows[0].result;
  } finally {
    await db.exec("RESET ROLE");
  }
}
async function plan() {
  const r = await call();
  assert.equal(r.code, "CLAIMED");
  return r.plan;
}
function samples(p, bytes = 250) {
  return ["koko-dev-originals", "koko-dev-derived"].map((bucket) => ({
    bucket,
    observed_at: p.window_end,
    payload_bytes: bytes,
    metadata_bytes: 0,
    object_count: 1,
  }));
}
async function finish(p, items = samples(p)) {
  return call("finish", { plan: p, samples: items });
}
async function state() {
  return (
    await db.query(
      "SELECT capacity_monitor_state result FROM public.event_settings",
    )
  ).rows[0].result;
}
async function jobs() {
  return (await db.query("SELECT * FROM public.outbox_jobs")).rows;
}
test("all migrations, service-only fixed-search-path invoker", async () => {
  for (const role of ["anon", "authenticated"])
    await assert.rejects(
      call("claim", { account_id: account }, role),
      /permission denied/,
    );
  const r = (
    await db.query(
      "SELECT prosecdef,proconfig FROM pg_proc WHERE proname='manage_capacity_monitor'",
    )
  ).rows[0];
  assert.equal(r.prosecdef, false);
  assert.deepEqual(r.proconfig, ['search_path=""']);
});
test("READ COMMITTED required", async () => {
  await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    await assert.rejects(
      db.query("SELECT public.manage_capacity_monitor($1,'claim',$2)", [
        event,
        JSON.stringify({ account_id: account }),
      ]),
      /READ COMMITTED/,
    );
  } finally {
    await db.exec("ROLLBACK");
  }
});
for (const field of [
  "operational_outbox_enabled=false",
  "capacity_limit_approved=false",
  "capacity_limit_bytes=NULL",
])
  test(`missing gate ${field} never produces plan/measurement/job`, async () => {
    await db.exec(`UPDATE public.event_settings SET ${field}`);
    assert.equal((await call()).code, "DISABLED");
    assert.deepEqual(await state(), {});
    assert.deepEqual(await jobs(), []);
  });
test("approval defaults false and cannot accompany a changed threshold in same update", async () => {
  const def = (
    await db.query(
      "SELECT column_default FROM information_schema.columns WHERE table_name='event_settings' AND column_name='capacity_limit_approved'",
    )
  ).rows[0];
  assert.equal(def.column_default, "false");
  const p = await plan();
  await db.exec(
    "UPDATE public.event_settings SET capacity_limit_bytes=2000,capacity_limit_approved=true",
  );
  const r = (
    await db.query(
      "SELECT capacity_limit_approved,capacity_policy_version FROM public.event_settings",
    )
  ).rows[0];
  assert.equal(r.capacity_limit_approved, false);
  assert.equal(Number(r.capacity_policy_version), 2);
  assert.deepEqual(await state(), {});
  assert.equal((await finish(p)).code, "DISABLED");
  await db.exec(
    "UPDATE public.event_settings SET capacity_limit_approved=true",
  );
  assert.equal((await finish(p)).code, "STALE");
});
test("unrelated settings edit preserves existing approval/version", async () => {
  await db.exec(
    "UPDATE public.event_settings SET publication_stopped=true,uploads_enabled=false",
  );
  assert.equal((await call()).code, "CLAIMED");
});
for (const input of [
  null,
  {},
  [],
  { account_id: "bad" },
  { account_id: account, url: "bad" },
  { account_id: "A".repeat(32) },
])
  test(`bad claim ${JSON.stringify(input)}`, async () => {
    assert.equal((await call("claim", input)).code, "INVALID_INPUT");
    assert.deepEqual(await state(), {});
  });
test("unknown event cannot claim", async () => {
  assert.equal(
    (await call("claim", { account_id: account }, "service_role", randomUUID()))
      .code,
    "NOT_FOUND",
  );
});
test("lease, 24h window, fixed hourly epoch, no double claim", async () => {
  const p = await plan();
  assert.equal(p.account_id, account);
  assert.equal(p.limit_bytes, 1000);
  assert.equal(p.epoch, Math.floor(Date.parse(p.window_end) / 3600000));
  assert.equal(Date.parse(p.window_end) - Date.parse(p.window_start), 86400000);
  assert.equal((await call()).code, "WAIT");
  assert.equal((await state()).attempt, 1);
});
test("expired lease bounded reclaim invalidates old plan", async () => {
  const p = await plan();
  await db.exec(
    "UPDATE public.event_settings SET capacity_monitor_state=jsonb_set(capacity_monitor_state,'{locked_until}',to_jsonb((now()-interval '1 second')::text))",
  );
  const next = await plan();
  assert.notEqual(next.lease_id, p.lease_id);
  assert.equal((await state()).attempt, 2);
  assert.equal((await finish(p)).code, "STALE");
});
test("empty/unknown measurement never becomes zero or a success", async () => {
  const p = await plan();
  assert.equal((await finish(p, [])).code, "INVALID_INPUT");
  assert.equal((await state()).status, "running");
  assert.deepEqual(await jobs(), []);
});
test("real zero samples are observed but not fabricated from absence", async () => {
  const p = await plan();
  assert.equal((await finish(p, samples(p, 0))).code, "OBSERVED");
  assert.equal((await state()).observed_bytes, 0);
  assert.deepEqual(await jobs(), []);
});
test("below threshold durable observation and dedup same epoch", async () => {
  const p = await plan();
  assert.equal((await finish(p)).code, "OBSERVED");
  assert.equal((await state()).observed_bytes, 500);
  assert.equal((await call()).code, "DONE");
  assert.equal((await finish(p)).code, "STALE");
  assert.deepEqual(await jobs(), []);
});
for (const bytes of [500, 600])
  test(`at/over threshold ${bytes * 2} produces one safe alert`, async () => {
    const p = await plan();
    assert.equal((await finish(p, samples(p, bytes))).code, "ALERTED");
    const rows = await jobs();
    assert.equal(rows.length, 1);
    const j = rows[0];
    assert.equal(j.kind, "notify");
    assert.equal(j.post_id, null);
    assert.equal(
      j.deduplication_key,
      `capacity:${p.policy_version}:${p.epoch}`,
    );
    assert.deepEqual(j.payload, {
      category: "capacity",
      source: "r2_storage",
      epoch: p.epoch,
      policy_version: p.policy_version,
      observed_bytes: bytes * 2,
      limit_bytes: 1000,
      observed_at: p.window_end,
    });
    assert.equal((await finish(p, samples(p, bytes))).code, "STALE");
    assert.equal((await jobs()).length, 1);
  });
test("metadata bytes are counted and sample timestamps are preserved", async () => {
  const p = await plan(),
    s = samples(p, 400);
  s[0].metadata_bytes = 100;
  s[1].metadata_bytes = 100;
  s[1].observed_at = new Date(Date.parse(p.window_end) - 3600000).toISOString();
  assert.equal((await finish(p, s)).code, "ALERTED");
  assert.equal(
    (await jobs())[0].payload.observed_at,
    s[1].observed_at.replace(".000Z", "Z"),
  );
});
test("capacity alert routes through operational outbox without user or raw metrics keys", async () => {
  const p = await plan();
  await finish(p, samples(p, 600));
  const j = (await jobs())[0];
  const c = (
    await db.query(
      "SELECT public.stage_three_outbox($1,NULL,'claim',$2) result",
      [event, JSON.stringify({ limit: 10, notify: true })],
    )
  ).rows[0].result.jobs[0];
  const result = (
    await db.query(
      "SELECT public.stage_three_outbox($1,$2,'prepare',$3) result",
      [event, j.id, JSON.stringify({ lease_id: c.lease_id })],
    )
  ).rows[0].result;
  assert.equal(result.code, "SEND");
  assert.equal(result.notification.category, "capacity");
  assert.equal(result.notification.display_name, "イベント容量監視");
  assert.equal(result.notification.post_id, null);
  assert.deepEqual(result.notification.capacity, {
    observed_bytes: 1200,
    limit_bytes: 1000,
    observed_at: p.window_end,
  });
  assert.equal(JSON.stringify(result).includes(account), false);
});
for (const change of [
  (s) => s.pop(),
  (s) => s.push(s[0]),
  (s) => {
    s[1].bucket = s[0].bucket;
  },
  (s) => {
    s[0].bucket = "foreign";
  },
  (s) => {
    s[0].payload_bytes = -1;
  },
  (s) => {
    s[0].payload_bytes = 1.5;
  },
  (s) => {
    s[0].payload_bytes = "1";
  },
  (s) => {
    s[0].metadata_bytes = null;
  },
  (s) => {
    s[0].object_count = -1;
  },
  (s) => {
    s[0].observed_at = "bad";
  },
  (s) => {
    s[0].observed_at = "2026-02-30T00:00:00Z";
  },
  (s) => {
    s[0].observed_at = "2026-99-99T00:00:00Z";
  },
  (s) => {
    s[0].observed_at = "2020-01-01T00:00:00Z";
  },
  (s) => {
    s[0].extra = "raw";
  },
  (s) => {
    s[0].payload_bytes = 9007199254740991;
    s[1].payload_bytes = 1;
  },
])
  test(`invalid sample ${change.toString()}`, async () => {
    const p = await plan(),
      s = samples(p);
    change(s);
    assert.equal((await finish(p, s)).code, "INVALID_INPUT");
    assert.deepEqual(await jobs(), []);
    assert.equal((await state()).status, "running");
  });
test("future and stale timestamps rejected in DB too", async () => {
  const p = await plan();
  for (const delta of [1000, -7201000]) {
    const s = samples(p);
    s[0].observed_at = new Date(Date.parse(p.window_end) + delta).toISOString();
    assert.equal((await finish(p, s)).code, "INVALID_INPUT");
  }
});
test("forged plan or extra finish input is rejected", async () => {
  const p = await plan();
  assert.equal(
    (await finish({ ...p, account_id: "b".repeat(32) })).code,
    "STALE",
  );
  assert.equal(
    (await call("finish", { plan: p, samples: samples(p), extra: true })).code,
    "INVALID_INPUT",
  );
});
test("failure uses finite backoff and unknown terminal status after three attempts", async () => {
  for (let i = 1; i <= 3; i++) {
    const p = await plan();
    assert.equal((await state()).attempt, i);
    assert.equal(
      (await call("fail", { plan: p })).code,
      i === 3 ? "UNKNOWN" : "RETRY",
    );
    if (i < 3) {
      assert.equal((await call()).code, "WAIT");
      await db.exec(
        "UPDATE public.event_settings SET capacity_monitor_state=jsonb_set(capacity_monitor_state,'{available_at}',to_jsonb((now()-interval '1 second')::text))",
      );
    }
  }
  assert.equal((await call()).code, "UNKNOWN");
  assert.equal((await state()).status, "unknown");
  assert.deepEqual(await jobs(), []);
});
test("three crashed attempts produce unknown without fourth provider plan", async () => {
  for (let i = 1; i <= 3; i++) {
    await plan();
    await db.exec(
      "UPDATE public.event_settings SET capacity_monitor_state=jsonb_set(capacity_monitor_state,'{locked_until}',to_jsonb((now()-interval '1 second')::text))",
    );
  }
  assert.equal((await call()).code, "UNKNOWN");
  assert.equal((await state()).status, "unknown");
});
test("new fixed epoch allows independent bounded measurement", async () => {
  const p = await plan();
  await finish(p);
  await db.query(
    "UPDATE public.event_settings SET capacity_monitor_state=jsonb_set(capacity_monitor_state,'{epoch}',$1)",
    [JSON.stringify(p.epoch - 1)],
  );
  const next = await plan();
  assert.equal(next.epoch, p.epoch);
  assert.equal((await state()).attempt, 1);
});
for (const override of [
  { source: "foreign" },
  { observed_bytes: 999 },
  { observed_bytes: "1200" },
  { limit_bytes: 0 },
  { epoch: 999999999999 },
  { policy_version: 0 },
  { observed_at: "2099-01-01T00:00:00Z" },
  { observed_at: "2026-99-99T00:00:00Z" },
  { url: "https://bad" },
])
  test(`malformed capacity notification ${JSON.stringify(override)} held`, async () => {
    const p = await plan();
    await finish(p, samples(p, 600));
    const j = (await jobs())[0];
    await db.query(
      "UPDATE public.outbox_jobs SET payload=payload||$1 WHERE id=$2",
      [JSON.stringify(override), j.id],
    );
    const c = (
      await db.query(
        "SELECT public.stage_three_outbox($1,NULL,'claim',$2) result",
        [event, JSON.stringify({ limit: 10, notify: true })],
      )
    ).rows[0].result.jobs[0];
    const result = (
      await db.query(
        "SELECT public.stage_three_outbox($1,$2,'prepare',$3) result",
        [event, j.id, JSON.stringify({ lease_id: c.lease_id })],
      )
    ).rows[0].result;
    assert.equal(result.code, "HELD");
    assert.equal(result.result, "INVALID_PAYLOAD");
  });
