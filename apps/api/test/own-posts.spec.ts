import { expect, it, vi } from "vitest";
import { errors, postStates } from "@koko/contract";
import { handleOwnPosts, type OwnPostsEnv } from "../src/own-posts";
import {
  ownPostsCursorKey,
  readOwnPostsCursor,
  signOwnPostsCursor,
} from "../src/own-post-cursor";
import worker from "../src/index";

const eventId = "11111111-1111-4111-8111-111111111111",
  userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  postId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const secret = "ab".repeat(32),
  scope = { eventId, userId, limit: 30 };
const post = {
  id: postId,
  event_id: eventId,
  status: "processing",
  version: 3,
  created_at: "2026-10-05T00:00:00.123456Z",
};
const result = { code: "ok", items: [post], has_more: false };
function request(path = `/posts/${postId}/status`, init: RequestInit = {}) {
  return new Request(`https://api.example.test${path}`, {
    ...init,
    headers: {
      authorization: "Bearer synthetic-token",
      "X-Event-ID": eventId,
      ...init.headers,
    },
  });
}
function fixture(value: unknown = result) {
  const env: OwnPostsEnv = {
    KOKO_OWN_POSTS_ENABLED: "true",
    KOKO_POST_CURSOR_SECRET: secret,
    SUPABASE_URL: "https://fixture.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    SUPABASE_SECRET_KEY: "sb_secret_fixture",
  };
  const calls: Record<string, unknown>[] = [];
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
    expect(url.pathname).toBe("/rest/v1/rpc/read_own_posts");
    const headers = new Headers(init?.headers);
    expect(headers.get("apikey")).toBe(env.SUPABASE_SECRET_KEY);
    expect(headers.get("authorization")).toBeNull();
    calls.push(JSON.parse(String(init?.body)));
    if (value instanceof Error) throw value;
    return value instanceof Response ? value : Response.json(value);
  });
  return { env, fetcher, calls };
}
async function code(response: Response, expected: keyof typeof errors) {
  expect(response.status).toBe(errors[expected].status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({ code: expected });
}
it.each([
  "sexual",
  "violence",
  "hate",
  "harassment",
  "self_harm",
  "illicit",
  "other",
])("projects only safe BLOCK category %s", async (category) => {
  const item = { ...post, status: "blocked", block_category: category };
  const f = fixture({
    ...result,
    items: [{ ...item, raw_moderation: "private" }],
  });
  expect(
    await (await handleOwnPosts(request(), f.env, f.fetcher)).json(),
  ).toEqual(item);
});
it.each([
  ["RETENTION_UNKNOWN", null],
  ["RETENTION_PENDING", "2099-01-01T00:00:00.000000Z"],
  ["PHYSICAL_DELETION_NOT_ENABLED", "2000-01-01T00:00:00Z"],
  ["DELETION_UNCONFIRMED", null],
])(
  "projects deletion state %s without asset IDs/raw provider details",
  async (state, date) => {
    const item = {
      ...post,
      status: "deleted",
      deletion: { state, retention_until: date },
    };
    const f = fixture({
      ...result,
      items: [
        {
          ...item,
          deletion: {
            ...item.deletion,
            object_key: "private",
            job_id: "private",
          },
        },
      ],
    });
    expect(
      await (await handleOwnPosts(request(), f.env, f.fetcher)).json(),
    ).toEqual(item);
  },
);
it.each([
  { status: "blocked", block_category: "ocr:sexual raw private" },
  { status: "published", block_category: "sexual" },
  { status: "deleted", deletion: { state: "DONE", retention_until: null } },
  {
    status: "held",
    deletion: { state: "RETENTION_UNKNOWN", retention_until: null },
  },
  {
    status: "deleted",
    deletion: { state: "RETENTION_PENDING", retention_until: null },
  },
  {
    status: "deleted",
    deletion: { state: "RETENTION_UNKNOWN", retention_until: "infinity" },
  },
  {
    status: "deleted",
    deletion: {
      state: "RETENTION_UNKNOWN",
      retention_until: "2099-02-30T00:00:00Z",
    },
  },
])("rejects malformed state details %#", async (change) => {
  const f = fixture({ ...result, items: [{ ...post, ...change }] });
  await code(
    await handleOwnPosts(request(), f.env, f.fetcher),
    "INTERNAL_ERROR",
  );
});
it("GET status projects current state only, fresh verified user/event and no response headers leak", async () => {
  const f = fixture({
    ...result,
    secret: "private",
    items: [
      {
        ...post,
        user_id: userId,
        raw_block_category: "private text",
        object_key: "secret path",
      },
    ],
  });
  const r = await handleOwnPosts(request(), f.env, f.fetcher);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual(post);
  expect(r.headers.get("cache-control")).toBe("private, no-store");
  expect(r.headers.get("set-cookie")).toBeNull();
  expect(r.headers.get("access-control-allow-origin")).toBeNull();
  expect(f.calls).toEqual([
    {
      p_event_id: eventId,
      p_user_id: userId,
      p_post_id: postId,
      p_before_created_at: null,
      p_before_id: null,
      p_limit: 1,
    },
  ]);
});
it.each(postStates)(
  "projects %s state without reusing a completion receipt",
  async (status) => {
    const f = fixture({ ...result, items: [{ ...post, status }] });
    expect(
      await (await handleOwnPosts(request(), f.env, f.fetcher)).json(),
    ).toEqual({ ...post, status });
  },
);
it("list mints a scoped next cursor, then passes exact microsecond position to RPC", async () => {
  const f = fixture({ ...result, has_more: true });
  const page = (await (
    await handleOwnPosts(request("/me/posts?limit=1"), f.env, f.fetcher)
  ).json()) as { items: unknown[]; next_cursor: string };
  expect(page.items).toEqual([post]);
  expect(page.next_cursor.length).toBeLessThan(1025);
  const next = fixture({ code: "ok", items: [], has_more: false });
  expect(
    await (
      await handleOwnPosts(
        request(`/me/posts?limit=1&cursor=${page.next_cursor}`),
        next.env,
        next.fetcher,
      )
    ).json(),
  ).toEqual({ items: [], next_cursor: null });
  expect(next.calls[0]).toMatchObject({
    p_user_id: userId,
    p_post_id: null,
    p_before_created_at: post.created_at,
    p_before_id: postId,
    p_limit: 1,
  });
});
it("empty page and repeated GET use fresh Auth and RPC, never cached", async () => {
  const f = fixture({ code: "ok", items: [], has_more: false });
  for (let i = 0; i < 2; i++)
    expect(
      await (
        await handleOwnPosts(request("/me/posts"), f.env, f.fetcher)
      ).json(),
    ).toEqual({ items: [], next_cursor: null });
  expect(f.calls).toHaveLength(2);
  expect(f.fetcher).toHaveBeenCalledTimes(4);
});
it.each([undefined, "false", "TRUE", "1"])(
  "unset/off flag %s never authenticates",
  async (flag) => {
    const f = fixture();
    if (flag === undefined) delete f.env.KOKO_OWN_POSTS_ENABLED;
    else f.env.KOKO_OWN_POSTS_ENABLED = flag;
    await code(await handleOwnPosts(request(), f.env, f.fetcher), "NOT_FOUND");
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it.each(["/me/posts", `/posts/${postId}/status`])(
  "Worker routes %s through default-off and auth",
  async (path) => {
    const f = fixture();
    expect(
      (
        await worker.fetch(
          request(path) as Request<unknown, IncomingRequestCfProperties>,
          {} as Env,
        )
      ).status,
    ).toBe(404);
    const req = request(path);
    req.headers.delete("authorization");
    await code(
      await worker.fetch(
        req as Request<unknown, IncomingRequestCfProperties>,
        f.env as Env,
      ),
      "AUTH_REQUIRED",
    );
  },
);
it.each(["POST", "HEAD", "OPTIONS", "DELETE", "PATCH"])(
  "%s never reads or writes",
  async (method) => {
    const f = fixture();
    const r = await handleOwnPosts(
      request("/me/posts", { method }),
      f.env,
      f.fetcher,
    );
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET");
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it.each([
  "/me/posts?limit=0",
  "/me/posts?limit=101",
  "/me/posts?limit=01",
  "/me/posts?limit=1.0",
  "/me/posts?limit=",
  "/me/posts?limit=1&limit=2",
  "/me/posts?user_id=x",
  "/me/posts?theme=x",
  "/me/posts?cursor=a&cursor=b",
  "/posts/not-uuid/status",
  `/posts/${postId}/status?limit=1`,
])("rejects input %s before RPC", async (path) => {
  const f = fixture();
  await code(
    await handleOwnPosts(request(path), f.env, f.fetcher),
    "INVALID_INPUT",
  );
  expect(f.calls).toHaveLength(0);
});
it("empty/tampered cursor and wrong limit cannot reach DB", async () => {
  for (const cursor of ["", "invalid", "x".repeat(1025)]) {
    const f = fixture();
    await code(
      await handleOwnPosts(
        request(`/me/posts?cursor=${cursor}`),
        f.env,
        f.fetcher,
      ),
      "INVALID_CURSOR",
    );
    expect(f.calls).toHaveLength(0);
  }
});
it("pagination requires independent key; single status does not need a cursor key", async () => {
  const f = fixture();
  delete f.env.KOKO_POST_CURSOR_SECRET;
  await code(
    await handleOwnPosts(request("/me/posts"), f.env, f.fetcher),
    "INTERNAL_ERROR",
  );
  expect(f.calls).toHaveLength(0);
  expect((await handleOwnPosts(request(), f.env, f.fetcher)).status).toBe(200);
});
it.each(["FORBIDDEN", "NOT_FOUND", "INVALID_INPUT"] as const)(
  "maps RPC %s without private fields",
  async (err) => {
    const f = fixture({ code: err, private: "must not leak" });
    await code(await handleOwnPosts(request(), f.env, f.fetcher), err);
  },
);
it.each([
  null,
  {},
  { code: "mystery", detail: "private" },
  { ...result, items: [] },
  { ...result, items: [post, post] },
  { ...result, has_more: true },
  ...[
    { id: eventId },
    { event_id: userId },
    { status: "unknown" },
    { version: 0 },
    { version: Number.MAX_SAFE_INTEGER + 1 },
    { created_at: "invalid" },
    { error_code: "private text" },
    { error_code: "CONTENT_BLOCKED" },
  ].map((change) => ({ ...result, items: [{ ...post, ...change }] })),
])("rejects malformed RPC projection %j", async (data) => {
  const f = fixture(data);
  await code(
    await handleOwnPosts(request(), f.env, f.fetcher),
    "INTERNAL_ERROR",
  );
});
it.each([
  "CONTENT_BLOCKED",
  "PROCESSING_HELD",
  "VIDEO_TOO_LONG",
  "UNSUPPORTED_MEDIA",
])("allows a safe reason %s only for failure states", async (error_code) => {
  const f = fixture({
    ...result,
    items: [{ ...post, status: "held", error_code }],
  });
  const r = await handleOwnPosts(request(), f.env, f.fetcher);
  expect(((await r.json()) as { error_code: string }).error_code).toBe(
    error_code,
  );
});
it("duplicate/out of order/preceding cursor results fail closed", async () => {
  for (const items of [
    [post, post],
    [{ ...post, created_at: "2026-10-04T00:00:00Z" }, post],
  ]) {
    const f = fixture({ ...result, items });
    await code(
      await handleOwnPosts(request("/me/posts"), f.env, f.fetcher),
      "INTERNAL_ERROR",
    );
  }
  const key = await ownPostsCursorKey(secret);
  const token = await signOwnPostsCursor(key, scope, {
    id: postId,
    createdAt: post.created_at,
  });
  const f = fixture();
  await code(
    await handleOwnPosts(
      request(`/me/posts?cursor=${token}`),
      f.env,
      f.fetcher,
    ),
    "INTERNAL_ERROR",
  );
});
it.each([
  new Error("private token"),
  new Response("private", {
    status: 302,
    headers: { location: "https://bad.example.test" },
  }),
  new Response("private", { status: 500 }),
  new Response("<html>private</html>"),
  new Response("x".repeat(256 * 1024 + 1), {
    headers: { "content-type": "application/json" },
  }),
  new Response('{"bad":', { headers: { "content-type": "application/json" } }),
])("hides upstream failure/body without redirects", async (response) => {
  const f = fixture(response);
  await code(
    await handleOwnPosts(request(), f.env, f.fetcher),
    "INTERNAL_ERROR",
  );
});
it("upstream Auth rejection or wrong provider never calls RPC", async () => {
  for (const body of [
    new Response(null, { status: 401 }),
    Response.json({
      id: userId,
      app_metadata: { provider: "email", providers: ["email"] },
    }),
  ]) {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(body);
    const r = await handleOwnPosts(request(), f.env, f.fetcher);
    expect([401, 403]).toContain(r.status);
    expect(f.calls).toHaveLength(0);
  }
});
it("Cookie read works without CSRF but still enforces origin/mixed credentials", async () => {
  const f = fixture();
  f.env.KOKO_WEB_ORIGIN = "https://web.example.test";
  f.env.KOKO_CSRF_SECRET = "cc".repeat(32);
  const req = request();
  req.headers.delete("authorization");
  req.headers.set("cookie", "__Host-koko_session=synthetic-token");
  req.headers.set("Origin", f.env.KOKO_WEB_ORIGIN);
  expect((await handleOwnPosts(req, f.env, f.fetcher)).status).toBe(200);
  req.headers.set("Origin", "https://other.example.test");
  await code(await handleOwnPosts(req, f.env, f.fetcher), "FORBIDDEN");
  req.headers.set("authorization", "Bearer synthetic-token");
  await code(await handleOwnPosts(req, f.env, f.fetcher), "AUTH_REQUIRED");
  expect(f.calls).toHaveLength(1);
});
it("aborted request never emits status", async () => {
  const f = fixture();
  const c = new AbortController();
  c.abort();
  await code(
    await handleOwnPosts(
      request("/me/posts", { signal: c.signal }),
      f.env,
      f.fetcher,
    ),
    "INTERNAL_ERROR",
  );
  expect(f.calls).toHaveLength(0);
});
it.each(["client", "deadline"])(
  "%s abort cancels a stalled response body",
  async (mode) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const f = fixture(
      new Response(stream, { headers: { "content-type": "application/json" } }),
    );
    const controller = new AbortController();
    let rpcStarted!: () => void;
    const arrived = new Promise<void>((resolve) => {
      rpcStarted = resolve;
    });
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (target, init) => {
      const response = await original(target, init);
      if (new URL(String(target)).pathname === "/rest/v1/rpc/read_own_posts")
        rpcStarted();
      return response;
    });
    try {
      const pending = handleOwnPosts(
        request("/me/posts", { signal: controller.signal }),
        f.env,
        f.fetcher,
      );
      await arrived;
      // Let the response reader attach its abort listener.
      await vi.advanceTimersByTimeAsync(0);
      expect(f.calls).toHaveLength(1);
      if (mode === "client") controller.abort();
      else await vi.advanceTimersByTimeAsync(10_000);
      await code(await pending, "INTERNAL_ERROR");
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  },
);
it.each([302, 500, 200])(
  "cancels rejected %s response streams",
  async (status) => {
    const cancel = vi.fn();
    const f = fixture(
      new Response(new ReadableStream({ cancel }), {
        status,
        headers: { "content-type": "text/html" },
      }),
    );
    await code(
      await handleOwnPosts(request(), f.env, f.fetcher),
      "INTERNAL_ERROR",
    );
    expect(cancel).toHaveBeenCalledOnce();
  },
);

it("cursor matches independent Node HMAC vector and retains microseconds", async () => {
  const key = await ownPostsCursorKey(secret);
  const position = { id: postId, createdAt: post.created_at },
    now = 1_000_000;
  const token = await signOwnPostsCursor(key, scope, position, now);
  const [payload, mac] = token.split(".");
  // Independently computed with Node createHmac, not the production WebCrypto helper.
  expect(mac).toBe("cbmVQgvu94i251cNrsbV8KprMuaNfNzUMSqETXl4rgE");
  expect(await readOwnPostsCursor(token, key, scope, now)).toEqual(position);
  for (const changed of [
    { ...scope, eventId: userId },
    { ...scope, userId: eventId },
    { ...scope, limit: 31 },
  ])
    await expect(
      readOwnPostsCursor(token, key, changed, now),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  await expect(
    readOwnPostsCursor(
      token,
      await ownPostsCursorKey("cd".repeat(32)),
      scope,
      now,
    ),
  ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  for (const time of [now + 900_000, now - 1000])
    await expect(
      readOwnPostsCursor(token, key, scope, time),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  for (const tampered of [
    token + ".extra",
    "!" + token.slice(1),
    payload + "." + "a".repeat(43),
    token + "=",
  ])
    await expect(
      readOwnPostsCursor(tampered, key, scope, now),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
});
it("even a valid MAC rejects wrong purpose, extra fields and invalid position", async () => {
  const key = await ownPostsCursorKey(secret),
    now = 1_000_000;
  const token = await signOwnPostsCursor(
    key,
    scope,
    { id: postId, createdAt: post.created_at },
    now,
  );
  const parts = JSON.parse(
    atob(token.split(".")[0]!.replaceAll("-", "+").replaceAll("_", "/")),
  );
  for (const changed of [
    ["public-feed", ...parts.slice(1)],
    [...parts, "extra"],
    [...parts.slice(0, 4), "invalid", postId, parts[6]],
  ]) {
    const encode = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
    const payload = encode(new TextEncoder().encode(JSON.stringify(changed)));
    const mac = encode(
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(payload),
        ),
      ),
    );
    await expect(
      readOwnPostsCursor(`${payload}.${mac}`, key, scope, now),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  }
});
