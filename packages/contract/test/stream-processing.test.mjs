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
  job = "55555555-5555-4555-8555-555555555555";
const uid = "a".repeat(32),
  clipUid = "b".repeat(32),
  etag = "c".repeat(32);
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
    VALUES($1,'synthetic','Synthetic','live',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days',now()+interval '3 days','test')`,
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
    VALUES($1,$2,$3,'video','uploaded',$2,'video/mp4','client_trimmed',100,2)`,
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
    `INSERT INTO public.outbox_jobs(event_id,id,post_id,kind,deduplication_key,payload) VALUES($1,$2,$3,'process_media','synthetic',$4)`,
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
after(async () => db.close());
async function call(
  action = "claim",
  input = {},
  { scope = event, postId = post, jobId = job, role = "service_role" } = {},
) {
  assert.ok(["service_role", "anon", "authenticated"].includes(role));
  await db.exec(`SET ROLE ${role}`);
  try {
    return (
      await db.query(
        "SELECT public.manage_stream_processing($1,$2,$3,$4,$5) result",
        [scope, postId, jobId, action, JSON.stringify(input)],
      )
    ).rows[0].result;
  } finally {
    await db.exec("RESET ROLE");
  }
}
async function row(table, id = post) {
  return (await db.query(`SELECT * FROM public.${table} WHERE id=$1`, [id]))
    .rows[0];
}
async function claim() {
  const value = await call();
  assert.equal(value.code, "CLAIMED");
  return value.plan;
}
async function reserve(plan, operation = "source") {
  const result = await call("reserve", { plan, operation });
  assert.equal(result.code, "RESERVED");
  return result.operation;
}
function reference(operation) {
  return {
    operationId: operation.operationId,
    uid: operation.uid ?? null,
    sourceUid: operation.sourceUid,
  };
}
function observation(operation, changes = {}) {
  return {
    reference: {
      ...reference(operation),
      uid: operation.sourceUid ? clipUid : uid,
    },
    state: "ready",
    requireSignedURLs: true,
    readyToStream: true,
    processingComplete: true,
    measuredDurationSeconds: 3.8,
    width: 1280,
    height: 720,
    modifiedAt: new Date(Date.now() - 1000).toISOString(),
    ...changes,
  };
}
async function observe(plan, op, changes = {}, operation = "source") {
  return call("observe", {
    plan,
    operation,
    observation: observation(op, changes),
  });
}
async function ready(fallback = false) {
  if (fallback)
    await db.exec(
      "UPDATE public.posts SET original_scope='full_video_fallback'",
    );
  const plan = await claim(),
    source = await reserve(plan);
  assert.equal(
    (
      await observe(plan, source, {
        measuredDurationSeconds: fallback ? 30 : 3.8,
      })
    ).code,
    "OBSERVED",
  );
  let clip;
  if (fallback) {
    clip = await reserve(plan, "clip");
    assert.equal((await observe(plan, clip, {}, "clip")).code, "OBSERVED");
  }
  return { plan, source, clip };
}
test("RPC service only, fixed search_path, invoker; all migrations applied", async () => {
  for (const role of ["anon", "authenticated"])
    await assert.rejects(call("claim", {}, { role }), /permission denied/);
  const r = (
    await db.query(
      "SELECT prosecdef,proconfig FROM pg_proc WHERE proname='manage_stream_processing'",
    )
  ).rows[0];
  assert.equal(r.prosecdef, false);
  assert.ok(r.proconfig.some((x) => x.startsWith("search_path=")));
});
test("READ COMMITTED is required", async () => {
  await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    await assert.rejects(
      db.query(
        "SELECT public.manage_stream_processing($1,$2,$3,'claim','{}')",
        [event, post, job],
      ),
      /READ COMMITTED/,
    );
  } finally {
    await db.exec("ROLLBACK");
  }
});
test("claim versions uploaded exactly once and binds original/job/lease; active repeat is BUSY", async () => {
  const plan = await claim();
  assert.deepEqual(plan.original, {
    size: 100,
    etag,
    objectVersion: "object-v1",
  });
  assert.equal(plan.scope.postVersion, 3);
  assert.equal(plan.scope.assetId, asset);
  assert.equal(plan.scope.jobId, job);
  assert.equal(plan.scope.eventId, event);
  assert.equal(plan.scope.postId, post);
  assert.equal(plan.originalScope, "client_trimmed");
  assert.ok(plan.scope.expiresAt > Date.now());
  assert.ok(plan.scope.expiresAt <= Date.now() + 120000);
  assert.equal((await row("posts")).status, "processing");
  assert.equal((await row("outbox_jobs", job)).payload.post_version, 3);
  assert.equal((await row("outbox_jobs", job)).stream_initial_post_version, 2);
  assert.equal((await call()).code, "BUSY");
  assert.equal((await row("posts")).version, 3);
});
test("claim expired lease keeps durable reservation and bounded deadline, rejects old plan", async () => {
  const old = await claim(),
    operation = await reserve(old),
    before = await row("outbox_jobs", job);
  await db.exec(
    "UPDATE public.outbox_jobs SET stream_plan=jsonb_set(stream_plan,'{scope,expiresAt}','1')",
  );
  const result = await call();
  assert.equal(result.code, "CLAIMED");
  assert.notEqual(result.plan.scope.leaseId, old.scope.leaseId);
  assert.equal(result.plan.scope.postVersion, 3);
  assert.equal((await row("outbox_jobs", job)).stream_initial_post_version, 2);
  assert.deepEqual(result.state.source, operation);
  assert.equal(
    new Date((await row("outbox_jobs", job)).stream_deadline).getTime(),
    new Date(before.stream_deadline).getTime(),
  );
  assert.equal(
    (await call("reserve", { plan: old, operation: "source" })).code,
    "STALE",
  );
});
for (const action of [
  "claim",
  "check",
  "reserve",
  "observe",
  "poll",
  "finish",
  "hold",
])
  test(`${action} rejects unexpected or missing input`, async () => {
    assert.equal(
      (await call(action, { unwanted: "private" })).code,
      "INVALID_INPUT",
    );
    assert.equal((await call(action, null)).code, "INVALID_INPUT");
  });
test("cross event/post/job and unsupported action fail closed", async () => {
  for (const key of ["scope", "postId", "jobId"])
    assert.equal(
      (await call("claim", {}, { [key]: randomUUID() })).code,
      "STALE",
    );
  assert.equal((await call("delete")).code, "INVALID_INPUT");
});
for (const [name, change] of [
  ["BAN", "UPDATE public.event_members SET is_banned=true,banned_at=now()"],
  ["consent", "DELETE FROM public.consents"],
  ["terms", "UPDATE public.events SET terms_version='new'"],
  ["kill", "UPDATE public.event_settings SET publication_stopped=true"],
  ["uploads", "UPDATE public.event_settings SET uploads_enabled=false"],
  ["event", "UPDATE public.events SET status='private'"],
  [
    "before start",
    "UPDATE public.events SET starts_at=now()+interval '1 hour'",
  ],
  [
    "private expiry",
    "UPDATE public.events SET ends_at=now()-interval '2 hours',archive_at=now()-interval '1 hour',private_at=now()-interval '1 second'",
  ],
  ["latch", "UPDATE public.posts SET ban_latched=true"],
  ["deleted", "UPDATE public.posts SET status='deleted',deleted_at=now()"],
  ["held", "UPDATE public.posts SET status='held'"],
  [
    "original pending deletion",
    "UPDATE public.media_assets SET deletion_requested_at=now()",
  ],
  [
    "original gone",
    "UPDATE public.media_assets SET physically_deleted_at=now()",
  ],
  ["original size", "UPDATE public.media_assets SET byte_size=101"],
  [
    "object version",
    "UPDATE public.media_assets SET object_version='different'",
  ],
  ["object etag", "UPDATE public.media_assets SET object_etag=repeat('d',32)"],
  [
    "wrong payload",
    "UPDATE public.outbox_jobs SET payload=payload||'{\"post_version\":1}'",
  ],
  ["completed", "UPDATE public.outbox_jobs SET completed_at=now()"],
])
  test(`current ${name} guard checked at claim and every operation`, async () => {
    const plan = await claim();
    await db.exec(change);
    assert.equal(
      (await call("reserve", { plan, operation: "source" })).code,
      "STALE",
    );
    assert.equal((await call()).code, "STALE");
  });
test("reservation is durable/idempotent; checks enforce copy/inspect/reconcile UID shape", async () => {
  const plan = await claim(),
    op = await reserve(plan);
  const repeated = await call("reserve", { plan, operation: "source" });
  assert.equal(repeated.code, "EXISTING");
  assert.deepEqual(repeated.operation, op);
  for (const action of ["copy", "reconcile"])
    assert.equal(
      (await call("check", { plan, action: { action, ...reference(op) } }))
        .code,
      "CURRENT",
    );
  assert.equal(
    (
      await call("check", {
        plan,
        action: { action: "inspect", ...reference(op) },
      })
    ).code,
    "STALE",
  );
  assert.equal(
    (
      await call("check", {
        plan,
        action: { action: "copy", ...reference(op), uid },
      })
    ).code,
    "STALE",
  );
  assert.equal(
    (
      await call("check", {
        plan,
        action: { action: "copy", ...reference(op), sourceUid: uid },
      })
    ).code,
    "STALE",
  );
  assert.equal((await observe(plan, op)).code, "OBSERVED");
  for (const action of ["inspect", "frames"])
    assert.equal(
      (await call("check", { plan, action: { action, ...reference(op), uid } }))
        .code,
      "CURRENT",
    );
  for (const action of ["copy", "reconcile"])
    assert.equal(
      (await call("check", { plan, action: { action, ...reference(op) } }))
        .code,
      "STALE",
    );
});
test("clip is reserved only from complete private fallback source; independently tracked", async () => {
  await db.exec("UPDATE public.posts SET original_scope='full_video_fallback'");
  const plan = await claim(),
    source = await reserve(plan);
  assert.equal(
    (await call("reserve", { plan, operation: "clip" })).code,
    "STALE",
  );
  assert.equal(
    (
      await observe(plan, source, {
        state: "pending",
        processingComplete: false,
        measuredDurationSeconds: 20,
      })
    ).code,
    "OBSERVED",
  );
  assert.equal(
    (await call("reserve", { plan, operation: "clip" })).code,
    "STALE",
  );
  assert.equal(
    (
      await observe(plan, source, {
        modifiedAt: new Date().toISOString(),
        measuredDurationSeconds: 20,
      })
    ).code,
    "OBSERVED",
  );
  const clip = await reserve(plan, "clip");
  assert.equal(clip.sourceUid, uid);
  assert.notEqual(clip.operationId, source.operationId);
  assert.equal(
    (
      await call("check", {
        plan,
        action: { action: "clip", ...reference(clip), uid },
      })
    ).code,
    "CURRENT",
  );
  assert.equal(
    (
      await call("check", {
        plan,
        action: { action: "clip", ...reference(clip), uid: clipUid },
      })
    ).code,
    "STALE",
  );
  assert.equal(
    (
      await call("check", {
        plan,
        action: { action: "reconcile", ...reference(clip) },
      })
    ).code,
    "CURRENT",
  );
});
test("non-fallback source never gets an unnecessary clip reservation", async () => {
  const { plan } = await ready();
  assert.equal(
    (await call("reserve", { plan, operation: "clip" })).code,
    "STALE",
  );
});
for (const [field, value] of [
  ["state", null],
  ["state", "future"],
  ["requireSignedURLs", false],
  ["requireSignedURLs", "true"],
  ["readyToStream", "true"],
  ["processingComplete", 1],
  ["width", "1280"],
  ["width", 0],
  ["height", 1.5],
  ["height", 16385],
  ["measuredDurationSeconds", "3.8"],
  ["measuredDurationSeconds", 0],
  ["measuredDurationSeconds", 36001],
  ["modifiedAt", "infinity"],
  ["modifiedAt", "now"],
  ["modifiedAt", "2099-01-01T00:00:00Z"],
])
  test(`observe validates ${field}=${JSON.stringify(value)}`, async () => {
    const plan = await claim(),
      op = await reserve(plan);
    assert.equal(
      (await observe(plan, op, { [field]: value })).code,
      "INVALID_INPUT",
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM public.media_assets WHERE provider='stream'",
        )
      ).rows[0].n,
      0,
    );
  });
test("observe demands full exact reference and all ready evidence", async () => {
  const plan = await claim(),
    op = await reserve(plan);
  for (const changes of [
    { reference: { ...reference(op), uid, operationId: randomUUID() } },
    { reference: { ...reference(op), uid, sourceUid: clipUid } },
    { state: "pending" },
    { readyToStream: false },
    { measuredDurationSeconds: null },
    { width: null },
    { privateSecret: "do-not-store" },
  ]) {
    assert.equal((await observe(plan, op, changes)).code, "INVALID_INPUT");
  }
});
test("observe same UID only; older or same-time conflicting callback does not regress evidence", async () => {
  const plan = await claim(),
    op = await reserve(plan),
    t = new Date(Date.now() - 500).toISOString();
  const value = observation(op, { modifiedAt: t });
  assert.equal(
    (await call("observe", { plan, operation: "source", observation: value }))
      .code,
    "OBSERVED",
  );
  assert.equal(
    (await call("observe", { plan, operation: "source", observation: value }))
      .code,
    "OBSERVED",
  );
  assert.equal(
    (
      await observe(plan, op, {
        modifiedAt: new Date(Date.now() - 10000).toISOString(),
        state: "pending",
        processingComplete: false,
      })
    ).code,
    "OUTDATED",
  );
  assert.equal(
    (
      await observe(plan, op, {
        modifiedAt: t,
        state: "pending",
        processingComplete: false,
      })
    ).code,
    "OUTDATED",
  );
  assert.equal(
    (await observe(plan, op, { reference: { ...reference(op), uid: clipUid } }))
      .code,
    "INVALID_INPUT",
  );
  const saved = (
    await db.query("SELECT * FROM public.media_assets WHERE provider='stream'")
  ).rows[0];
  assert.equal(saved.stream_processing_complete, true);
  assert.equal(saved.stream_uid, uid);
});
test("clip cannot alias source UID; existing UID on another post returns STALE without mutation", async () => {
  const { plan, clip } = await ready(true);
  assert.equal(
    (
      await observe(
        plan,
        clip,
        { reference: { ...reference(clip), uid } },
        "clip",
      )
    ).code,
    "INVALID_INPUT",
  );
  const other = randomUUID();
  await db.query(
    `INSERT INTO public.posts(event_id,id,user_id,kind,status,client_request_id,declared_content_type,original_scope)
    VALUES($1,$2,$3,'video','processing',$2,'video/mp4','client_trimmed')`,
    [event, other, owner],
  );
  await db.query(
    "UPDATE public.media_assets SET post_id=$1 WHERE purpose='stream_source'",
    [other],
  );
  assert.equal(
    (
      await observe(
        plan,
        {
          operationId: (await row("outbox_jobs", job)).stream_state.source
            .operationId,
          sourceUid: null,
        },
        { modifiedAt: new Date().toISOString() },
      )
    ).code,
    "STALE",
  );
});
test("finish client-trimmed produces private preparation and three frame times, never publication", async () => {
  const { plan } = await ready();
  assert.equal((await call("finish", { plan })).code, "PREPARED");
  const p = await row("posts"),
    j = await row("outbox_jobs", job);
  assert.equal(p.status, "processing");
  assert.equal(p.moderation_verdict, null);
  assert.equal(Number(p.measured_duration_seconds), 3.8);
  assert.equal(j.completed_at, null);
  assert.equal(j.stream_plan, null);
  assert.ok(j.stream_prepared_at);
  assert.deepEqual(j.moderation_media.frameTimes, [0.38, 1.9, 3.42]);
  assert.equal(j.moderation_media.postVersion, 3);
  assert.equal(j.moderation_media.processingComplete, true);
  assert.equal(j.moderation_media.kind, "video");
  assert.equal(JSON.stringify(j.moderation_media).includes(uid), false);
  assert.equal((await call()).code, "PREPARED");
});
test("finish fallback selects clip not full source", async () => {
  const { plan } = await ready(true);
  assert.equal((await call("finish", { plan })).code, "PREPARED");
  const j = await row("outbox_jobs", job),
    selected = (
      await db.query(
        "SELECT id FROM public.media_assets WHERE purpose='stream_clip'",
      )
    ).rows[0].id;
  assert.equal(j.moderation_media.streamAssetId, selected);
});
for (const [label, change] of [
  ["duration", "stream_duration_seconds=4.001"],
  ["partial", "stream_processing_complete=false"],
  ["unready", "stream_ready_to_stream=false"],
  ["public", "stream_require_signed_urls=false"],
  ["delete", "deletion_requested_at=now()"],
  ["deleted", "physically_deleted_at=now()"],
])
  test(`finish refuses ${label} evidence`, async () => {
    const { plan } = await ready();
    await db.exec(
      `UPDATE public.media_assets SET ${change} WHERE purpose='stream_source'`,
    );
    assert.equal((await call("finish", { plan })).code, "NOT_READY");
    assert.equal((await row("outbox_jobs", job)).stream_prepared_at, null);
  });
test("finish requires current job's reservation/ready UID evidence", async () => {
  const { plan } = await ready();
  await db.exec("UPDATE public.outbox_jobs SET stream_state='{}'");
  assert.equal((await call("finish", { plan })).code, "STALE");
});
test("finish fallback rejects missing/aliased/deleting source", async () => {
  const { plan } = await ready(true);
  await db.exec(
    "UPDATE public.media_assets SET deletion_requested_at=now() WHERE purpose='stream_source'",
  );
  assert.equal((await call("finish", { plan })).code, "STALE");
});
test("poll releases lease, persists reservation, increments once and exhausts after 60", async () => {
  const plan = await claim(),
    op = await reserve(plan);
  assert.equal((await call("poll", { plan })).code, "WAIT");
  assert.equal((await call("poll", { plan })).code, "STALE");
  const resumed = await claim();
  assert.equal((await row("outbox_jobs", job)).stream_poll_count, 1);
  assert.deepEqual((await row("outbox_jobs", job)).stream_state.source, op);
  await db.exec("UPDATE public.outbox_jobs SET stream_poll_count=60");
  assert.equal(
    (await call("reserve", { plan: resumed, operation: "source" })).code,
    "EXHAUSTED",
  );
  assert.equal(
    (await call("hold", { plan: resumed, errorCode: "STREAM_TIMEOUT" })).code,
    "HELD",
  );
});
test("deadline exhaustion remains holdable and never extends on reclaim", async () => {
  const plan = await claim();
  await db.exec(
    "UPDATE public.outbox_jobs SET stream_deadline=now()-interval '1 second'",
  );
  assert.equal((await call("poll", { plan })).code, "EXHAUSTED");
  assert.equal(
    (await call("hold", { plan, errorCode: "STREAM_TIMEOUT" })).code,
    "HELD",
  );
});
test("hold fixed error is atomic with minimal notification and job completion", async () => {
  const plan = await claim();
  assert.equal(
    (await call("hold", { plan, errorCode: "raw-provider-secret" })).code,
    "INVALID_INPUT",
  );
  assert.equal(
    (await call("hold", { plan, errorCode: "VIDEO_TOO_LONG" })).code,
    "HELD",
  );
  const p = await row("posts"),
    j = await row("outbox_jobs", job);
  assert.equal(p.status, "held");
  assert.equal(p.processing_error, "VIDEO_TOO_LONG");
  assert.equal(p.version, 4);
  assert.ok(j.completed_at);
  const notices = (
    await db.query("SELECT payload FROM public.outbox_jobs WHERE kind='notify'")
  ).rows;
  assert.deepEqual(notices, [
    { payload: { category: "stream_failure", post_version: 4 } },
  ]);
  assert.equal(
    (await call("hold", { plan, errorCode: "VIDEO_TOO_LONG" })).code,
    "STALE",
  );
});
test("notification failure rolls back held transition and completion", async () => {
  const plan = await claim();
  await db.exec(`CREATE FUNCTION public.synthetic_stream_notice_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='notify' THEN RAISE EXCEPTION 'synthetic notification failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER synthetic_stream_notice_failure BEFORE INSERT ON public.outbox_jobs FOR EACH ROW EXECUTE FUNCTION public.synthetic_stream_notice_failure();`);
  try {
    await assert.rejects(
      call("hold", { plan, errorCode: "STREAM_PROCESSING_FAILED" }),
      /synthetic notification failure/,
    );
  } finally {
    await db.exec(
      "DROP TRIGGER synthetic_stream_notice_failure ON public.outbox_jobs; DROP FUNCTION public.synthetic_stream_notice_failure()",
    );
  }
  assert.equal((await row("posts")).status, "processing");
  assert.equal((await row("outbox_jobs", job)).completed_at, null);
});
async function retryJob(completeOld = true) {
  const id = randomUUID();
  await db.exec(
    `UPDATE public.posts SET status='processing',version=version+2; ${completeOld ? "UPDATE public.outbox_jobs SET completed_at=now();" : ""}`,
  );
  const version = (await row("posts")).version;
  await db.query(
    `INSERT INTO public.outbox_jobs(event_id,id,post_id,kind,deduplication_key,payload) VALUES($1,$2,$3,'process_media',$2::uuid::text,$4)`,
    [
      event,
      id,
      post,
      JSON.stringify({
        asset_id: asset,
        post_version: version,
        object_etag: etag,
        object_version: "object-v1",
      }),
    ],
  );
  return id;
}
test("manual retry carries source provider generation but authorization stays current job/version", async () => {
  const prior = await ready(),
    next = await retryJob(),
    claimed = await call("claim", {}, { jobId: next });
  assert.equal(claimed.code, "CLAIMED");
  assert.equal(claimed.plan.scope.jobId, next);
  assert.equal(claimed.plan.scope.postVersion, 5);
  assert.equal(claimed.state.source.providerJobId, job);
  assert.equal(claimed.state.source.providerPostVersion, 3);
  assert.equal(claimed.state.source.uid, uid);
  assert.equal(
    (
      await call(
        "observe",
        {
          plan: claimed.plan,
          operation: "source",
          observation: observation(prior.source, {
            modifiedAt: new Date().toISOString(),
          }),
        },
        { jobId: next },
      )
    ).code,
    "OBSERVED",
  );
  assert.equal(
    (await call("finish", { plan: claimed.plan }, { jobId: next })).code,
    "PREPARED",
  );
  assert.equal(
    (await row("outbox_jobs", next)).moderation_media.postVersion,
    5,
  );
});
test("ambiguous prior creation retains operation for reconciliation, never another copy", async () => {
  const plan = await claim(),
    op = await reserve(plan),
    next = await retryJob(),
    claimed = await call("claim", {}, { jobId: next });
  assert.equal(claimed.state.source.operationId, op.operationId);
  assert.equal(claimed.state.source.uid, null);
  assert.equal(
    (
      await call(
        "reserve",
        { plan: claimed.plan, operation: "source" },
        { jobId: next },
      )
    ).code,
    "EXISTING",
  );
  assert.equal(
    (
      await call(
        "check",
        { plan: claimed.plan, action: { action: "copy", ...reference(op) } },
        { jobId: next },
      )
    ).code,
    "STALE",
  );
  assert.equal(
    (
      await call(
        "check",
        {
          plan: claimed.plan,
          action: { action: "reconcile", ...reference(op) },
        },
        { jobId: next },
      )
    ).code,
    "CURRENT",
  );
});
for (const [label, mutation, complete] of [
  [
    "different original version",
    'UPDATE public.outbox_jobs SET payload=payload||\'{"object_version":"other"}\'',
    true,
  ],
  [
    "different original asset",
    `UPDATE public.outbox_jobs SET payload=payload||jsonb_build_object('asset_id',gen_random_uuid())`,
    true,
  ],
  [
    "different UID",
    `UPDATE public.outbox_jobs SET stream_state=jsonb_set(stream_state,'{source,uid}',to_jsonb(repeat('e',32)))`,
    true,
  ],
  [
    "forged provider version",
    `UPDATE public.outbox_jobs SET stream_state=jsonb_set(stream_state,'{source,providerPostVersion}','2')`,
    true,
  ],
  [
    "forged provider job",
    `UPDATE public.outbox_jobs SET stream_state=jsonb_set(stream_state,'{source,providerJobId}',to_jsonb(gen_random_uuid()))`,
    true,
  ],
  ["incomplete prior job", "", false],
])
  test(`retry does not inherit ${label}`, async () => {
    await ready();
    if (mutation) await db.exec(mutation);
    const next = await retryJob(complete),
      claimed = await call("claim", {}, { jobId: next });
    assert.equal(claimed.code, "CLAIMED");
    assert.deepEqual(claimed.state, {});
    assert.equal(
      (
        await call(
          "reserve",
          { plan: claimed.plan, operation: "source" },
          { jobId: next },
        )
      ).code,
      "STALE",
    );
    assert.equal(
      (await call("finish", { plan: claimed.plan }, { jobId: next })).code,
      "STALE",
    );
  });
test("recovered fallback preserves source/clip parent relationship and both provider generations", async () => {
  await ready(true);
  const next = await retryJob(),
    claimed = await call("claim", {}, { jobId: next });
  assert.equal(claimed.state.clip.sourceUid, claimed.state.source.uid);
  assert.equal(claimed.state.clip.providerJobId, job);
  assert.equal(
    (await call("finish", { plan: claimed.plan }, { jobId: next })).code,
    "PREPARED",
  );
});
test("repeated retry keeps the original provider generation and rejects clip parent substitution", async () => {
  await ready(true);
  const first = await retryJob();
  const c1 = await call("claim", {}, { jobId: first });
  assert.equal(c1.state.source.providerJobId, job);
  await db.query(
    "UPDATE public.outbox_jobs SET completed_at=now() WHERE id=$1",
    [first],
  );
  const second = await retryJob();
  const c2 = await call("claim", {}, { jobId: second });
  assert.equal(c2.state.source.providerJobId, job);
  assert.equal(c2.state.clip.providerPostVersion, 3);
  await db.exec(
    `UPDATE public.outbox_jobs SET stream_state=jsonb_set(stream_state,'{clip,sourceUid}',to_jsonb(repeat('e',32))) WHERE completed_at IS NOT NULL`,
  );
  await db.query(
    "UPDATE public.outbox_jobs SET stream_state='{}',completed_at=now() WHERE id=$1",
    [second],
  );
  const third = await retryJob(),
    c3 = await call("claim", {}, { jobId: third });
  assert.deepEqual(c3.state, {});
});
