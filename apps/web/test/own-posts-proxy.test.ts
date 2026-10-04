import { afterEach, expect, it, vi } from "vitest";
import { handleOwnPostsProxy } from "../src/api/own-posts-proxy";
import { cursor, eventId, origin, page, post } from "./own-posts-fixture";

const generation = `22222222-2222-4222-8222-222222222222.${"a".repeat(64)}`;
const cookie = `__Host-koko_generation=${generation}; __Host-koko_session=v1.${generation}.synthetic.access.signature`;
const config = {
  KOKO_API_PROXY_ENABLED: "true",
  KOKO_API_COOKIE_ENABLED: "true",
  KOKO_OWN_POSTS_PROXY_ENABLED: "true",
  KOKO_WEB_ORIGIN: origin,
  KOKO_API_UPSTREAM_ORIGIN: "https://koko-api-dev.arcer-jp.workers.dev",
  KOKO_API_ACCESS_CLIENT_ID: "synthetic-service-id-only",
  KOKO_API_ACCESS_CLIENT_SECRET: "synthetic-service-secret-only",
};
function request(path = "me/posts", headers = {}, method = "GET") {
  return new Request(`${origin}/api/${path}`, {
    method,
    headers: {
      Cookie: cookie,
      "X-Event-ID": eventId,
      "Sec-Fetch-Site": "same-origin",
      ...headers,
    },
  });
}
afterEach(() => vi.useRealTimers());
it.each([false, true])(
  "forwards only the canonical owner read, status=%s",
  async (status) => {
    const output = status ? post() : page();
    const path = status
      ? `posts/${post().id}/status`
      : `me/posts?cursor=${cursor}&limit=30`;
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(
        { ...output, internal: "discard" },
        {
          headers: {
            "Set-Cookie": "secret=discard",
            Location: "https://evil.test",
            "Access-Control-Allow-Origin": "*",
          },
        },
      ),
    );
    const response = await handleOwnPostsProxy(
      request(path, {
        "CF-Access-Client-Secret": "attacker",
        Cookie: `${cookie}; CF_Authorization=extra; sb-test=extra`,
      }),
      config,
      fetcher,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(output);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("location")).toBe(false);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    const [target, init] = fetcher.mock.calls[0]!;
    expect(String(target)).toBe(
      `${config.KOKO_API_UPSTREAM_ORIGIN}/${status ? path : `me/posts?limit=30&cursor=${cursor}`}`,
    );
    expect(init).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      cache: "no-store",
    });
    expect(init?.body).toBeUndefined();
    const h = new Headers(init?.headers);
    expect(h.get("cookie")).toBe(
      "__Host-koko_session=synthetic.access.signature",
    );
    expect(h.get("CF-Access-Client-Secret")).toBe(
      config.KOKO_API_ACCESS_CLIENT_SECRET,
    );
    expect(h.has("authorization")).toBe(false);
    expect(h.has("x-csrf-token")).toBe(false);
  },
);
it.each(Object.keys(config))("fails closed without %s", async (key) => {
  const fetcher = vi.fn<typeof fetch>();
  const response = await handleOwnPostsProxy(
    request(),
    { ...config, [key]: "" },
    fetcher,
  );
  expect(response.status).toBe(
    key === "KOKO_OWN_POSTS_PROXY_ENABLED" ? 404 : 500,
  );
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  "me/posts?limit=0",
  "me/posts?limit=101",
  "me/posts?limit=1.1",
  "me/posts?limit=01",
  "me/posts?limit=1&limit=1",
  "me/posts?cursor=bad",
  `me/posts?cursor=${cursor}&cursor=${cursor}`,
  "me/posts?user_id=other",
  "me/posts?upstream=https://evil.test",
  "posts/bad/status",
  `posts/${post().id}/status?limit=30`,
  "me/posts/extra",
])("rejects unallowlisted input %s", async (path) => {
  const fetcher = vi.fn<typeof fetch>();
  expect(
    (await handleOwnPostsProxy(request(path), config, fetcher)).status,
  ).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"])(
  "never sends method %s",
  async (method) => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await handleOwnPostsProxy(
      request("me/posts", {}, method),
      config,
      fetcher,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it.each([
  [{ Cookie: "" }, 401],
  [{ Cookie: "__Host-koko_session=synthetic.access.signature" }, 401],
  [{ Origin: "https://evil.test" }, 403],
  [{ "Sec-Fetch-Site": "cross-site" }, 403],
  [{ "X-Event-ID": "bad" }, 400],
  [{ "Content-Encoding": "gzip" }, 400],
] as const)("rejects unsafe boundary %j", async (headers, code) => {
  const fetcher = vi.fn<typeof fetch>();
  expect(
    (await handleOwnPostsProxy(request("me/posts", headers), config, fetcher))
      .status,
  ).toBe(code);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["redirect", "html", "large", "credentials", "invalid", "network"])(
  "fails closed without leaking upstream %s",
  async (kind) => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (kind === "network") throw new Error("private network error");
      if (kind === "redirect")
        return new Response(null, {
          status: 302,
          headers: { Location: "https://evil.test" },
        });
      if (kind === "html")
        return new Response("private HTML", {
          headers: { "Content-Type": "text/html" },
        });
      if (kind === "large")
        return Response.json({ ...page(), unused: "x".repeat(256 * 1024) });
      if (kind === "credentials")
        return Response.json({
          ...page(),
          unused: config.KOKO_API_ACCESS_CLIENT_SECRET,
        });
      return Response.json({
        items: [post(1, { event_id: post(3).id })],
        next_cursor: null,
      });
    });
    const response = await handleOwnPostsProxy(request(), config, fetcher);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toMatch(/private|service-secret|evil/);
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it("preserves safe cursor expiry and owner-not-found errors without retrying", async () => {
  for (const [code, status] of [
    ["INVALID_CURSOR", 400],
    ["NOT_FOUND", 404],
  ] as const) {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(
        { code, request_id: post().id, raw: "discard" },
        { status },
      ),
    );
    const response = await handleOwnPostsProxy(request(), config, fetcher);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code, request_id: post().id });
    expect(fetcher).toHaveBeenCalledOnce();
  }
});
it("bounds an uncooperative fetch and aborts it", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
  const result = handleOwnPostsProxy(request(), config, fetcher);
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await result).status).toBe(500);
  expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});
