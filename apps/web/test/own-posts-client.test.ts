import { afterEach, expect, it, vi } from "vitest";
import { postStates } from "@koko/contract";
import { createApiClient } from "../src/api/client";
import {
  parseOwnPost,
  parseOwnPostsPage,
  type OwnPostsQuery,
} from "../src/api/own-posts-contract";
import { cursor, eventId, origin, page, post } from "./own-posts-fixture";

afterEach(() => vi.unstubAllGlobals());
it("uses fixed same-origin GETs, normalized IDs, canonical pagination and safe projections", async () => {
  const id = "abcdefab-0000-4000-8000-000000000001";
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ ...page(), private: "discard" }))
    .mockResolvedValueOnce(
      Response.json({
        ...post(1, { id }),
        block_category: "RAW",
        signed_url: "discard",
      }),
    );
  const client = createApiClient(new URL(`${origin}/api/`), eventId, fetcher);
  expect(await client.listOwnPosts({ cursor })).toEqual(page());
  expect(await client.getPostStatus(id.toUpperCase())).toEqual(post(1, { id }));
  expect(String(fetcher.mock.calls[0]![0])).toBe(
    `${origin}/api/me/posts?limit=30&cursor=${cursor}`,
  );
  expect(String(fetcher.mock.calls[1]![0])).toBe(
    `${origin}/api/posts/${id}/status`,
  );
  for (const [, init] of fetcher.mock.calls) {
    expect(init).toMatchObject({
      method: "GET",
      mode: "same-origin",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
    });
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("X-Event-ID")).toBe(eventId);
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
  }
});
it.each([
  null,
  [],
  { limit: null },
  { limit: 0 },
  { limit: 101 },
  { limit: 1.5 },
  { limit: "30" },
  { cursor: "" },
  { cursor: "https://evil.test" },
  { cursor: `x.${"a".repeat(1000)}` },
  { user_id: post().id },
])("rejects malformed query before sending %j", async (query) => {
  const fetcher = vi.fn<typeof fetch>();
  const client = createApiClient(new URL(`${origin}/api/`), eventId, fetcher);
  await expect(
    client.listOwnPosts(query as OwnPostsQuery),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["../me", "bad", `${post().id}?user_id=x`])(
  "rejects malformed post id %s",
  async (id) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      createApiClient(
        new URL(`${origin}/api/`),
        eventId,
        fetcher,
      ).getPostStatus(id),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it.each(postStates)("projects state %s without internal fields", (status) => {
  const item = post(1, { status });
  expect(
    parseOwnPost(
      { ...item, block_category: "private", provider_error: "private" },
      eventId,
    ),
  ).toEqual(item);
});
it.each([
  null,
  {},
  { id: "bad" },
  { event_id: post(2).id },
  { status: "future" },
  { version: 0 },
  { version: 1.2 },
  { created_at: "2026-02-30T00:00:00Z" },
  { error_code: "arbitrary reason" },
  { error_code: "INTERNAL_ERROR" },
])("rejects invalid status response %j", (change) => {
  const value =
    change === null || Object.keys(change).length === 0
      ? change
      : { ...post(), ...change };
  expect(parseOwnPost(value, eventId)).toBeNull();
});
it.each([
  "UNSUPPORTED_MEDIA",
  "VIDEO_TOO_LONG",
  "PROVIDER_LIMIT",
  "UPLOAD_EXPIRED",
  "UPLOAD_INCOMPLETE",
  "INTERNAL_ERROR",
  "PROCESSING_HELD",
  "CONTENT_BLOCKED",
] as const)("permits only safe reason %s", (error_code) => {
  const item = post(1, { status: "held", error_code });
  expect(parseOwnPost(item, eventId)).toEqual(item);
});
it("rejects wrong post IDs and malformed, unordered, duplicate or oversized pages", () => {
  expect(parseOwnPost(post(), eventId, post(2).id)).toBeNull();
  for (const value of [
    null,
    {},
    { items: [], next_cursor: cursor },
    { items: [post()], next_cursor: "bad" },
    { items: [post(), post()], next_cursor: null },
    { items: [post(2), post(1)], next_cursor: null },
    page(1, 31),
  ])
    expect(parseOwnPostsPage(value, eventId, 30)).toBeNull();
  expect(parseOwnPostsPage(page(1, 0, null), eventId, 30)).toEqual(
    page(1, 0, null),
  );
});
it("preserves microsecond ordering instead of collapsing timestamps to Date milliseconds", () => {
  const value = {
    items: [
      post(1, { created_at: "2026-10-05T00:00:00.123456Z" }),
      post(2, { created_at: "2026-10-05T00:00:00.123455Z" }),
    ],
    next_cursor: null,
  };
  expect(parseOwnPostsPage(value, eventId, 30)).toEqual(value);
  expect(
    parseOwnPostsPage(
      { ...value, items: [...value.items].reverse() },
      eventId,
      30,
    ),
  ).toBeNull();
});
it("honors error envelopes, abort and same-origin checks", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json(
        { code: "INVALID_CURSOR", request_id: post().id },
        { status: 400 },
      ),
    );
  const client = createApiClient(new URL(`${origin}/api/`), eventId, fetcher);
  await expect(client.listOwnPosts()).rejects.toMatchObject({
    code: "INVALID_CURSOR",
  });
  await expect(
    client.listOwnPosts({}, AbortSignal.abort()),
  ).rejects.toMatchObject({ name: "AbortError" });
  vi.stubGlobal("location", { origin: "https://other.example.test" });
  await expect(client.listOwnPosts()).rejects.toThrow("同一origin");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
