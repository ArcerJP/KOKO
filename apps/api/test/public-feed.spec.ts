import { expect, it, vi } from "vitest";
import { errors } from "@koko/contract";
import {
  handlePublicFeed,
  PublicFeedCache,
  type PublicFeedEnv,
} from "../src/public-feed";
const eventId = "11111111-1111-4111-8111-111111111111",
  userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  postId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const base = `/media/${eventId}/${postId}/`;
const post = {
  id: postId,
  event_id: eventId,
  kind: "photo",
  display_name: "Synthetic",
  crown: "none",
  theme_id: null,
  created_at: "2026-10-06T00:00:00.123456Z",
  like_count: 0,
  media: {
    kind: "photo",
    webp_600: base + "webp-600",
    jpg_600: base + "jpg-600",
    webp_1600: base + "webp-1600",
    jpg_1600: base + "jpg-1600",
  },
};
const page = {
  code: "ok",
  cache_valid: false,
  items: [post],
  has_more: false,
  cache: [{ id: postId, fingerprint: "a".repeat(32) }],
};
function request(path = "/feed") {
  return new Request(`https://api.example.test${path}`, {
    headers: { authorization: "Bearer synthetic-token", "X-Event-ID": eventId },
  });
}
function fixture(value: unknown = page) {
  let result = value;
  const env: PublicFeedEnv = {
    KOKO_PUBLIC_FEED_ENABLED: "true",
    KOKO_POST_CURSOR_SECRET: "ab".repeat(32),
    SUPABASE_URL: "https://fixture.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    SUPABASE_SECRET_KEY: "sb_secret_fixture",
  };
  const calls: Record<string, unknown>[] = [],
    cache = new PublicFeedCache();
  const fetcher = vi.fn<typeof fetch>(async (target, init) => {
    const url = new URL(String(target));
    expect(url.origin).toBe("https://fixture.supabase.co");
    expect(init?.redirect).toBe("manual");
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (url.pathname === "/auth/v1/user")
      return Response.json({
        id: userId,
        app_metadata: { provider: "google", providers: ["google"] },
      });
    expect(url.pathname).toBe("/rest/v1/rpc/read_media");
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    calls.push(JSON.parse(String(init?.body)));
    if (result instanceof Error) throw result;
    return result instanceof Response ? result : Response.json(result);
  });
  return {
    env,
    calls,
    cache,
    fetcher,
    setResult: (v: unknown) => {
      result = v;
    },
    run: (req = request()) => handlePublicFeed(req, env, fetcher, cache),
  };
}
async function code(r: Response, name: keyof typeof errors) {
  expect(r.status).toBe(errors[name].status);
  expect(r.headers.get("cache-control")).toBe("private, no-store");
  expect(await r.json()).toMatchObject({ code: name });
}
it("common feed strips all private upstream properties and has no browser/shared HTTP cache", async () => {
  const f = fixture({
    ...page,
    items: [
      {
        ...post,
        user_id: userId,
        object_key: "private",
        stream_uid: "private",
        media: { ...post.media, raw: "private" },
      },
    ],
  });
  const r = await f.run();
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ items: [post], next_cursor: null });
  expect(r.headers.get("cache-control")).toBe("private, no-store");
  expect(r.headers.get("set-cookie")).toBeNull();
  expect(r.headers.get("access-control-allow-origin")).toBeNull();
  expect(f.calls[0]).toMatchObject({
    p_action: "feed",
    p_post_id: null,
    p_input: { limit: 30 },
  });
});
it("common cache hit still verifies Auth, membership/public policy and EVERY cached ID fingerprint", async () => {
  const f = fixture();
  await f.run();
  f.setResult({ code: "ok", cache_valid: true });
  expect(await (await f.run()).json()).toEqual({
    items: [post],
    next_cursor: null,
  });
  expect(f.calls).toHaveLength(2);
  expect(f.fetcher).toHaveBeenCalledTimes(4);
  expect(f.calls[1]?.p_input).toEqual({ limit: 30, cache: page.cache });
});
it.each([
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "ACCOUNT_BANNED",
  "CONSENT_REQUIRED",
  "PUBLICATION_STOPPED",
  "EVENT_CLOSED",
] as const)("cached item cannot bypass %s", async (name) => {
  const f = fixture();
  await f.run();
  if (name === "AUTH_REQUIRED")
    f.fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
  else f.setResult({ code: name });
  await code(await f.run(), name);
});
it("cache invalidation removes hidden post before emitting and does not reinsert stale object", async () => {
  const f = fixture();
  await f.run();
  f.setResult({
    code: "ok",
    cache_valid: false,
    items: [],
    has_more: false,
    cache: [],
  });
  expect(await (await f.run()).json()).toEqual({
    items: [],
    next_cursor: null,
  });
  f.setResult({ code: "ok", cache_valid: true });
  expect(await (await f.run()).json()).toEqual({
    items: [],
    next_cursor: null,
  });
});
it("ten-second common cache expiry is absolute, not extended by a hit", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    await f.run();
    await vi.advanceTimersByTimeAsync(9000);
    f.setResult({ code: "ok", cache_valid: true });
    await f.run();
    await vi.advanceTimersByTimeAsync(1001);
    f.setResult(page);
    await f.run();
    expect(f.calls[2]?.p_input).toEqual({ limit: 30 });
  } finally {
    vi.useRealTimers();
  }
});
it("detail is always freshly authorized, not served from page cache", async () => {
  const f = fixture({ code: "ok", post });
  expect(await (await f.run(request(`/posts/${postId}`))).json()).toEqual(post);
  f.setResult({ code: "NOT_FOUND" });
  await code(await f.run(request(`/posts/${postId}`)), "NOT_FOUND");
  expect(f.calls[0]?.p_action).toBe("post");
});
it("cursor scopes event/theme/limit and microseconds; no user-specific field enters common cache", async () => {
  const f = fixture({ ...page, has_more: true });
  const first = (await (await f.run(request("/feed?limit=1"))).json()) as {
    next_cursor: string;
  };
  f.setResult({
    code: "ok",
    cache_valid: false,
    items: [],
    cache: [],
    has_more: false,
  });
  expect(
    (await f.run(request(`/feed?limit=1&cursor=${first.next_cursor}`))).status,
  ).toBe(200);
  expect(f.calls[1]?.p_input).toEqual({
    limit: 1,
    before_at: post.created_at,
    before_id: postId,
  });
  for (const path of [
    `/feed?limit=2&cursor=${first.next_cursor}`,
    `/feed?limit=1&theme=${userId}&cursor=${first.next_cursor}`,
    `/feed?limit=1&cursor=${first.next_cursor}x`,
  ])
    await code(await f.run(request(path)), "INVALID_CURSOR");
  expect(f.calls).toHaveLength(2);
});
it.each([undefined, "false", "TRUE"])(
  "flag %s remains default off",
  async (flag) => {
    const f = fixture();
    if (flag === undefined) delete f.env.KOKO_PUBLIC_FEED_ENABLED;
    else f.env.KOKO_PUBLIC_FEED_ENABLED = flag;
    await code(await f.run(), "NOT_FOUND");
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it.each([
  "/feed?limit=0",
  "/feed?limit=101",
  "/feed?limit=01",
  "/feed?limit=1&limit=2",
  "/feed?theme=bad",
  "/feed?theme=",
  "/feed?user_id=x",
  `/posts/${postId}?cursor=x`,
  "/posts/not-id",
])("malformed %s never reaches DB", async (path) => {
  const f = fixture();
  await code(await f.run(request(path)), "INVALID_INPUT");
  expect(f.calls).toHaveLength(0);
});
it.each([
  null,
  {},
  { code: "unknown" },
  { code: "ok", cache_valid: true },
  { ...page, cache: [] },
  { ...page, cache: [{ id: postId, fingerprint: "private" }] },
  { ...page, items: [post, post], cache: [...page.cache, ...page.cache] },
  ...[
    { event_id: userId },
    { id: "bad" },
    { like_count: 1 },
    { crown: "gold" },
    { display_name: "" },
    { created_at: "bad" },
    { media: { ...post.media, webp_600: "https://raw.example.test/secret" } },
    {
      media: { ...post.media, webp_600: `/media/${userId}/${postId}/webp-600` },
    },
  ].map((change) => ({ ...page, items: [{ ...post, ...change }] })),
])("malformed unsafe upstream %j fails closed", async (value) => {
  const f = fixture(value);
  await code(await f.run(), "INTERNAL_ERROR");
});
it("video DTO contains only gated HLS/thumbnail and verified <=4 second duration", async () => {
  const video = {
    ...post,
    kind: "video",
    media: {
      kind: "video",
      hls_url: base + "hls",
      thumbnail_url: base + "thumbnail",
      duration_seconds: 3.8,
    },
  };
  const f = fixture({ ...page, items: [video] });
  expect(await (await f.run()).json()).toEqual({
    items: [video],
    next_cursor: null,
  });
  f.setResult({
    ...page,
    items: [{ ...video, media: { ...video.media, duration_seconds: 4.1 } }],
  });
  await code(await f.run(), "INTERNAL_ERROR");
});
it.each([
  new Error("private"),
  new Response(null, {
    status: 302,
    headers: { location: "https://evil.example.test" },
  }),
  new Response("private", { status: 500 }),
  new Response("{", { headers: { "content-type": "application/json" } }),
])("upstream errors and redirects never leak", async (value) => {
  const f = fixture(value);
  await code(await f.run(), "INTERNAL_ERROR");
});
