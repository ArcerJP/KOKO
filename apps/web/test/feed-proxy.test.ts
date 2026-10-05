import { expect, it, vi } from "vitest";
import { handleFeedProxy } from "../src/api/feed-proxy";
import {
  cursor,
  eventId,
  feedPage,
  id,
  publicPost,
  theme,
} from "./feed-fixture";
const origin = "https://web.test",
  generation = `${id(2)}.${"a".repeat(64)}`,
  cookie = `__Host-koko_generation=${generation}; __Host-koko_session=v1.${generation}.synthetic.access.signature`;
const config = {
  KOKO_PUBLIC_FEED_ENABLED: "true",
  KOKO_API_PROXY_ENABLED: "true",
  KOKO_API_COOKIE_ENABLED: "true",
  KOKO_WEB_ORIGIN: origin,
  KOKO_API_UPSTREAM_ORIGIN: "https://koko-api-dev.arcer-jp.workers.dev",
  KOKO_API_ACCESS_CLIENT_ID: "synthetic-id",
  KOKO_API_ACCESS_CLIENT_SECRET: "synthetic-secret",
};
const request = (path = "feed", headers = {}, method = "GET") =>
  new Request(`${origin}/api/${path}`, {
    method,
    headers: {
      cookie,
      "x-event-id": eventId,
      "sec-fetch-site": "same-origin",
      ...headers,
    },
  });
it.each(["", "false"])(
  "defaults closed without upstream %s",
  async (enabled) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      (
        await handleFeedProxy(
          request(),
          { ...config, KOKO_PUBLIC_FEED_ENABLED: enabled },
          fetcher,
        )
      ).status,
    ).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it.each([
  "feed?theme_id=x",
  "feed?limit=01",
  "feed?limit=101",
  "feed?limit=30&limit=30",
  "feed?cursor=bad",
  "feed?theme=x",
  "posts/x",
  `posts/${id(100)}?x=1`,
  "themes",
])("rejects non-contract path/query %s", async (path) => {
  const fetcher = vi.fn<typeof fetch>();
  expect((await handleFeedProxy(request(path), config, fetcher)).status).toBe(
    400,
  );
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([false, true])(
  "forwards only canonical feed or one post, post=%s",
  async (single) => {
    const payload = single ? publicPost() : feedPage();
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(
        { ...payload, internal: "discard" },
        {
          headers: {
            "set-cookie": "secret=discard",
            location: "https://evil.test",
          },
        },
      ),
    );
    const response = await handleFeedProxy(
      request(single ? `posts/${id(100)}` : `feed?cursor=${cursor}&limit=30`, {
        "CF-Access-Client-Secret": "attacker",
      }),
      config,
      fetcher,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("location")).toBe(false);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const [target, init] = fetcher.mock.calls[0]!;
    expect(String(target)).toBe(
      `${config.KOKO_API_UPSTREAM_ORIGIN}/${single ? `posts/${id(100)}` : `feed?limit=30&cursor=${cursor}`}`,
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toBe(
      "__Host-koko_session=synthetic.access.signature",
    );
    expect(headers.get("CF-Access-Client-Secret")).toBe(
      config.KOKO_API_ACCESS_CLIENT_SECRET,
    );
    expect(headers.has("authorization")).toBe(false);
  },
);
it("translates filter exactly without permitting browser-supplied target", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      items: [{ ...publicPost(), theme_id: theme }],
      next_cursor: null,
    }),
  );
  expect(
    (await handleFeedProxy(request(`feed?theme=${theme}`), config, fetcher))
      .status,
  ).toBe(200);
  expect(String(fetcher.mock.calls[0]?.[0])).toBe(
    `${config.KOKO_API_UPSTREAM_ORIGIN}/feed?limit=30&theme=${theme}`,
  );
});
it.each([
  { cookie: "" },
  { "sec-fetch-site": "cross-site" },
  { "x-event-id": "bad" },
  { authorization: "bearer injected" },
])("blocks missing/unsafe session context %j", async (headers) => {
  const fetcher = vi.fn<typeof fetch>();
  const r = await handleFeedProxy(request("feed", headers), config, fetcher);
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(fetcher).not.toHaveBeenCalled();
});
it("GET-only endpoint never posts upstream", async () => {
  const fetcher = vi.fn<typeof fetch>();
  expect(
    (await handleFeedProxy(request("feed", {}, "POST"), config, fetcher))
      .status,
  ).toBeGreaterThanOrEqual(400);
  expect(fetcher).not.toHaveBeenCalled();
});
