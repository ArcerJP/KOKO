import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { before, beforeEach, after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const event = "11111111-1111-4111-8111-111111111111",
  owner = "22222222-2222-4222-8222-222222222222",
  post = "33333333-3333-4333-8333-333333333333",
  asset = "44444444-4444-4444-8444-444444444444",
  job = "55555555-5555-4555-8555-555555555555",
  producer = "66666666-6666-4666-8666-666666666666";
const policy = () => ({
  version: "synthetic-not-approved-for-use",
  approved_at: new Date(Date.now() - 3600000).toISOString(),
  valid_until: new Date(Date.now() + 86400000).toISOString(),
  original_seconds: 0,
  derived_seconds: 0,
  stream_seconds: 0,
  blocked_seconds: 0,
});
before(async () => {
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role; GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,service_role;`);
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
    `INSERT INTO public.events(event_id,slug,name,status,starts_at,ends_at,archive_at,private_at,terms_version) VALUES($1,'synthetic','Synthetic','live',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days',now()+interval '3 days','test')`,
    [event],
  );
  await db.query(
    "INSERT INTO public.event_settings(event_id,physical_deletion_enabled,physical_deletion_policy) VALUES($1,true,$2)",
    [event, JSON.stringify(policy())],
  );
  await db.query(
    "INSERT INTO public.event_members(event_id,user_id,display_name) VALUES($1,$2,'Synthetic')",
    [event, owner],
  );
  await db.query(
    `INSERT INTO public.posts(event_id,id,user_id,kind,status,deleted_at,client_request_id,declared_content_type,original_scope,original_bytes,version) VALUES($1,$2,$3,'photo','deleted',now(),$2,'image/jpeg','photo_file',100,3)`,
    [event, post, owner],
  );
  await db.query(
    `INSERT INTO public.media_assets(event_id,id,post_id,purpose,provider,object_key,byte_size,object_etag,object_version,retention_until,deletion_requested_at) VALUES($1,$2,$3,'original','r2_original',$4,100,$5,'v1',now()-interval '1 hour',now())`,
    [
      event,
      asset,
      post,
      `events/${event}/posts/${post}/original/${asset}.bin`,
      "a".repeat(32),
    ],
  );
  await db.query(
    `INSERT INTO public.upload_sessions(event_id,post_id,asset_id,mode,provider_upload_id,expires_at,completed_at,provisioning_state,provisioning_attempts,completion_parts,completion_result) VALUES($1,$2,$3,'multipart','synthetic-provider',now()-interval '1 hour',now()-interval '2 hours','ready',1,'[{"part_number":1,"etag":"synthetic"}]','{}')`,
    [event, post, asset],
  );
  await db.query(
    "INSERT INTO public.outbox_jobs(event_id,id,post_id,kind,deduplication_key,payload) VALUES($1,$2::uuid,$3,'delete_assets',$2::text,$4)",
    [event, job, post, JSON.stringify({ asset_id: asset, post_version: 3 })],
  );
});
after(async () => db.close());
async function call(
  action,
  input,
  jobId = job,
  role = "service_role",
  eventId = event,
) {
  assert.ok(["service_role", "authenticated", "anon"].includes(role));
  await db.exec(`SET ROLE ${role}`);
  try {
    return (
      await db.query("SELECT public.manage_physical_deletion($1,$2,$3,$4) r", [
        eventId,
        jobId,
        action,
        JSON.stringify(input),
      ])
    ).rows[0].r;
  } finally {
    await db.exec("RESET ROLE");
  }
}
async function claim() {
  return call("claim", { limit: 5 }, null);
}
async function prepared() {
  const c = (await claim()).jobs[0];
  assert.ok(c);
  return { c, r: await call("prepare", { lease_id: c.lease_id }) };
}
async function begun() {
  const x = await prepared();
  assert.equal(x.r.code, "PREPARED");
  assert.equal(
    (await call("begin", { lease_id: x.c.lease_id, plan: x.r.plan })).code,
    "CURRENT",
  );
  return x;
}
async function settle(x, result) {
  return call("settle", { lease_id: x.c.lease_id, plan: x.r.plan, result });
}
async function row() {
  return (await db.query("SELECT * FROM public.outbox_jobs WHERE id=$1", [job]))
    .rows[0];
}
test("all migrations apply, fixed search path invoker/service-only", async () => {
  for (const role of ["anon", "authenticated"])
    await assert.rejects(
      call("claim", { limit: 5 }, null, role),
      /permission denied/,
    );
  const p = (
    await db.query(
      "SELECT prosecdef,proconfig FROM pg_proc WHERE proname='manage_physical_deletion'",
    )
  ).rows[0];
  assert.equal(p.prosecdef, false);
  assert.deepEqual(p.proconfig, ['search_path=""']);
  assert.equal(
    (
      await db.query(
        "SELECT column_default FROM information_schema.columns WHERE table_name='event_settings' AND column_name='physical_deletion_enabled'",
      )
    ).rows[0].column_default,
    "false",
  );
});
for (const change of [
  "physical_deletion_enabled=false",
  "physical_deletion_policy=NULL",
])
  test(`disabled ${change}`, async () => {
    await db.exec(`UPDATE public.event_settings SET ${change}`);
    assert.equal((await claim()).code, "DISABLED");
    assert.equal((await row()).deletion_attempt, 0);
  });
for (const patch of [
  { original_seconds: -1 },
  { derived_seconds: 1.5 },
  { stream_seconds: "0" },
  { blocked_seconds: 315360001 },
  { version: "" },
  { approved_at: "infinity" },
  { valid_until: "invalid" },
  { valid_until: "2020-01-01T00:00:00Z" },
  { valid_until: "2100-01-01T00:00:00Z" },
  { extra: true },
  { approved_at: "now", valid_until: "tomorrow" },
])
  test(`invalid retention policy ${JSON.stringify(patch)}`, async () => {
    await db.query(
      "UPDATE public.event_settings SET physical_deletion_policy=$1",
      [JSON.stringify({ ...policy(), ...patch })],
    );
    assert.equal((await claim()).code, "DISABLED");
  });
for (const input of [
  {},
  null,
  [],
  { limit: 0 },
  { limit: 6 },
  { limit: 1.2 },
  { limit: "1" },
  { limit: 1, extra: true },
])
  test(`claim rejects ${JSON.stringify(input)}`, async () =>
    assert.equal((await call("claim", input, null)).code, "INVALID_INPUT"));
test("READ COMMITTED required", async () => {
  await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    await assert.rejects(
      db.query(
        "SELECT public.manage_physical_deletion($1,NULL,'claim','{\"limit\":5}')",
        [event],
      ),
      /READ COMMITTED/,
    );
  } finally {
    await db.exec("ROLLBACK");
  }
});
test("claim lease excludes concurrent claims, no object keys exposed", async () => {
  const c = await claim();
  assert.equal(c.jobs.length, 1);
  assert.deepEqual(Object.keys(c.jobs[0]).sort(), [
    "event_id",
    "job_id",
    "lease_id",
  ]);
  assert.equal((await claim()).jobs.length, 0);
});
test("old lease cannot prepare or finalize", async () => {
  const x = await begun();
  await db.exec(
    "UPDATE public.outbox_jobs SET deletion_locked_until=now()-interval '1 second'",
  );
  const next = await claim();
  assert.notEqual(next.jobs[0].lease_id, x.c.lease_id);
  assert.equal((await settle(x, "ABSENT")).code, "STALE");
});
test("confirmed multipart delete requires durable intent and records asset/audit only afterward", async () => {
  const x = await prepared();
  assert.equal(x.r.code, "PREPARED");
  assert.equal(x.r.plan.mode, "delete");
  assert.equal((await settle(x, "ABSENT")).code, "STALE");
  await call("begin", { lease_id: x.c.lease_id, plan: x.r.plan });
  assert.equal((await settle(x, "ABSENT")).code, "DONE");
  assert.ok(
    (await db.query("SELECT physically_deleted_at FROM public.media_assets"))
      .rows[0].physically_deleted_at,
  );
  assert.equal((await settle(x, "ABSENT")).code, "STALE");
  const audit = (
    await db.query(
      "SELECT metadata FROM public.audit_logs WHERE action='physical_deletion_settled'",
    )
  ).rows;
  assert.equal(audit.length, 1);
  assert.deepEqual(Object.keys(audit[0].metadata).sort(), [
    "policy_version",
    "result",
  ]);
});
for (const change of [
  "mode='single',provider_upload_id=NULL",
  "provisioning_attempts=2",
  "previous_upload_ids=ARRAY['77777777-7777-4777-8777-777777777777']::uuid[]",
  "completed_at=NULL,completion_result=NULL",
])
  test(`uncertain original held ${change}`, async () => {
    await db.exec(`UPDATE public.upload_sessions SET ${change}`);
    assert.equal((await prepared()).r.code, "HELD");
    assert.equal((await row()).deletion_result, "WRITE_OUTCOME_UNKNOWN");
  });
test("expired first ready multipart with no completion has bounded abort plan", async () => {
  await db.exec(
    "UPDATE public.upload_sessions SET completed_at=NULL,completion_parts=NULL,completion_result=NULL; UPDATE public.media_assets SET object_etag=NULL,object_version=NULL",
  );
  const x = await prepared();
  assert.equal(x.r.code, "PREPARED");
  assert.equal(x.r.plan.mode, "abort_multipart");
  assert.equal(x.r.plan.upload_id, "synthetic-provider");
});
for (const change of [
  "UPDATE public.media_assets SET retention_until=NULL",
  "UPDATE public.media_assets SET retention_until='infinity'",
])
  test(`unknown retention never deletes ${change}`, async () => {
    await db.exec(change);
    assert.equal((await prepared()).r.code, "HELD");
    assert.equal((await row()).deletion_result, "RETENTION_UNKNOWN");
  });
test("future retention schedules without consuming provider retry budget", async () => {
  await db.exec(
    "UPDATE public.media_assets SET retention_until=now()+interval '1 day'",
  );
  assert.equal((await prepared()).r.code, "WAIT");
  assert.equal((await row()).deletion_attempt, 0);
  assert.equal((await claim()).jobs.length, 0);
});
test("BLOCK uses longest approved retention", async () => {
  await db.exec("UPDATE public.posts SET moderation_verdict='BLOCK'");
  await db.query(
    "UPDATE public.event_settings SET physical_deletion_policy=$1",
    [JSON.stringify({ ...policy(), blocked_seconds: 86400 })],
  );
  assert.equal((await prepared()).r.code, "WAIT");
});
test("deleted post cleanup remains possible during BAN/private/publication stop without consent", async () => {
  await db.exec(
    "UPDATE public.events SET status='private'; UPDATE public.event_members SET is_banned=true,banned_at=now(); UPDATE public.event_settings SET publication_stopped=true,uploads_enabled=false",
  );
  assert.equal((await prepared()).r.code, "PREPARED");
});
for (const change of [
  "UPDATE public.posts SET status='held',deleted_at=NULL",
  "UPDATE public.media_assets SET deletion_requested_at=NULL",
  "UPDATE public.outbox_jobs SET payload='{}'",
])
  test(`intent malformed ${change}`, async () => {
    await db.exec(change);
    assert.equal((await prepared()).r.code, "HELD");
  });
test("live writer prevents delete even if lease expired", async () => {
  await db.query(
    "INSERT INTO public.outbox_jobs(event_id,id,post_id,kind,deduplication_key,payload,image_plan) VALUES($1,$2::uuid,$3,'process_media',$2::text,'{}','{}')",
    [event, producer, post],
  );
  assert.equal((await prepared()).r.code, "HELD");
  assert.equal((await row()).deletion_result, "WRITE_OUTCOME_UNKNOWN");
});
test("policy or identity drift fences prepare/settle instead of replacing tombstone", async () => {
  const x = await begun();
  await db.exec("UPDATE public.media_assets SET object_version='changed'");
  assert.equal((await settle(x, "ABSENT")).code, "HELD");
  assert.equal((await row()).deletion_result, "IDENTITY_MISMATCH");
  assert.equal(
    (await db.query("SELECT physically_deleted_at FROM public.media_assets"))
      .rows[0].physically_deleted_at,
    null,
  );
});
test("forged plan and result fail closed", async () => {
  const x = await begun();
  assert.equal(
    (
      await call("settle", {
        lease_id: x.c.lease_id,
        plan: { ...x.r.plan, object_key: "other" },
        result: "ABSENT",
      })
    ).code,
    "STALE",
  );
  assert.equal((await settle(x, "invented")).code, "INVALID_INPUT");
});
test("ambiguous delete retries same target with finite backoff, never claims success", async () => {
  let x = await begun();
  assert.equal((await settle(x, "AMBIGUOUS")).code, "RETRY");
  assert.equal((await claim()).jobs.length, 0);
  await db.exec(
    "UPDATE public.outbox_jobs SET deletion_due=now(),deletion_attempt=4",
  );
  x = await begun();
  assert.equal((await settle(x, "AMBIGUOUS")).code, "HELD");
  assert.equal((await row()).completed_at, null);
});
for (const result of ["LOCKED", "IDENTITY_MISMATCH"])
  test(`provider ${result} holds`, async () => {
    const x = await begun();
    assert.equal((await settle(x, result)).code, "HELD");
    assert.equal((await row()).completed_at, null);
    assert.equal((await claim()).jobs.length, 0);
  });
test("expired intent crash is reconciled, bounded at five attempts", async () => {
  await begun();
  await db.exec(
    "UPDATE public.outbox_jobs SET deletion_locked_until=now()-interval '1 second',deletion_attempt=5",
  );
  const c = await claim();
  assert.equal(c.held, 1);
  assert.equal(c.jobs.length, 0);
  assert.equal((await row()).deletion_result, "EXHAUSTED");
});
test("other event/job cannot yield target", async () => {
  assert.equal(
    (await call("claim", { limit: 5 }, null, "service_role", randomUUID()))
      .code,
    "NOT_FOUND",
  );
  const x = await prepared();
  assert.equal(
    (await call("prepare", { lease_id: x.c.lease_id }, randomUUID())).code,
    "STALE",
  );
});

const derived = "77777777-7777-4777-8777-777777777777",
  streamAsset = "88888888-8888-4888-8888-888888888888";
async function derivativeFixture() {
  await db.query(
    "INSERT INTO public.media_assets(event_id,id,post_id,purpose,provider,object_key,byte_size,sha256,deletion_requested_at) VALUES($1,$2,$3,'delivery_600_webp','r2_delivery',$4,90,$5,now())",
    [
      event,
      derived,
      post,
      `events/${event}/delivery/${derived}/600.webp`,
      "b".repeat(64),
    ],
  );
  await db.query(
    "INSERT INTO public.outbox_jobs(event_id,id,post_id,kind,deduplication_key,payload,completed_at,image_attempt,image_completed_at,image_receipt,image_plan) VALUES($1,$2::uuid,$3,'process_media',$2::text,'{}',now(),1,now(),'{}',$4)",
    [
      event,
      producer,
      post,
      JSON.stringify({
        deliveries: [
          { eventId: event, assetId: derived, variant: "600", format: "webp" },
        ],
      }),
    ],
  );
  await db.query("UPDATE public.outbox_jobs SET payload=$1 WHERE id=$2", [
    JSON.stringify({ asset_id: derived, post_version: 3 }),
    job,
  ]);
}
test("completed first image generation is eligible with immutable receipt", async () => {
  await derivativeFixture();
  const x = await begun();
  assert.equal(x.r.plan.provider, "r2_delivery");
  assert.equal(x.r.plan.sha256, "b".repeat(64));
  assert.equal((await settle(x, "ABSENT")).code, "DONE");
});
for (const change of [
  "image_attempt=2",
  "image_completed_at=NULL,image_receipt=NULL",
  "completed_at=NULL",
])
  test(`derivative uncertain producer holds ${change}`, async () => {
    await derivativeFixture();
    await db.exec(
      `UPDATE public.outbox_jobs SET ${change} WHERE kind='process_media'`,
    );
    assert.equal((await prepared()).r.code, "HELD");
    assert.equal((await row()).deletion_result, "WRITE_OUTCOME_UNKNOWN");
  });
test("other image writing generation cannot be ignored even if completed", async () => {
  await derivativeFixture();
  await db.query(
    "INSERT INTO public.outbox_jobs(event_id,post_id,kind,deduplication_key,payload,completed_at,image_attempt) VALUES($1,$2,'process_media','another','{}',now(),1)",
    [event, post],
  );
  assert.equal((await prepared()).r.code, "HELD");
});
async function streamFixture() {
  await db.query(
    "INSERT INTO public.media_assets(event_id,id,post_id,purpose,provider,stream_uid,deletion_requested_at) VALUES($1,$2,$3,'stream_source','stream',$4,now())",
    [event, streamAsset, post, "c".repeat(32)],
  );
  await db.query(
    "INSERT INTO public.outbox_jobs(event_id,id,post_id,kind,deduplication_key,payload,completed_at,stream_state) VALUES($1,$2::uuid,$3,'process_media',$2::text,$4,now(),$5)",
    [
      event,
      producer,
      post,
      JSON.stringify({
        asset_id: asset,
        object_etag: "a".repeat(32),
        object_version: "v1",
        post_version: 2,
      }),
      JSON.stringify({
        source: {
          uid: "c".repeat(32),
          sourceUid: null,
          operationId: "99999999-9999-4999-8999-999999999999",
          providerJobId: producer,
          providerPostVersion: 2,
        },
      }),
    ],
  );
  await db.query("UPDATE public.outbox_jobs SET payload=$1 WHERE id=$2", [
    JSON.stringify({ asset_id: streamAsset, post_version: 3 }),
    job,
  ]);
}
test("Stream requires original provider generation and parent proof", async () => {
  await streamFixture();
  const x = await begun();
  assert.equal(x.r.plan.provider, "stream");
  assert.equal(x.r.plan.stream.job_id, producer);
  assert.equal(x.r.plan.stream.post_version, 2);
  assert.equal((await settle(x, "ABSENT")).code, "DONE");
});
for (const path of ["uid", "sourceUid", "providerJobId", "providerPostVersion"])
  test(`Stream forged ${path} held`, async () => {
    await streamFixture();
    await db.query(
      "UPDATE public.outbox_jobs SET stream_state=jsonb_set(stream_state,$1,$2) WHERE id=$3",
      [
        ["source", path],
        JSON.stringify(path === "providerPostVersion" ? 9 : "b".repeat(32)),
        producer,
      ],
    );
    assert.equal((await prepared()).r.code, "HELD");
    assert.equal((await row()).deletion_result, "WRITE_OUTCOME_UNKNOWN");
  });
test("Stream foreign original generation is held", async () => {
  await streamFixture();
  await db.query(
    "UPDATE public.outbox_jobs SET payload=jsonb_set(payload,'{object_version}','\"other\"') WHERE id=$1",
    [producer],
  );
  assert.equal((await prepared()).r.code, "HELD");
});
test("policy update after intent is not silently adopted", async () => {
  const x = await begun();
  await db.exec(
    "UPDATE public.event_settings SET physical_deletion_policy=jsonb_set(physical_deletion_policy,'{version}','\"v2\"')",
  );
  assert.equal((await settle(x, "ABSENT")).code, "HELD");
  assert.equal((await row()).deletion_result, "IDENTITY_MISMATCH");
});

async function orphan(action, input, eventId = event) {
  return (
    await db.query("SELECT public.reconcile_cleanup_orphans($1,$2,$3) r", [
      eventId,
      action,
      JSON.stringify(input),
    ])
  ).rows[0].r;
}
async function orphanFixture() {
  await streamFixture();
  await db.query(
    "UPDATE public.outbox_jobs SET stream_state=jsonb_set(stream_state,'{source,uid}','null') WHERE id=$1",
    [producer],
  );
}
test("terminal held Stream create with unknown UID fences every known asset", async () => {
  await orphanFixture();
  assert.equal((await prepared()).r.code, "HELD");
  assert.equal((await row()).deletion_result, "WRITE_OUTCOME_UNKNOWN");
});
test("terminal image failure without completion is not writer quiescence", async () => {
  await db.query(
    "INSERT INTO public.outbox_jobs(event_id,id,post_id,kind,deduplication_key,payload,completed_at,image_plan) VALUES($1,$2::uuid,$3,'process_media',$2::text,'{}',now(),'{}')",
    [event, producer, post],
  );
  assert.equal((await prepared()).r.code, "HELD");
});
test("orphan observations fixed-search-path and service-only table/RPC", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`SET ROLE ${role}`);
    try {
      await assert.rejects(orphan("claim", {}), /permission denied/);
      await assert.rejects(
        db.query("SELECT * FROM koko_private.cleanup_orphan_observations"),
        /permission denied/,
      );
    } finally {
      await db.exec("RESET ROLE");
    }
  }
});
test("unknown Stream reservation produces only immutable read-only plan, not delete plan", async () => {
  await orphanFixture();
  const c = await orphan("claim", {});
  assert.equal(c.code, "CLAIMED");
  assert.equal(c.claims.length, 1);
  assert.deepEqual(Object.keys(c.claims[0].plan).sort(), [
    "event_id",
    "job_id",
    "operation_id",
    "original_asset_id",
    "post_id",
    "post_version",
    "source_uid",
  ]);
  assert.equal((await orphan("claim", {})).claims.length, 0);
  assert.equal((await prepared()).r.code, "HELD");
});
test("matching orphan is REVIEW HELD, not media asset/physical-success or retry-unlock", async () => {
  await orphanFixture();
  const c = (await orphan("claim", {})).claims[0];
  assert.equal(
    (
      await orphan("record", {
        ...c,
        result: "MATCHED_CANDIDATE",
        candidate_uid: "d".repeat(32),
      })
    ).code,
    "RECORDED",
  );
  const o = (
    await db.query("SELECT * FROM koko_private.cleanup_orphan_observations")
  ).rows[0];
  assert.equal(o.state, "held");
  assert.equal(o.result, "MATCHED_CANDIDATE");
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM public.media_assets WHERE physically_deleted_at IS NOT NULL",
      )
    ).rows[0].n,
    0,
  );
  assert.equal((await prepared()).r.code, "HELD");
});
test("zero candidate does not mean absent and is retried at most five times", async () => {
  await orphanFixture();
  for (let i = 1; i <= 5; i++) {
    const c = (await orphan("claim", {})).claims[0];
    assert.ok(c);
    assert.equal(
      (
        await orphan("record", {
          ...c,
          result: "NOT_FOUND",
          candidate_uid: null,
        })
      ).code,
      "RECORDED",
    );
    assert.equal((await orphan("claim", {})).claims.length, 0);
    await db.exec(
      "UPDATE koko_private.cleanup_orphan_observations SET due_at=now()",
    );
  }
  const o = (
    await db.query("SELECT * FROM koko_private.cleanup_orphan_observations")
  ).rows[0];
  assert.equal(o.attempt, 5);
  assert.equal(o.state, "held");
  assert.equal((await orphan("claim", {})).claims.length, 0);
});
test("orphan record rejects wrong lease, altered plan, raw errors and invalid UIDs", async () => {
  await orphanFixture();
  const c = (await orphan("claim", {})).claims[0];
  for (const bad of [
    { ...c, result: "MATCHED_CANDIDATE", candidate_uid: "bad" },
    { ...c, result: "UNKNOWN", candidate_uid: "a".repeat(32) },
    { ...c, result: "UNKNOWN", candidate_uid: null, raw: "secret" },
  ])
    assert.equal((await orphan("record", bad)).code, "INVALID_INPUT");
  assert.equal(
    (
      await orphan("record", {
        ...c,
        lease_id: randomUUID(),
        result: "UNKNOWN",
        candidate_uid: null,
      })
    ).code,
    "STALE",
  );
  assert.equal(
    (
      await orphan("record", {
        ...c,
        plan: { ...c.plan, post_id: randomUUID() },
        result: "UNKNOWN",
        candidate_uid: null,
      })
    ).code,
    "STALE",
  );
});
test("orphan feature disabled or live post never queries provider", async () => {
  await orphanFixture();
  await db.exec("UPDATE public.posts SET status='held',deleted_at=NULL");
  assert.equal((await orphan("claim", {})).claims.length, 0);
  await db.exec(
    "UPDATE public.event_settings SET physical_deletion_enabled=false",
  );
  assert.equal((await orphan("claim", {})).code, "DISABLED");
});
