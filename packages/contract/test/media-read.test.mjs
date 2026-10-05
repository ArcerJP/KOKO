import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { before, beforeEach, after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite();
const event = "11111111-1111-4111-8111-111111111111",
  otherEvent = "22222222-2222-4222-8222-222222222222",
  owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  viewer = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  admin = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
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
  for (const id of [owner, viewer, admin])
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
      [viewer, "user"],
      [admin, "admin"],
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
  action = "feed",
  id = null,
  resource = null,
  input = action === "feed" ? { limit: 30 } : {},
  { user = viewer, scope = event, role = "service_role" } = {},
) {
  assert.ok(["service_role", "anon", "authenticated"].includes(role));
  await db.exec(`SET ROLE ${role}`);
  try {
    return (
      await db.query("SELECT public.read_media($1,$2,$3,$4,$5,$6) result", [
        scope,
        user,
        action,
        id,
        resource,
        JSON.stringify(input),
      ])
    ).rows[0].result;
  } finally {
    await db.exec("RESET ROLE");
  }
}
async function post(kind = "photo", scope = event) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO public.posts(event_id,id,user_id,kind,status,client_request_id,declared_content_type,original_scope,original_bytes,measured_duration_seconds,moderation_verdict,published_at)
    VALUES($1,$2,$3,$4,'published',$2,$5,$6,100,3.8,'PASS',now())`,
    [
      scope,
      id,
      owner,
      kind,
      kind === "photo" ? "image/jpeg" : "video/mp4",
      kind === "photo" ? "photo_file" : "client_trimmed",
    ],
  );
  for (const purpose of kind === "photo"
    ? [
        "original",
        "delivery_600_webp",
        "delivery_600_jpg",
        "delivery_1600_webp",
        "delivery_1600_jpg",
      ]
    : ["original", "stream_source"]) {
    const asset = randomUUID(),
      original = purpose === "original",
      stream = purpose === "stream_source";
    await db.query(
      `INSERT INTO public.media_assets(event_id,id,post_id,purpose,provider,object_key,stream_uid,byte_size,sha256,pixel_width,pixel_height,object_etag,object_version,stream_ready_to_stream,stream_processing_complete,stream_require_signed_urls,stream_duration_seconds)
      VALUES($1,$2,$3,$4,$5,$6,$7,100,$8,600,600,$9,'version',$10,$10,$10,$11)`,
      [
        scope,
        asset,
        id,
        purpose,
        original ? "r2_original" : stream ? "stream" : "r2_delivery",
        stream
          ? null
          : original
            ? `events/${scope}/posts/${id}/original/${asset}.bin`
            : `events/${scope}/delivery/${asset}/${purpose.split("_")[1]}.${purpose.split("_")[2]}`,
        stream ? asset.replaceAll("-", "") : null,
        "a".repeat(64),
        "b".repeat(32),
        stream,
        stream ? 3.8 : null,
      ],
    );
  }
  return id;
}
test("read RPC and projection cannot be called by browser DB roles", async () => {
  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(
      call("feed", null, null, { limit: 1 }, { role }),
      /permission denied/,
    );
    await db.exec(`SET ROLE ${role}`);
    try {
      await assert.rejects(
        db.query("SELECT koko_private.public_post_projection($1,$2)", [
          event,
          randomUUID(),
        ]),
        /permission denied/,
      );
    } finally {
      await db.exec("RESET ROLE");
    }
  }
});
test("feed/detail emits only relative authenticated derivatives and common author fields", async () => {
  const id = await post();
  const result = await call();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, id);
  assert.equal(
    result.items[0].media.webp_600,
    `/media/${event}/${id}/webp-600`,
  );
  for (const forbidden of [
    "original",
    "stream_uid",
    "object_key",
    "user_id",
    "sha256",
    "email",
  ])
    assert.ok(!JSON.stringify(result.items).includes(forbidden));
  assert.deepEqual((await call("post", id)).post, result.items[0]);
  assert.equal((await call("post", randomUUID())).code, "NOT_FOUND");
});
test("same cache requires current visibility; a first report invalidates it and bytes immediately", async () => {
  const id = await post(),
    initial = await call();
  assert.equal(
    (await call("feed", null, null, { limit: 30, cache: initial.cache }))
      .cache_valid,
    true,
  );
  await db.query(
    "SELECT public.stage_three_operation($1,$2,'report',$3,$4,$5)",
    [event, viewer, id, JSON.stringify({ reason: "privacy" }), randomUUID()],
  );
  const fresh = await call("feed", null, null, {
    limit: 30,
    cache: initial.cache,
  });
  assert.equal(fresh.cache_valid, false);
  assert.equal(fresh.items.length, 0);
  assert.equal((await call("asset", id, "webp-600")).code, "NOT_FOUND");
});
test("BAN/latched/changed owner consent excludes content and invalidates cached author data", async () => {
  const id = await post(),
    initial = await call();
  await db.query(
    "UPDATE public.event_members SET display_name='Changed' WHERE user_id=$1",
    [owner],
  );
  const changed = await call("feed", null, null, {
    limit: 30,
    cache: initial.cache,
  });
  assert.equal(changed.cache_valid, false);
  assert.equal(changed.items[0].display_name, "Changed");
  await db.query(
    "UPDATE public.event_members SET is_banned=true,banned_at=now() WHERE user_id=$1",
    [owner],
  );
  assert.equal((await call("post", id)).code, "NOT_FOUND");
  await db.query(
    "UPDATE public.event_members SET is_banned=false WHERE user_id=$1",
    [owner],
  );
  await db.exec(
    "UPDATE public.posts SET status='hidden',previous_public_status='published',hidden_reason='ban',ban_latched=true",
  );
  assert.equal((await call()).items.length, 0);
});
for (const [mutation, expected] of [
  [
    "UPDATE public.event_settings SET publication_stopped=true,uploads_enabled=false",
    "PUBLICATION_STOPPED",
  ],
  ["UPDATE public.events SET status='private'", "EVENT_CLOSED"],
  ["UPDATE public.events SET status='draft'", "EVENT_CLOSED"],
  ["DELETE FROM public.consents", "CONSENT_REQUIRED"],
])
  test(`cached page still checks ${expected}`, async () => {
    await post();
    const initial = await call();
    await db.exec(mutation);
    assert.equal(
      (await call("feed", null, null, { limit: 30, cache: initial.cache }))
        .code,
      expected,
    );
  });
test("viewer BAN and absent membership never receive cached public data", async () => {
  await post();
  const initial = await call();
  await db.query(
    "UPDATE public.event_members SET is_banned=true,banned_at=now() WHERE user_id=$1",
    [viewer],
  );
  assert.equal(
    (await call("feed", null, null, { limit: 30, cache: initial.cache })).code,
    "ACCOUNT_BANNED",
  );
  assert.equal(
    (
      await call(
        "feed",
        null,
        null,
        { limit: 30, cache: initial.cache },
        { user: randomUUID() },
      )
    ).code,
    "FORBIDDEN",
  );
});
test("private original retrieval requires role/version, audits and never exposes arbitrary keys", async () => {
  const id = await post(),
    input = { expected_version: 1, request_id: randomUUID() };
  assert.equal((await call("original", id, null, input)).code, "FORBIDDEN");
  assert.equal(
    (
      await call(
        "original",
        id,
        null,
        { ...input, expected_version: 2 },
        { user: admin },
      )
    ).code,
    "STATE_CONFLICT",
  );
  await db.exec(
    "UPDATE public.event_settings SET publication_stopped=true,uploads_enabled=false; UPDATE public.events SET status='private'",
  );
  const allowed = await call("original", id, null, input, { user: admin });
  assert.equal(allowed.asset.purpose, "original");
  assert.equal(allowed.asset.provider, "r2_original");
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT count(*) n FROM public.audit_logs WHERE action='read_original'",
        )
      ).rows[0].n,
    ),
    1,
  );
  assert.equal(
    (
      await call(
        "original",
        id,
        null,
        { ...input, object_key: "arbitrary" },
        { user: admin },
      )
    ).code,
    "INVALID_INPUT",
  );
});
test("BLOCK and deletion requests remain inaccessible even to operator originals/review", async () => {
  const id = await post(),
    input = { expected_version: 1, request_id: randomUUID() };
  await db.exec(
    "UPDATE public.posts SET status='blocked',moderation_verdict='BLOCK'",
  );
  for (const [action, resource, body] of [
    ["original", null, input],
    ["asset", "review-jpg-600", {}],
  ])
    assert.equal(
      (await call(action, id, resource, body, { user: admin })).code,
      "NOT_FOUND",
    );
  await db.exec(
    "UPDATE public.posts SET status='held',moderation_verdict=NULL; UPDATE public.media_assets SET deletion_requested_at=now()",
  );
  assert.equal(
    (await call("original", id, null, input, { user: admin })).code,
    "NOT_FOUND",
  );
});
test("review image role bypass is separate from public availability and still not original", async () => {
  const id = await post();
  await db.exec(
    "UPDATE public.posts SET status='hidden',previous_public_status='published',hidden_reason='report'; UPDATE public.event_settings SET publication_stopped=true,uploads_enabled=false",
  );
  assert.equal((await call("asset", id, "review-jpg-600")).code, "FORBIDDEN");
  assert.equal(
    (await call("asset", id, "review-jpg-600", {}, { user: admin })).asset
      .provider,
    "r2_delivery",
  );
  assert.equal(
    (await call("asset", id, "original", {}, { user: admin })).code,
    "PUBLICATION_STOPPED",
  );
});
test("current owner BAN blocks operator original and review bytes; unban alone still does not publish", async () => {
  const id = await post();
  const input = { expected_version: 1, request_id: randomUUID() };
  await db.query(
    "UPDATE public.event_members SET is_banned=true,banned_at=now() WHERE event_id=$1 AND user_id=$2",
    [event, owner],
  );
  for (const [action, resource, body] of [
    ["original", null, input],
    ["asset", "review-jpg-600", {}],
  ]) {
    assert.equal(
      (await call(action, id, resource, body, { user: admin })).code,
      "NOT_FOUND",
    );
  }
  await db.query(
    "UPDATE public.posts SET ban_latched=true,status='hidden',previous_public_status='published',hidden_reason='ban' WHERE id=$1",
    [id],
  );
  await db.query(
    "UPDATE public.event_members SET is_banned=false,banned_at=null WHERE event_id=$1 AND user_id=$2",
    [event, owner],
  );
  assert.equal(
    (await call("asset", id, "review-jpg-600", {}, { user: admin })).code,
    "ok",
  );
  assert.equal(
    (await call("asset", id, "jpg-600", {}, { user: admin })).code,
    "NOT_FOUND",
  );
});
test("video gate requires all provider evidence and version-bound opaque child", async () => {
  const id = await post("video");
  assert.equal((await call("post", id)).post.media.duration_seconds, 3.8);
  assert.equal((await call("asset", id, "hls")).asset.provider, "stream");
  assert.equal(
    (await call("asset", id, "hls-child", { expected_version: 2 })).code,
    "NOT_FOUND",
  );
  assert.equal(
    (await call("asset", id, "hls-child", { expected_version: 1 })).code,
    "ok",
  );
  for (const column of [
    "stream_ready_to_stream",
    "stream_processing_complete",
    "stream_require_signed_urls",
  ]) {
    await db.exec(
      `UPDATE public.media_assets SET ${column}=false WHERE provider='stream'`,
    );
    assert.equal((await call("asset", id, "hls")).code, "NOT_FOUND");
    assert.equal((await call()).items.length, 0);
    await db.exec(
      `UPDATE public.media_assets SET ${column}=true WHERE provider='stream'`,
    );
  }
  await db.exec(
    "UPDATE public.media_assets SET stream_duration_seconds=4.1 WHERE provider='stream'",
  );
  assert.equal((await call("asset", id, "hls")).code, "NOT_FOUND");
});

test("hidden video review thumbnail needs a current operator, never bypasses BLOCK, BAN or deletion", async () => {
  const id = await post("video");
  await db.exec(
    "UPDATE public.posts SET status='hidden',previous_public_status='published',hidden_reason='report'; UPDATE public.event_settings SET publication_stopped=true,uploads_enabled=false",
  );
  assert.equal((await call("asset", id, "review-thumbnail")).code, "FORBIDDEN");
  assert.equal(
    (await call("asset", id, "review-thumbnail", {}, { user: admin })).asset
      .provider,
    "stream",
  );
  await db.query(
    "UPDATE public.posts SET moderation_verdict='BLOCK' WHERE id=$1",
    [id],
  );
  assert.equal(
    (await call("asset", id, "review-thumbnail", {}, { user: admin })).code,
    "NOT_FOUND",
  );
  await db.query(
    "UPDATE public.posts SET moderation_verdict='PASS' WHERE id=$1",
    [id],
  );
  await db.query(
    "UPDATE public.event_members SET is_banned=true,banned_at=now() WHERE event_id=$1 AND user_id=$2",
    [event, owner],
  );
  assert.equal(
    (await call("asset", id, "review-thumbnail", {}, { user: admin })).code,
    "NOT_FOUND",
  );
  await db.query(
    "UPDATE public.event_members SET is_banned=false,banned_at=null WHERE event_id=$1 AND user_id=$2",
    [event, owner],
  );
  await db.query(
    "UPDATE public.media_assets SET deletion_requested_at=now() WHERE post_id=$1 AND provider='stream'",
    [id],
  );
  assert.equal(
    (await call("asset", id, "review-thumbnail", {}, { user: admin })).code,
    "NOT_FOUND",
  );
});
test("public page is microsecond keyset scoped to event/theme and cache proof cannot cross filter", async () => {
  const id1 = await post(),
    id2 = await post(),
    foreign = await post("photo", otherEvent);
  await db.query(
    "UPDATE public.posts SET created_at='2026-10-06T00:00:00.123456Z' WHERE id=$1",
    [id1],
  );
  await db.query(
    "UPDATE public.posts SET created_at='2026-10-06T00:00:00.123457Z' WHERE id=$1",
    [id2],
  );
  const first = await call("feed", null, null, { limit: 1 });
  assert.equal(first.items[0].id, id2);
  assert.equal(first.has_more, true);
  const second = await call("feed", null, null, {
    limit: 1,
    before_at: first.items[0].created_at,
    before_id: id2,
  });
  assert.equal(second.items[0].id, id1);
  assert.equal((await call("post", foreign)).code, "NOT_FOUND");
  assert.equal(
    (
      await call("feed", null, null, {
        limit: 1,
        theme_id: randomUUID(),
        cache: first.cache,
      })
    ).items.length,
    0,
  );
});
test("missing or scheduled derivative prevents DTO and public bytes", async () => {
  const id = await post();
  await db.exec(
    "UPDATE public.media_assets SET deletion_requested_at=now() WHERE purpose='delivery_1600_webp'",
  );
  assert.equal((await call()).items.length, 0);
  assert.equal((await call("asset", id, "jpg-600")).code, "NOT_FOUND");
});
