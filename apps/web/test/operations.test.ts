import { describe, expect, it, vi } from "vitest";
import {
  createOperationsClient,
  operationPayload,
} from "../src/api/operations-client";
import {
  operationInput,
  operationResponse,
  operationRoute,
  type Operation,
} from "../src/api/operations-contract";
import { createOperationsController } from "../src/api/operations-controller";
import { handleOperationsProxy } from "../src/api/operations-proxy";
import type { Me } from "../src/api/client";
const event = "22222222-2222-4222-8222-222222222222",
  user = "11111111-1111-4111-8111-111111111111";
const post = "33333333-3333-4333-8333-333333333333",
  origin = "https://web.example.test";
const csrf = "synthetic-operations-csrf-token-only";
const me: Me = {
  event_id: event,
  user_id: user,
  display_name: "試験",
  role: "admin",
  is_banned: false,
  consent_required: false,
  terms_version: "test",
  crown: "none",
  csrf_token: csrf,
};
const ack = { request_id: post };
const theme = {
  id: post,
  event_id: event,
  title: "お題",
  description: "説明",
  icon: "花",
  color: "#4338ca",
  status: "published",
  starts_at: "2026-10-01T00:00:00Z",
  ends_at: "2026-10-30T00:00:00Z",
};
const themeInput = Object.fromEntries(
  Object.entries(theme).filter(([k]) => !["id", "event_id"].includes(k)),
);
const settings = {
  version: 1,
  publication_stopped: true,
  uploads_enabled: false,
  moderation_concurrency: 1,
  thresholds: [],
  thresholds_approved: false,
};
const config = {
  KOKO_STAGE_THREE_ENABLED: "true",
  KOKO_API_COOKIE_ENABLED: "true",
  KOKO_API_PROXY_ENABLED: "true",
  KOKO_WEB_ORIGIN: origin,
  KOKO_API_UPSTREAM_ORIGIN: "https://koko-api-dev.arcer-jp.workers.dev",
  KOKO_API_ACCESS_CLIENT_ID: "synthetic-access-id-only",
  KOKO_API_ACCESS_CLIENT_SECRET: "synthetic-access-secret-only",
};
const generation = `${event}.${"a".repeat(64)}`;
const cookie = `__Host-koko_generation=${generation}; __Host-koko_session=v1.${generation}.synthetic.access.signature`;
const req = (path: string, method = "GET", input?: unknown, headers = {}) =>
  new Request(origin + "/api/" + path, {
    method,
    headers: {
      origin,
      cookie,
      "x-event-id": event,
      "x-csrf-token": csrf,
      "content-type": "application/json",
      ...headers,
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });

describe("stage three client contract", () => {
  const actions: [Operation, unknown, string, string][] = [
    [
      { name: "report", id: post },
      { reason: "privacy", detail: "試験" },
      `posts/${post}/reports`,
      "POST",
    ],
    [
      { name: "appeal" },
      { message: "確認依頼", post_id: post },
      "appeals",
      "POST",
    ],
    [{ name: "deleteOwn", id: post }, {}, `posts/${post}`, "DELETE"],
    ...(["hide", "restore", "deletePost", "retry"] as const).map(
      (name): [Operation, unknown, string, string] => [
        { name, id: post },
        { expected_version: 1, reason: "運営確認" },
        `admin/posts/${post}/${name === "deletePost" ? "delete" : name}`,
        "POST",
      ],
    ),
    [
      { name: "reassignTheme", id: post },
      { expected_version: 1, reason: "確認", theme_id: null },
      `admin/posts/${post}/theme`,
      "PATCH",
    ],
    ...(["ban", "unban"] as const).map(
      (name): [Operation, unknown, string, string] => [
        { name, id: user },
        { reason: "確認" },
        `admin/users/${user}/${name}`,
        "POST",
      ],
    ),
    [{ name: "createTheme" }, themeInput, "admin/themes", "POST"],
    [
      { name: "updateTheme", id: post },
      themeInput,
      `admin/themes/${post}`,
      "PUT",
    ],
    [{ name: "deleteTheme", id: post }, {}, `admin/themes/${post}`, "DELETE"],
    [
      { name: "resolveAppeal", id: post },
      { status: "resolved", reason: "確認済み" },
      `admin/appeals/${post}`,
      "PATCH",
    ],
    [
      { name: "updateSettings" },
      { ...settings, thresholds_approved: undefined },
      "admin/settings",
      "PUT",
    ],
  ];
  it.each(actions.filter(([op]) => op.name !== "updateSettings"))(
    "allowlisted write %#",
    async (op, input, path, method) => {
      const f = vi.fn<typeof fetch>(async () =>
        Response.json({ ...ack, secret: "not-returned" }),
      );
      const c = createOperationsClient(new URL(origin + "/api/"), event, f);
      expect(operationPayload(await c.execute(op, input, csrf))).toEqual(ack);
      expect(String(f.mock.calls[0]![0])).toBe(origin + "/api/" + path);
      expect(f.mock.calls[0]![1]).toMatchObject({
        method,
        mode: "same-origin",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
      expect(JSON.parse(f.mock.calls[0]![1]!.body as string)).toEqual(input);
    },
  );
  it("settings reads approval but writes cannot approve", () => {
    expect(operationResponse({ name: "settings" }, settings, event)).toEqual({
      kind: "settings",
      settings,
    });
    expect(() =>
      operationInput({ name: "updateSettings" }, settings),
    ).toThrow();
    const { thresholds_approved: _approved, ...input } = settings;
    expect(operationInput({ name: "updateSettings" }, input)).toEqual(input);
  });
  it("themes strictly project text, dates, IDs without extra server data", () => {
    expect(
      operationResponse(
        { name: "themes" },
        { items: [{ ...theme, email: "never-return" }] },
        event,
      ),
    ).toEqual({ kind: "themes", items: [theme] });
    for (const changed of [
      { event_id: user },
      { status: "draft" },
      { color: "url(https://bad.test)" },
      { ends_at: "bad" },
    ])
      expect(() =>
        operationResponse(
          { name: "themes" },
          { items: [{ ...theme, ...changed }] },
          event,
        ),
      ).toThrow();
  });
  it("admin response cannot expose arbitrary preview URL", () => {
    const row = {
      user_id: user,
      report_count: 1,
      is_banned: false,
      post: {
        id: post,
        event_id: event,
        status: "hidden",
        version: 2,
        created_at: "2026-10-06T00:00:00Z",
      },
    };
    expect(
      operationResponse(
        { name: "adminFeed" },
        { items: [row], next_cursor: null },
        event,
      ).kind,
    ).toBe("posts");
    expect(() =>
      operationResponse(
        { name: "adminFeed" },
        {
          items: [{ ...row, preview_url: "https://upstream.test/token" }],
          next_cursor: null,
        },
        event,
      ),
    ).toThrow();
    expect(() =>
      operationResponse(
        { name: "adminFeed" },
        { items: [row, row], next_cursor: null },
        event,
      ),
    ).toThrow();
  });
  it.each([
    { name: "__proto__" },
    { name: "themes", id: post },
    { name: "report", id: "../x" },
    { name: "themes", cursor: "x.y" },
    { name: "adminFeed", cursor: "https://host" },
    { name: "themes", url: origin },
  ])("rejects arbitrary route %#", (op) => {
    expect(() => operationRoute(op as Operation)).toThrow();
  });
  it.each([
    [{ name: "report", id: post }, { reason: "unknown" }],
    [
      { name: "hide", id: post },
      { expected_version: 0, reason: "x" },
    ],
    [
      { name: "ban", id: user },
      { reason: " ", role: "admin" },
    ],
    [{ name: "appeal" }, { message: "x".repeat(2001) }],
    [{ name: "deleteOwn", id: post }, { force: true }],
  ])("bad input never fetches %#", async (op, input) => {
    const f = vi.fn<typeof fetch>();
    const c = createOperationsClient(new URL(origin + "/api/"), event, f);
    await expect(c.execute(op as Operation, input, csrf)).rejects.toMatchObject(
      { code: "INVALID_INPUT" },
    );
    expect(f).not.toHaveBeenCalled();
  });
  it.each([
    () => new Response("redirect", { status: 302 }),
    () => new Response("raw upstream failure"),
    () => Response.json({ ...ack, secret: "x" }, { status: 201 }),
    () => Response.json({ items: [], next_cursor: "bad" }),
    () => Response.json({ items: [], unexpected: "x".repeat(262144) }),
  ])("invalid upstream fails closed %#", async (response) => {
    const c = createOperationsClient(
      new URL(origin + "/api/"),
      event,
      async () => response(),
    );
    await expect(c.execute({ name: "adminFeed" })).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });
});

describe("stage three same-origin proxy", () => {
  it("is disabled without reading credentials or fetching", async () => {
    const f = vi.fn<typeof fetch>();
    const response = await handleOperationsProxy(req("themes"), {}, f);
    expect(response.status).toBe(404);
    expect(f).not.toHaveBeenCalled();
  });
  it("uses fixed upstream, rebuilt credential headers and sanitized response", async () => {
    const f = vi.fn<typeof fetch>(async () =>
      Response.json({ items: [{ ...theme, secret: "private" }] }),
    );
    const r = await handleOperationsProxy(req("themes"), config, f);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ items: [theme] });
    expect(String(f.mock.calls[0]![0])).toBe(
      config.KOKO_API_UPSTREAM_ORIGIN + "/themes",
    );
    const h = new Headers(f.mock.calls[0]![1]!.headers);
    expect(h.get("cf-access-client-secret")).toBe(
      config.KOKO_API_ACCESS_CLIENT_SECRET,
    );
    expect(h.get("authorization")).toBeNull();
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });
  it.each([
    "admin/feed?limit=30&limit=30",
    "admin/feed?limit=100",
    "themes?url=https://bad.test",
    "anything",
    `admin/users/${user}/role`,
  ])("unknown path/query not forwarded: %s", async (path) => {
    const f = vi.fn<typeof fetch>();
    expect(
      (await handleOperationsProxy(req(path), config, f)).status,
    ).toBeGreaterThanOrEqual(400);
    expect(f).not.toHaveBeenCalled();
  });
  it.each([
    { origin: "https://bad.test" },
    { cookie: "" },
    { authorization: "Bearer unexpected" },
    { "sec-fetch-site": "cross-site" },
  ])("rejects hostile transport %#", async (headers) => {
    const f = vi.fn<typeof fetch>();
    expect(
      (
        await handleOperationsProxy(
          req("themes", "GET", undefined, headers),
          config,
          f,
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(f).not.toHaveBeenCalled();
  });
  it("mutation passes projected body and csrf without forwarding arbitrary header", async () => {
    const f = vi.fn<typeof fetch>(async () => Response.json(ack));
    const response = await handleOperationsProxy(
      req(
        `posts/${post}/reports`,
        "POST",
        { reason: "privacy" },
        { "cf-access-client-secret": "untrusted" },
      ),
      config,
      f,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(ack);
    expect(new Headers(f.mock.calls[0]![1]!.headers).get("x-csrf-token")).toBe(
      csrf,
    );
  });
  it("upstream reflected credential not returned", async () => {
    const response = await handleOperationsProxy(
      req("themes"),
      config,
      async () =>
        Response.json({
          items: [{ ...theme, title: config.KOKO_API_ACCESS_CLIENT_SECRET }],
        }),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(
      config.KOKO_API_ACCESS_CLIENT_SECRET,
    );
  });
});

describe("stage three operation session controller", () => {
  function setup() {
    const getMe = vi.fn(async () => ({ ...me }));
    const execute = vi.fn(async (op: Operation) =>
      op.name === "themes"
        ? { kind: "themes" as const, items: [] }
        : { kind: "ack" as const, ...ack },
    );
    const prepare = vi.fn(async () => true);
    const c = createOperationsController({ getMe, execute }, prepare);
    return { c, getMe, execute, prepare };
  }
  it("BAN and consent-pending bootstrap does not require public themes access", async () => {
    const { c, getMe, execute } = setup();
    getMe.mockResolvedValue({ ...me, is_banned: true, consent_required: true });
    expect(await c.bootstrap()).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(c.getSnapshot()).toMatchObject({ phase: "ready", data: null });
    expect(await c.mutate({ name: "appeal" }, { message: "確認" }, true)).toBe(
      true,
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("requires fresh read and explicit confirmation for every mutation", async () => {
    const { c, getMe, execute } = setup();
    expect(
      await c.mutate({ name: "report", id: post }, { reason: "privacy" }, true),
    ).toBe(false);
    await c.load({ name: "themes" });
    expect(
      await c.mutate(
        { name: "report", id: post },
        { reason: "privacy" },
        false,
      ),
    ).toBe(false);
    expect(
      await c.mutate({ name: "report", id: post }, { reason: "privacy" }, true),
    ).toBe(true);
    expect(getMe).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(c.getSnapshot())).not.toContain(csrf);
    expect(JSON.stringify(c.getSnapshot())).not.toContain(user);
  });
  it.each([
    { user_id: post },
    { event_id: post },
    { role: "user" as const },
    { csrf_token: undefined },
  ])("fresh changed identity cannot write %#", async (change) => {
    const { c, getMe, execute } = setup();
    await c.load({ name: "themes" });
    const fresh = { ...me, ...change };
    if (fresh.csrf_token === undefined) delete fresh.csrf_token;
    getMe.mockResolvedValue(fresh as Me);
    expect(
      await c.mutate({ name: "ban", id: post }, { reason: "確認" }, true),
    ).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().data).toBeNull();
  });
  it("ambiguous write never retries and requires re-read", async () => {
    const { c, execute } = setup();
    await c.load({ name: "themes" });
    execute.mockRejectedValueOnce(new Error("secret"));
    expect(await c.mutate({ name: "deleteOwn", id: post }, {}, true)).toBe(
      false,
    );
    expect(await c.mutate({ name: "deleteOwn", id: post }, {}, true)).toBe(
      false,
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(c.getSnapshot())).not.toContain("secret");
  });
  it("logout prevents late read and resets snapshots", async () => {
    const { c, getMe, execute } = setup();
    let finish!: (x: Me) => void;
    getMe.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const task = c.load({ name: "themes" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    c.close();
    finish(me);
    expect(await task).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(c.getSnapshot()).toMatchObject({
      phase: "closed",
      data: null,
      role: null,
    });
  });
});
