import { expect, it, vi } from "vitest";
import { errors } from "@koko/contract";
import {
  handleStageThreeOperations,
  type StageThreeEnv,
} from "../src/stage-three-operations";
import { createCsrfToken } from "../src/account-auth";

const eventId = "11111111-1111-4111-8111-111111111111",
  userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  postId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const action = { expected_version: 1, reason: "Synthetic review" };
const theme = {
  id: postId,
  event_id: eventId,
  title: "Test",
  description: "Synthetic",
  icon: "camera",
  color: "#4338ca",
  status: "published",
  starts_at: "2020-01-01T00:00:00Z",
  ends_at: "2099-01-01T00:00:00Z",
};
const settings = {
  version: 1,
  publication_stopped: true,
  uploads_enabled: false,
  moderation_concurrency: 1,
  thresholds: [],
  thresholds_approved: false,
};
const post = {
  id: postId,
  event_id: eventId,
  status: "hidden",
  version: 1,
  created_at: "2026-10-06T00:00:00.123456Z",
};
const adminItem = {
  post,
  user_id: userId,
  report_count: 1,
  is_banned: false,
  priority: 2,
};
function request(
  path = `/posts/${postId}/reports`,
  method = "POST",
  data: unknown = { reason: "privacy" },
) {
  return new Request(`https://api.example.test${path}`, {
    method,
    headers: {
      authorization: "Bearer synthetic-token",
      "X-Event-ID": eventId,
      ...(method === "GET" || method === "DELETE"
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(method === "GET" || method === "DELETE"
      ? {}
      : { body: JSON.stringify(data) }),
  });
}
function fixture(value: unknown = { code: "ok" }) {
  const env: StageThreeEnv = {
    KOKO_STAGE_THREE_ENABLED: "true",
    KOKO_POST_CURSOR_SECRET: "ab".repeat(32),
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
    expect(url.pathname).toBe("/rest/v1/rpc/stage_three_operation");
    expect(new Headers(init?.headers).get("apikey")).toBe(
      env.SUPABASE_SECRET_KEY,
    );
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    calls.push(JSON.parse(String(init?.body)));
    if (value instanceof Error) throw value;
    return value instanceof Response ? value : Response.json(value);
  });
  return { env, calls, fetcher };
}
async function code(response: Response, name: keyof typeof errors) {
  expect(response.status).toBe(errors[name].status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({ code: name });
}
it("atomic RPC receives verified event/actor/target only, ack never returns private RPC data", async () => {
  const f = fixture({
    code: "ok",
    object_key: "secret",
    raw: "private",
    settings: { secret: "never" },
  });
  const response = await handleStageThreeOperations(
    request(),
    f.env,
    f.fetcher,
  );
  expect(response.status).toBe(200);
  const ack = (await response.json()) as { request_id: string };
  expect(Object.keys(ack)).toEqual(["request_id"]);
  expect(ack.request_id).toMatch(/^[a-f0-9-]{36}$/);
  expect(f.calls[0]).toEqual({
    p_event_id: eventId,
    p_user_id: userId,
    p_operation: "report",
    p_target_id: postId,
    p_input: { reason: "privacy" },
    p_request_id: ack.request_id,
  });
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
});
it.each([undefined, "false", "TRUE", "1"])(
  "flag %s stays off before Auth",
  async (flag) => {
    const f = fixture();
    if (flag === undefined) delete f.env.KOKO_STAGE_THREE_ENABLED;
    else f.env.KOKO_STAGE_THREE_ENABLED = flag;
    await code(
      await handleStageThreeOperations(request(), f.env, f.fetcher),
      "NOT_FOUND",
    );
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it.each([
  [`/posts/${postId}`, "DELETE", {}, "delete_own"],
  [`/admin/posts/${postId}/hide`, "POST", action, "hide"],
  [`/admin/posts/${postId}/restore`, "POST", action, "restore"],
  [`/admin/posts/${postId}/delete`, "POST", action, "delete"],
  [`/admin/posts/${postId}/retry`, "POST", action, "retry"],
  [
    `/admin/posts/${postId}/theme`,
    "PATCH",
    { ...action, theme_id: null },
    "reassign_theme",
  ],
  [`/admin/users/${userId}/ban`, "POST", { reason: "x" }, "ban"],
  [`/admin/users/${userId}/unban`, "POST", { reason: "x" }, "unban"],
  ["/appeals", "POST", { message: "Please review", post_id: null }, "appeal"],
  [
    `/admin/appeals/${postId}`,
    "PATCH",
    { status: "resolved", reason: "reviewed" },
    "resolve_appeal",
  ],
  [`/admin/themes/${postId}`, "DELETE", {}, "delete_theme"],
] as const)(
  "routes %s %s into the operation allowlist",
  async (path, method, input, op) => {
    const f = fixture();
    expect(
      (
        await handleStageThreeOperations(
          request(path, method, input),
          f.env,
          f.fetcher,
        )
      ).status,
    ).toBe(200);
    expect(f.calls[0]?.p_operation).toBe(op);
  },
);
it("theme create/update validate exact fields and period before RPC", async () => {
  const body = { ...theme } as Record<string, unknown>;
  delete body.id;
  delete body.event_id;
  const f = fixture();
  expect(
    (
      await handleStageThreeOperations(
        request("/admin/themes", "POST", body),
        f.env,
        f.fetcher,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await handleStageThreeOperations(
        request(`/admin/themes/${postId}`, "PUT", body),
        f.env,
        f.fetcher,
      )
    ).status,
  ).toBe(200);
  await code(
    await handleStageThreeOperations(
      request("/admin/themes", "POST", { ...body, ends_at: body.starts_at }),
      f.env,
      f.fetcher,
    ),
    "INVALID_INPUT",
  );
  expect(f.calls).toHaveLength(2);
});
it.each(["/themes", "/admin/themes"])(
  "%s response strips upstream keys/URLs",
  async (path) => {
    const f = fixture({
      code: "ok",
      items: [{ ...theme, object_key: "private", secret: "private" }],
    });
    expect(
      await (
        await handleStageThreeOperations(request(path, "GET"), f.env, f.fetcher)
      ).json(),
    ).toEqual({ items: [theme] });
  },
);
it("settings returns explicit approval state but writes cannot set it", async () => {
  const f = fixture({
    code: "ok",
    settings: { ...settings, secret: "private", webhook: "private" },
  });
  expect(
    await (
      await handleStageThreeOperations(
        request("/admin/settings", "GET"),
        f.env,
        f.fetcher,
      )
    ).json(),
  ).toEqual(settings);
  await code(
    await handleStageThreeOperations(
      request("/admin/settings", "PUT", settings),
      f.env,
      f.fetcher,
    ),
    "INVALID_INPUT",
  );
  const input = { ...settings } as Record<string, unknown>,
    w = fixture();
  delete input.thresholds_approved;
  expect(
    (
      await handleStageThreeOperations(
        request("/admin/settings", "PUT", input),
        w.env,
        w.fetcher,
      )
    ).status,
  ).toBe(200);
});
it.each([
  ["/themes?limit=1", "GET", {}],
  ["/admin/feed?limit=101", "GET", {}],
  ["/admin/feed?limit=01", "GET", {}],
  ["/admin/feed?user_id=x", "GET", {}],
  ["/admin/feed?limit=1&limit=2", "GET", {}],
  ["/admin/themes?role=admin", "GET", {}],
  ["/posts/no/reports", "POST", { reason: "privacy" }],
  [`/posts/${postId}/reports`, "POST", { reason: "unknown" }],
  [`/posts/${postId}/reports`, "POST", { reason: "privacy", user_id: userId }],
  [
    `/posts/${postId}/reports`,
    "POST",
    { reason: "privacy", detail: "x".repeat(1001) },
  ],
  ["/appeals", "POST", { message: " " }],
  ["/appeals", "POST", { message: "x", post_id: "no" }],
  [`/admin/posts/${postId}/hide`, "POST", { ...action, expected_version: 1.5 }],
  [`/admin/posts/${postId}/theme`, "PATCH", { ...action, theme_id: "no" }],
  [`/admin/appeals/${postId}`, "PATCH", { status: "open", reason: "x" }],
] as const)("invalid %s %s never reaches RPC", async (path, method, input) => {
  const f = fixture();
  await code(
    await handleStageThreeOperations(
      request(path, method, input),
      f.env,
      f.fetcher,
    ),
    "INVALID_INPUT",
  );
  expect(f.calls).toHaveLength(0);
});
it("unknown route and wrong method do not authenticate", async () => {
  const f = fixture();
  await code(
    await handleStageThreeOperations(
      request("/unknown", "GET"),
      f.env,
      f.fetcher,
    ),
    "NOT_FOUND",
  );
  const r = await handleStageThreeOperations(
    request("/themes", "POST", {}),
    f.env,
    f.fetcher,
  );
  expect(r.status).toBe(405);
  expect(r.headers.get("allow")).toBe("GET");
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("cookie writes require matching origin, verified Google and a session/event bound CSRF", async () => {
  const f = fixture();
  f.env.KOKO_WEB_ORIGIN = "https://web.example.test";
  f.env.KOKO_CSRF_SECRET = "cc".repeat(32);
  const auth = {
    mode: "cookie" as const,
    token: "synthetic-token",
    origin: f.env.KOKO_WEB_ORIGIN,
    secret: f.env.KOKO_CSRF_SECRET,
  };
  const req = request();
  req.headers.delete("authorization");
  req.headers.set("cookie", "__Host-koko_session=synthetic-token");
  req.headers.set("Origin", auth.origin);
  await code(
    await handleStageThreeOperations(req.clone(), f.env, f.fetcher),
    "FORBIDDEN",
  );
  req.headers.set("X-CSRF-Token", await createCsrfToken(auth, eventId));
  expect(
    (await handleStageThreeOperations(req.clone(), f.env, f.fetcher)).status,
  ).toBe(200);
  req.headers.set("Origin", "https://untrusted.example.test");
  await code(
    await handleStageThreeOperations(req.clone(), f.env, f.fetcher),
    "FORBIDDEN",
  );
  req.headers.set("authorization", "Bearer synthetic-token");
  await code(
    await handleStageThreeOperations(req, f.env, f.fetcher),
    "AUTH_REQUIRED",
  );
  expect(f.calls).toHaveLength(1);
});
it("expired Auth and non-Google identity never call RPC", async () => {
  for (const auth of [
    new Response(null, { status: 401 }),
    Response.json({
      id: userId,
      app_metadata: { provider: "email", providers: ["email"] },
    }),
  ]) {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(auth);
    expect([401, 403]).toContain(
      (await handleStageThreeOperations(request(), f.env, f.fetcher)).status,
    );
    expect(f.calls).toHaveLength(0);
  }
});
it.each([
  "FORBIDDEN",
  "CONSENT_REQUIRED",
  "ACCOUNT_BANNED",
  "NOT_FOUND",
  "STATE_CONFLICT",
  "PUBLICATION_STOPPED",
  "RATE_LIMITED",
] as const)("maps %s without provider details", async (name) => {
  const f = fixture({ code: name, secret: "private" });
  await code(
    await handleStageThreeOperations(request(), f.env, f.fetcher),
    name,
  );
});
it("admin cursor is purpose/event/user/limit scoped and preserves microsecond priority boundary", async () => {
  const f = fixture({ code: "ok", items: [adminItem], has_more: true });
  const r = await handleStageThreeOperations(
    request("/admin/feed?limit=1", "GET"),
    f.env,
    f.fetcher,
  );
  const first = (await r.json()) as { next_cursor: string; items: unknown[] };
  expect(first.items).toEqual([
    { post, user_id: userId, report_count: 1, is_banned: false },
  ]);
  const next = fixture({ code: "ok", items: [], has_more: false });
  expect(
    (
      await handleStageThreeOperations(
        request(`/admin/feed?limit=1&cursor=${first.next_cursor}`, "GET"),
        next.env,
        next.fetcher,
      )
    ).status,
  ).toBe(200);
  expect(next.calls[0]?.p_input).toEqual({
    limit: 1,
    before_id: postId,
    before_at: post.created_at,
    before_priority: 2,
  });
  for (const path of [
    `/admin/feed?limit=2&cursor=${first.next_cursor}`,
    `/admin/appeals?limit=1&cursor=${first.next_cursor}`,
    `/admin/feed?limit=1&cursor=${first.next_cursor}x`,
  ])
    await code(
      await handleStageThreeOperations(
        request(path, "GET"),
        next.env,
        next.fetcher,
      ),
      "INVALID_CURSOR",
    );
  expect(next.calls).toHaveLength(1);
});

it.each(["review-webp-600", "review-thumbnail"])(
  "admin preview projects only fixed authenticated %s path",
  async (resource) => {
    const f = fixture({
      code: "ok",
      items: [{ ...adminItem, preview_resource: resource, raw_key: "private" }],
      has_more: false,
    });
    const r = await handleStageThreeOperations(
      request("/admin/feed", "GET"),
      f.env,
      f.fetcher,
    );
    expect(r.status).toBe(200);
    const result = (await r.json()) as { items: { preview_url: string }[] };
    expect(result.items[0]?.preview_url).toBe(
      `/media/${eventId}/${postId}/${resource}`,
    );
    expect(JSON.stringify(result)).not.toContain("raw_key");
  },
);
it.each([
  { status: "blocked", block_category: "violence" },
  {
    status: "deleted",
    deletion: { state: "RETENTION_UNKNOWN", retention_until: null },
  },
])("operator safely projects shared state details %#", async (details) => {
  const f = fixture({
    code: "ok",
    items: [
      {
        ...adminItem,
        post: { ...post, ...details, raw_moderation: "private" },
      },
    ],
    has_more: false,
  });
  const r = await handleStageThreeOperations(
    request("/admin/feed", "GET"),
    f.env,
    f.fetcher,
  );
  expect(r.status).toBe(200);
  const value = (await r.json()) as { items: { post: unknown }[] };
  expect(value.items[0]!.post).toEqual({ ...post, ...details });
});
it.each([
  { ...adminItem, preview_resource: "https://external.test/private" },
  { ...adminItem, preview_resource: "review-thumbnail", is_banned: true },
  {
    ...adminItem,
    preview_resource: "review-webp-600",
    post: { ...post, status: "blocked" },
  },
])("reject inconsistent admin preview %#", async (item) => {
  const f = fixture({ code: "ok", items: [item], has_more: false });
  expect(
    (
      await handleStageThreeOperations(
        request("/admin/feed", "GET"),
        f.env,
        f.fetcher,
      )
    ).status,
  ).toBe(500);
});
it("appeal list projects reviewed message only to authenticated operation response", async () => {
  const appeal = {
    id: postId,
    user_id: userId,
    post_id: null,
    message: "Synthetic review",
    status: "open",
    created_at: post.created_at,
  };
  const f = fixture({
    code: "ok",
    items: [{ ...appeal, secret: "private" }],
    has_more: false,
  });
  expect(
    await (
      await handleStageThreeOperations(
        request("/admin/appeals", "GET"),
        f.env,
        f.fetcher,
      )
    ).json(),
  ).toEqual({ items: [appeal], next_cursor: null });
});
it.each([
  null,
  {},
  { code: "mystery", private: "never" },
  { code: "ok", items: [] },
  { code: "ok", items: [adminItem, adminItem], has_more: false },
  { code: "ok", items: [{ ...adminItem, priority: 0 }], has_more: false },
  {
    code: "ok",
    items: [{ ...adminItem, post: { ...post, event_id: userId } }],
    has_more: false,
  },
  {
    code: "ok",
    items: [{ ...adminItem, user_id: "private" }],
    has_more: false,
  },
])("admin feed malformed upstream %j fails closed", async (value) => {
  const f = fixture(value);
  await code(
    await handleStageThreeOperations(
      request("/admin/feed", "GET"),
      f.env,
      f.fetcher,
    ),
    "INTERNAL_ERROR",
  );
});
it.each([
  new Error("private secret"),
  new Response("private", {
    status: 302,
    headers: { location: "https://evil.example.test" },
  }),
  new Response("private", { status: 500 }),
  new Response("<html>private</html>"),
  new Response("x".repeat(1024 * 1024 + 1), {
    headers: { "content-type": "application/json" },
  }),
  new Response("{", { headers: { "content-type": "application/json" } }),
])("upstream error, redirect or unbounded body never leaks", async (value) => {
  const f = fixture(value);
  await code(
    await handleStageThreeOperations(request(), f.env, f.fetcher),
    "INTERNAL_ERROR",
  );
});
it("oversized, invalid JSON, and content encoding writes fail before RPC", async () => {
  const f = fixture();
  for (const [body, encoding] of [
    ["x".repeat(32769), ""],
    ["{", ""],
    ['{"reason":"privacy"}', "gzip"],
  ]) {
    const req = request();
    const headers = new Headers(req.headers);
    if (encoding) headers.set("content-encoding", encoding);
    await code(
      await handleStageThreeOperations(
        new Request(req.url, { method: "POST", headers, body: body! }),
        f.env,
        f.fetcher,
      ),
      "INVALID_INPUT",
    );
  }
  expect(f.calls).toHaveLength(0);
});
it("deadline cancels an upstream response body without a successful ack", async () => {
  vi.useFakeTimers();
  try {
    const cancel = vi.fn(),
      f = fixture(
        new Response(new ReadableStream({ cancel }), {
          headers: { "content-type": "application/json" },
        }),
      );
    const pending = handleStageThreeOperations(request(), f.env, f.fetcher);
    await vi.advanceTimersByTimeAsync(10_000);
    await code(await pending, "INTERNAL_ERROR");
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
