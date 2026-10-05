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
  reporter = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  admin = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  moderator = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const action = { expected_version: 1, reason: "Synthetic review" };
const theme = {
  title: "Fixture",
  description: "Synthetic",
  icon: "camera",
  color: "#4338ca",
  status: "published",
  starts_at: "2020-01-01T00:00:00Z",
  ends_at: "2099-01-01T00:00:00Z",
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
  await db.exec("RESET ROLE; TRUNCATE public.events,auth.users CASCADE");
  for (const id of [owner, reporter, admin, moderator])
    await db.query("INSERT INTO auth.users VALUES($1)", [id]);
  for (const [id, slug] of [
    [event, "one"],
    [otherEvent, "two"],
  ]) {
    await db.query(
      `INSERT INTO public.events(event_id,slug,name,status,starts_at,ends_at,archive_at,private_at,terms_version)
      VALUES($1,$2,'Synthetic','live','2020-01-01','2099-01-01','2099-02-01','2099-03-01','test')`,
      [id, slug],
    );
    for (const [user, role] of [
      [owner, "user"],
      [reporter, "user"],
      [admin, "admin"],
      [moderator, "moderator"],
    ]) {
      await db.query(
        "INSERT INTO public.event_members(event_id,user_id,display_name,role) VALUES($1,$2,'Synthetic',$3)",
        [id, user, role],
      );
      await db.query(
        "INSERT INTO public.consents(event_id,user_id,terms_version) VALUES($1,$2,'test')",
        [id, user],
      );
    }
    await db.query(
      "INSERT INTO public.event_settings(event_id,publication_stopped,uploads_enabled) VALUES($1,false,true)",
      [id],
    );
  }
});
after(async () => db.close());
async function call(
  op,
  target = null,
  input = {},
  { user = admin, scope = event, role = "service_role" } = {},
) {
  assert.ok(["service_role", "anon", "authenticated"].includes(role));
  await db.exec(`SET ROLE ${role}`);
  try {
    return (
      await db.query(
        "SELECT public.stage_three_operation($1,$2,$3,$4,$5,$6) result",
        [scope, user, op, target, JSON.stringify(input), randomUUID()],
      )
    ).rows[0].result;
  } finally {
    await db.exec("RESET ROLE");
  }
}
async function post(status = "published", user = owner, scope = event) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO public.posts(event_id,id,user_id,kind,status,client_request_id,declared_content_type,original_scope,
    moderation_verdict,published_at,previous_public_status,hidden_reason)
    VALUES($1,$2,$3,'photo',$4::public.post_status,$2,'image/jpeg','photo_file',
      CASE WHEN $4 IN ('published','hidden') THEN 'PASS' WHEN $4='published_flagged' THEN 'FLAG' ELSE NULL END,
      now(),CASE WHEN $4='hidden' THEN 'published'::public.post_status ELSE NULL END,CASE WHEN $4='hidden' THEN 'report' ELSE NULL END)`,
    [scope, id, user, status],
  );
  return id;
}
async function assets(id) {
  for (const purpose of [
    "original",
    "delivery_600_webp",
    "delivery_600_jpg",
    "delivery_1600_webp",
    "delivery_1600_jpg",
  ]) {
    const asset = randomUUID(),
      original = purpose === "original";
    await db.query(
      `INSERT INTO public.media_assets(event_id,id,post_id,purpose,provider,object_key,byte_size,sha256,pixel_width,pixel_height,object_etag,object_version)
      VALUES($1,$2,$3,$4,$5,$6,100,$7,600,600,$8,'version')`,
      [
        event,
        asset,
        id,
        purpose,
        original ? "r2_original" : "r2_delivery",
        original
          ? `events/${event}/posts/${id}/original/${asset}.bin`
          : `events/${event}/delivery/${asset}/${purpose.split("_")[1]}.${purpose.split("_")[2]}`,
        "a".repeat(64),
        "b".repeat(32),
      ],
    );
  }
  await db.query("UPDATE public.posts SET original_bytes=100 WHERE id=$1", [
    id,
  ]);
}
async function row(id) {
  return (await db.query("SELECT * FROM public.posts WHERE id=$1", [id]))
    .rows[0];
}
test("operator state details share safe owner projection and deletion is never a completion claim", async () => {
  const id = await post("blocked");
  await db.query(
    "UPDATE public.posts SET block_category='ocr:hate/threatening' WHERE id=$1",
    [id],
  );
  const blocked = await call(
    "admin_feed",
    null,
    { limit: 30 },
    { user: admin },
  );
  assert.equal(
    blocked.items.find((x) => x.post.id === id).post.block_category,
    "hate",
  );
  await assets(id);
  await call("delete", id, action, { user: admin });
  const result = await call(
    "admin_feed",
    null,
    { limit: 30 },
    { user: moderator },
  );
  const item = result.items.find((x) => x.post.id === id).post;
  assert.deepEqual(item.deletion, {
    state: "RETENTION_UNKNOWN",
    retention_until: null,
  });
  assert.equal(item.block_category, undefined);
  assert.equal(JSON.stringify(item).includes("ocr:"), false);
  assert.equal(
    (await call("admin_feed", null, { limit: 30 }, { user: owner })).code,
    "FORBIDDEN",
  );
});
async function count(table, clause = "true", args = []) {
  return Number(
    (
      await db.query(
        `SELECT count(*) n FROM public.${table} WHERE ${clause}`,
        args,
      )
    ).rows[0].n,
  );
}
test("service only invoker RPC has fixed empty search_path", async () => {
  for (const role of ["anon", "authenticated"])
    await assert.rejects(
      call("themes", null, {}, { role }),
      /permission denied/,
    );
  const meta = (
    await db.query(
      "SELECT prosecdef,proconfig FROM pg_proc WHERE oid='public.stage_three_operation(uuid,uuid,text,uuid,jsonb,uuid)'::regprocedure",
    )
  ).rows[0];
  assert.equal(meta.prosecdef, false);
  assert.ok(meta.proconfig.some((v) => /^search_path=(""|)$/.test(v)));
});
test("report first hides atomically, second hidden report escalates, duplicates never count", async () => {
  const id = await post();
  assert.equal(
    (await call("report", id, { reason: "privacy" }, { user: owner })).code,
    "ok",
  );
  assert.equal((await row(id)).status, "hidden");
  assert.equal((await row(id)).previous_public_status, "published");
  assert.equal(
    (await call("report", id, { reason: "privacy" }, { user: owner })).code,
    "ok",
  );
  assert.equal(
    (await call("report", id, { reason: "other" }, { user: reporter })).code,
    "ok",
  );
  assert.equal((await row(id)).report_count, 2);
  assert.equal(await count("reports"), 2);
  assert.equal(await count("outbox_jobs", "kind='revoke_delivery'"), 2);
  assert.equal(await count("outbox_jobs", "kind='notify'"), 2);
  assert.equal(
    (await call("report", id, { reason: "privacy" }, { user: moderator })).code,
    "ok",
  );
  assert.equal((await row(id)).report_count, 3);
  assert.equal(await count("outbox_jobs", "kind='notify'"), 2);
});
test("reports cannot probe other event, absent, blocked, processing or deleted", async () => {
  for (const id of [
    randomUUID(),
    await post("blocked"),
    await post("processing"),
    await post("published", owner, otherEvent),
  ])
    assert.equal(
      (await call("report", id, { reason: "other" }, { user: reporter })).code,
      "NOT_FOUND",
    );
  assert.equal(await count("reports"), 0);
});
test("report remains possible during emergency stop, but consent and member BAN are enforced", async () => {
  const id = await post();
  await db.exec(
    "UPDATE public.event_settings SET publication_stopped=true,uploads_enabled=false",
  );
  assert.equal(
    (await call("report", id, { reason: "other" }, { user: reporter })).code,
    "ok",
  );
  await db.query("DELETE FROM public.consents WHERE user_id=$1", [owner]);
  assert.equal(
    (await call("report", id, { reason: "other" }, { user: owner })).code,
    "CONSENT_REQUIRED",
  );
  await db.query(
    "UPDATE public.event_members SET is_banned=true,banned_at=now() WHERE user_id=$1",
    [moderator],
  );
  assert.equal(
    (await call("report", id, { reason: "other" }, { user: moderator })).code,
    "ACCOUNT_BANNED",
  );
});
test("owner deletion works during BAN, private, no consent, stop and preserves lock scheduling", async () => {
  const id = await post();
  await assets(id);
  await db.exec(
    "UPDATE public.event_members SET is_banned=true,banned_at=now(); DELETE FROM public.consents; UPDATE public.events SET status='private'; UPDATE public.event_settings SET publication_stopped=true,uploads_enabled=false; UPDATE public.media_assets SET retention_until='2099-04-01' WHERE purpose='original'",
  );
  assert.equal(
    (await call("delete_own", id, {}, { user: reporter })).code,
    "NOT_FOUND",
  );
  assert.equal((await call("delete_own", id, {}, { user: owner })).code, "ok");
  assert.equal((await row(id)).status, "deleted");
  assert.equal(
    await count(
      "media_assets",
      "deletion_requested_at IS NOT NULL AND physically_deleted_at IS NULL",
    ),
    5,
  );
  assert.equal(await count("outbox_jobs", "kind='delete_assets'"), 5);
  assert.equal(
    await count(
      "outbox_jobs",
      "kind='delete_assets' AND available_at='2099-04-01'",
    ),
    1,
  );
  assert.equal((await call("delete_own", id, {}, { user: owner })).code, "ok");
  assert.equal(await count("outbox_jobs"), 6);
});
test("moderator can hide, restore ready media and delete, never settings/themes/BAN/appeals/retry", async () => {
  const id = await post();
  await assets(id);
  assert.equal(
    (await call("hide", id, action, { user: moderator })).code,
    "ok",
  );
  assert.equal(
    (
      await call(
        "restore",
        id,
        { ...action, expected_version: 2 },
        { user: moderator },
      )
    ).code,
    "ok",
  );
  assert.equal((await row(id)).status, "published");
  for (const [op, target, input] of [
    ["get_settings", null, {}],
    ["admin_themes", null, {}],
    ["ban", owner, { reason: "x" }],
    ["admin_appeals", null, { limit: 10 }],
    ["retry", id, action],
  ])
    assert.equal(
      (await call(op, target, input, { user: moderator })).code,
      "FORBIDDEN",
    );
  assert.equal(
    (
      await call(
        "delete",
        id,
        { ...action, expected_version: 3 },
        { user: moderator },
      )
    ).code,
    "ok",
  );
  assert.equal((await row(id)).status, "deleted");
});
test("restore fails for missing derivatives, stale version, BLOCK and public stop", async () => {
  const id = await post("hidden");
  assert.equal((await call("restore", id, action)).code, "PROCESSING_HELD");
  await assets(id);
  assert.equal(
    (await call("restore", id, { ...action, expected_version: 2 })).code,
    "STATE_CONFLICT",
  );
  await db.exec(
    "UPDATE public.event_settings SET publication_stopped=true,uploads_enabled=false",
  );
  assert.equal((await call("restore", id, action)).code, "PUBLICATION_STOPPED");
  await db.exec(
    "UPDATE public.event_settings SET publication_stopped=false; UPDATE public.posts SET moderation_verdict='BLOCK'",
  );
  assert.equal((await call("restore", id, action)).code, "PROCESSING_HELD");
});
test("BAN latches every nondeleted post; unban never republishes; only admin explicitly restores", async () => {
  const id = await post();
  await assets(id);
  const active = await post("processing");
  assert.equal((await call("ban", owner, { reason: "Synthetic" })).code, "ok");
  assert.equal((await row(id)).ban_latched, true);
  assert.equal((await row(id)).status, "hidden");
  assert.equal((await row(active)).ban_latched, true);
  assert.equal(
    (await call("restore", id, { ...action, expected_version: 2 })).code,
    "ACCOUNT_BANNED",
  );
  assert.equal((await call("unban", owner, { reason: "Reviewed" })).code, "ok");
  assert.equal((await row(id)).status, "hidden");
  assert.equal((await row(id)).ban_latched, true);
  assert.equal(
    (
      await call(
        "restore",
        id,
        { ...action, expected_version: 2 },
        { user: moderator },
      )
    ).code,
    "FORBIDDEN",
  );
  assert.equal(
    (await call("restore", id, { ...action, expected_version: 2 })).code,
    "ok",
  );
  assert.equal((await row(id)).ban_latched, false);
  assert.equal((await row(active)).ban_latched, true);
});
test("operations cannot BAN an operator or bypass role using another event", async () => {
  for (const user of [admin, moderator])
    assert.equal((await call("ban", user, { reason: "x" })).code, "FORBIDDEN");
  assert.equal(
    (await call("get_settings", null, {}, { user: owner })).code,
    "FORBIDDEN",
  );
  assert.equal(
    (await call("get_settings", null, {}, { user: randomUUID() })).code,
    "FORBIDDEN",
  );
});
test("admin theme CRUD hides drafts, validates periods, binds assignments and preserves used theme", async () => {
  assert.equal((await call("create_theme", null, theme)).code, "ok");
  const id = (await call("admin_themes")).items[0].id;
  assert.equal(
    (await call("themes", null, {}, { user: owner })).items.length,
    1,
  );
  const p = await post();
  assert.equal(
    (await call("reassign_theme", p, { ...action, theme_id: id })).code,
    "ok",
  );
  assert.equal((await row(p)).theme_id, id);
  assert.equal((await call("delete_theme", id)).code, "ok");
  assert.equal((await call("admin_themes")).items[0].status, "ended");
  assert.equal(
    (
      await call("reassign_theme", p, {
        ...action,
        expected_version: 2,
        theme_id: null,
      })
    ).code,
    "ok",
  );
  assert.equal((await call("delete_theme", id)).code, "ok");
  assert.equal((await call("admin_themes")).items.length, 0);
  assert.equal(
    (await call("create_theme", null, { ...theme, ends_at: theme.starts_at }))
      .code,
    "INVALID_INPUT",
  );
  assert.equal(
    (await call("create_theme", null, { ...theme, status: "draft" })).code,
    "ok",
  );
  assert.equal(
    (await call("themes", null, {}, { user: owner })).items.length,
    0,
  );
});
test("settings kill switch atomically stops upload and never approves changed thresholds", async () => {
  const initial = (await call("get_settings")).settings;
  assert.equal(initial.thresholds_approved, false);
  const input = {
    version: 1,
    publication_stopped: true,
    uploads_enabled: true,
    moderation_concurrency: 2,
    thresholds: [],
  };
  assert.equal((await call("update_settings", null, input)).code, "ok");
  const stopped = (await call("get_settings")).settings;
  assert.equal(stopped.uploads_enabled, false);
  assert.equal(stopped.publication_stopped, true);
  assert.equal(stopped.version, 2);
  assert.equal(
    (await call("update_settings", null, input)).code,
    "STATE_CONFLICT",
  );
  assert.equal(
    (
      await call("update_settings", null, {
        ...input,
        version: 2,
        publication_stopped: false,
      })
    ).code,
    "STATE_CONFLICT",
  );
  await db.exec("UPDATE public.event_settings SET thresholds_approved=true");
  assert.equal(
    (
      await call("update_settings", null, {
        ...input,
        version: 2,
        thresholds: [
          {
            engine: "openai",
            category: "violence",
            flag: 0.5,
            block: 0.9,
            immediate_ban: false,
          },
        ],
      })
    ).code,
    "ok",
  );
  assert.equal(
    (await call("get_settings")).settings.thresholds_approved,
    false,
  );
});
test("settings reject malformed, duplicate, unsupported and nonsevere immediate BAN thresholds", async () => {
  const threshold = {
    engine: "openai",
    category: "violence",
    flag: 0.5,
    block: 0.9,
    immediate_ban: false,
  };
  const settings = {
    version: 1,
    publication_stopped: true,
    uploads_enabled: false,
    moderation_concurrency: 2,
    thresholds: [threshold],
  };
  for (const thresholds of [
    [threshold, threshold],
    [{ ...threshold, flag: 1 }],
    [{ ...threshold, immediate_ban: true }],
    [{ ...threshold, category: "unknown" }],
    [{ ...threshold, flag: "0.5" }],
    [null],
  ])
    assert.equal(
      (await call("update_settings", null, { ...settings, thresholds })).code,
      "INVALID_INPUT",
    );
  assert.equal(
    (
      await call("update_settings", null, {
        ...settings,
        thresholds_approved: true,
      })
    ).code,
    "INVALID_INPUT",
  );
  assert.equal((await call("get_settings")).settings.version, 1);
});
test("BAN and BLOCK appeals work with revoked consent and stop; outcome cannot unban or restore", async () => {
  const id = await post("blocked");
  await db.exec(
    "DELETE FROM public.consents; UPDATE public.event_settings SET publication_stopped=true,uploads_enabled=false",
  );
  assert.equal(
    (
      await call(
        "appeal",
        null,
        { post_id: id, message: "Please review" },
        { user: owner },
      )
    ).code,
    "ok",
  );
  assert.equal(
    (
      await call(
        "appeal",
        null,
        { post_id: id, message: "Please review" },
        { user: owner },
      )
    ).code,
    "ok",
  );
  assert.equal(await count("appeals"), 1);
  assert.equal(
    (
      await call(
        "appeal",
        null,
        { post_id: id, message: "x" },
        { user: reporter },
      )
    ).code,
    "NOT_FOUND",
  );
  assert.equal(
    (await call("appeal", null, { message: "x" }, { user: owner })).code,
    "STATE_CONFLICT",
  );
  await db.query(
    "UPDATE public.event_members SET is_banned=true,banned_at=now() WHERE user_id=$1",
    [owner],
  );
  assert.equal(
    (await call("appeal", null, { message: "Account review" }, { user: owner }))
      .code,
    "ok",
  );
  await db.query("INSERT INTO public.consents VALUES($1,$2,'test',now())", [
    event,
    admin,
  ]);
  const list = await call("admin_appeals", null, { limit: 30 });
  assert.equal(list.items.length, 2);
  assert.equal(
    (
      await call("resolve_appeal", list.items[0].id, {
        status: "resolved",
        reason: "Handled separately",
      })
    ).code,
    "ok",
  );
  assert.equal((await row(id)).status, "blocked");
  assert.equal(
    (
      await db.query(
        "SELECT is_banned FROM public.event_members WHERE event_id=$1 AND user_id=$2",
        [event, owner],
      )
    ).rows[0].is_banned,
    true,
  );
});
test("retry keeps original/derivatives, enqueues correct immutable identity and never publishes", async () => {
  const id = await post("held");
  await assets(id);
  assert.equal((await call("retry", id, action)).code, "ok");
  assert.equal((await row(id)).status, "processing");
  assert.equal((await row(id)).moderation_verdict, null);
  const jobs = (
    await db.query(
      "SELECT payload FROM public.outbox_jobs WHERE kind='process_media'",
    )
  ).rows;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload.post_version, 2);
  assert.equal(jobs[0].payload.object_version, "version");
  assert.equal(jobs[0].payload.object_etag, "b".repeat(32));
  assert.equal(
    await count(
      "media_assets",
      "physically_deleted_at IS NULL AND deletion_requested_at IS NULL",
    ),
    5,
  );
  assert.equal((await call("retry", id, action)).code, "STATE_CONFLICT");
});
test("admin feed projects status only, prioritizes reports/FLAG, paginates without duplicates", async () => {
  await post();
  const flagged = await post("published_flagged");
  const reported = await post();
  await call("report", reported, { reason: "other" }, { user: reporter });
  const first = await call("admin_feed", null, { limit: 1 });
  assert.equal(first.items[0].post.id, reported);
  assert.equal(first.items[0].priority, 2);
  assert.equal(first.has_more, true);
  const second = await call("admin_feed", null, {
    limit: 1,
    before_at: first.items[0].post.created_at,
    before_id: reported,
    before_priority: 2,
  });
  assert.equal(second.items[0].post.id, flagged);
  assert.equal(second.items[0].priority, 1);
  assert.ok(!JSON.stringify(first).includes("object_key"));
  assert.ok(!JSON.stringify(first).includes("declared_content_type"));
});

test("admin preview reference requires a safe status and existing nondeleted derivative", async () => {
  const id = await post("hidden");
  const preview = async () =>
    (await call("admin_feed", null, { limit: 30 })).items.find(
      (item) => item.post.id === id,
    ).preview_resource;
  assert.equal(await preview(), null);
  await assets(id);
  assert.equal(await preview(), "review-webp-600");
  await db.query(
    "UPDATE public.posts SET status='blocked',moderation_verdict='BLOCK' WHERE id=$1",
    [id],
  );
  assert.equal(await preview(), null);
});
for (const [op, target, body] of [
  ["mystery", null, {}],
  ["themes", owner, {}],
  ["report", owner, { reason: "no" }],
  ["hide", owner, { ...action, expected_version: 1.2 }],
  ["hide", owner, { ...action, raw_secret: "x" }],
  ["appeal", null, { message: " " }],
  ["admin_feed", null, { limit: 101 }],
  ["admin_feed", null, { limit: 1, before_at: "2020-01-01T00:00:00Z" }],
  ["resolve_appeal", owner, { status: "open", reason: "x" }],
])
  test(`invalid direct RPC ${op} ${JSON.stringify(body)}`, async () =>
    assert.equal((await call(op, target, body)).code, "INVALID_INPUT"));

test("outbox failure rolls back status, count, report and audit atomically", async () => {
  const id = await post();
  await db.exec(`CREATE FUNCTION public.test_reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic outbox failure'; END $$;
    CREATE TRIGGER test_reject_outbox BEFORE INSERT ON public.outbox_jobs FOR EACH ROW EXECUTE FUNCTION public.test_reject_outbox();`);
  try {
    await assert.rejects(
      call("report", id, { reason: "other" }, { user: reporter }),
      /synthetic outbox failure/,
    );
    assert.equal((await row(id)).status, "published");
    assert.equal((await row(id)).report_count, 0);
    assert.equal(await count("reports"), 0);
    assert.equal(await count("audit_logs"), 0);
  } finally {
    await db.exec(
      "DROP TRIGGER test_reject_outbox ON public.outbox_jobs; DROP FUNCTION public.test_reject_outbox()",
    );
  }
});
test("counter follows hide/restore/delete without underflow from legacy zero", async () => {
  const id = await post();
  await assets(id);
  const current = async () =>
    Number(
      (
        await db.query(
          "SELECT published_post_count FROM public.event_members WHERE event_id=$1 AND user_id=$2",
          [event, owner],
        )
      ).rows[0].published_post_count,
    );
  await call("hide", id, action);
  assert.equal(await current(), 0);
  await call("restore", id, { ...action, expected_version: 2 });
  assert.equal(await current(), 1);
  await call("delete_own", id, {}, { user: owner });
  assert.equal(await current(), 0);
});
test("restore rechecks owner consent and deletion-scheduled assets", async () => {
  const id = await post("hidden");
  await assets(id);
  await db.query("DELETE FROM public.consents WHERE user_id=$1", [owner]);
  assert.equal((await call("restore", id, action)).code, "CONSENT_REQUIRED");
  await db.query(
    "INSERT INTO public.consents(event_id,user_id,terms_version) VALUES($1,$2,'test')",
    [event, owner],
  );
  await db.exec(
    "UPDATE public.media_assets SET deletion_requested_at=now() WHERE purpose='delivery_600_webp'",
  );
  assert.equal((await call("restore", id, action)).code, "PROCESSING_HELD");
});
test("cross-event targets cannot reassign, mutate or resolve", async () => {
  const id = await post("published", owner, otherEvent);
  for (const op of ["hide", "restore", "delete", "retry"])
    assert.equal((await call(op, id, action)).code, "NOT_FOUND");
  const id2 = await post();
  await call("create_theme", null, theme, { scope: otherEvent });
  const foreignTheme = (
    await call("admin_themes", null, {}, { scope: otherEvent })
  ).items[0].id;
  assert.equal(
    (await call("reassign_theme", id2, { ...action, theme_id: foreignTheme }))
      .code,
    "THEME_UNAVAILABLE",
  );
  assert.equal((await call("delete_theme", foreignTheme)).code, "NOT_FOUND");
  assert.equal(
    (
      await call("resolve_appeal", randomUUID(), {
        status: "resolved",
        reason: "x",
      })
    ).code,
    "NOT_FOUND",
  );
});
test("BAN/unban repeats do not repeatedly create side effects", async () => {
  await post();
  await call("ban", owner, { reason: "x" });
  const jobs = await count("outbox_jobs"),
    audits = await count("audit_logs");
  assert.equal((await call("ban", owner, { reason: "x" })).code, "ok");
  assert.equal(await count("outbox_jobs"), jobs);
  assert.equal(await count("audit_logs"), audits);
  await call("unban", owner, { reason: "x" });
  const after = await count("audit_logs");
  await call("unban", owner, { reason: "x" });
  assert.equal(await count("audit_logs"), after);
});
test("report and appeal budgets reject the eleventh new operation", async () => {
  const blocked = await post("blocked");
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await call(
          "appeal",
          null,
          { post_id: blocked, message: `Synthetic ${i}` },
          { user: owner },
        )
      ).code,
      "ok",
    );
  assert.equal(
    (
      await call(
        "appeal",
        null,
        { post_id: blocked, message: "Eleventh" },
        { user: owner },
      )
    ).code,
    "RATE_LIMITED",
  );
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await call(
          "report",
          await post(),
          { reason: "privacy" },
          { user: reporter },
        )
      ).code,
      "ok",
    );
  assert.equal(
    (
      await call(
        "report",
        await post(),
        { reason: "privacy" },
        { user: reporter },
      )
    ).code,
    "RATE_LIMITED",
  );
});
