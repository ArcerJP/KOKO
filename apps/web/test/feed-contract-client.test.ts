import { expect, it, vi } from "vitest";
import { createFeedClient } from "../src/api/feed-client";
import {
  feedSearch,
  parseFeedPage,
  parsePublicPost,
} from "../src/api/feed-contract";
import {
  cursor,
  eventId,
  feedPage,
  id,
  publicPost,
  theme,
} from "./feed-fixture";
it("canonicalizes allowed query without adding unsigned filter fields", () => {
  expect(feedSearch({ limit: 30, theme, cursor })).toBe(
    `?limit=30&theme=${theme}&cursor=${cursor}`,
  );
});
it.each([
  { limit: 0 },
  { limit: 101 },
  { limit: 1.1 },
  { theme: "anything" },
  { cursor: "abc" },
  { cursor: "a".repeat(1501) },
  { theme_id: theme },
])("rejects invalid query %j", (input) => expect(feedSearch(input)).toBeNull());
it.each([false, true])("positive-projects safe post (video %s)", (video) => {
  const post = publicPost(100, video);
  expect(
    parsePublicPost(
      {
        ...post,
        user_id: "hidden",
        original_key: "private",
        media: { ...post.media, stream_uid: "hidden" },
      },
      eventId,
    ),
  ).toEqual(post);
});
it.each([
  { event_id: id(999) },
  { id: "not-uuid" },
  { crown: "gold" },
  { like_count: 1 },
  { display_name: "" },
  { theme_id: "x" },
  { theme_name: undefined },
  { theme_name: "x", theme_id: null },
  { theme_name: "", theme_id: theme },
  { theme_name: "x".repeat(101), theme_id: theme },
  { created_at: "2026-02-30T00:00:00Z" },
  { created_at: "bad" },
  { media: { ...publicPost().media, webp_600: "https://cdn.test/a" } },
  {
    media: {
      ...publicPost().media,
      webp_600: `/media/${eventId}/${id(100)}/webp-600?token=bad`,
    },
  },
  { kind: "video" },
])("rejects untrusted post field %j", (patch) =>
  expect(parsePublicPost({ ...publicPost(), ...patch }, eventId)).toBeNull(),
);
it.each([0, -1, 4.1, Infinity, NaN])(
  "rejects video duration %s",
  (duration_seconds) =>
    expect(
      parsePublicPost(
        {
          ...publicPost(100, true),
          media: { ...publicPost(100, true).media, duration_seconds },
        },
        eventId,
      ),
    ).toBeNull(),
);
it("rejects public MP4, cross-post media, and mismatched id", () => {
  const video = publicPost(100, true);
  expect(
    parsePublicPost(
      { ...video, media: { ...video.media, mp4_url: "/media/x" } },
      eventId,
    ),
  ).toBeNull();
  expect(
    parsePublicPost(
      {
        ...video,
        media: { ...video.media, hls_url: `/media/${eventId}/${id(101)}/hls` },
      },
      eventId,
    ),
  ).toBeNull();
  expect(parsePublicPost(video, eventId, id(101))).toBeNull();
});
it("checks page order, uniqueness, cursor/full size, theme and empty pages", () => {
  expect(parseFeedPage(feedPage(), eventId, {})).toEqual(feedPage());
  expect(parseFeedPage({ items: [], next_cursor: null }, eventId, {})).toEqual({
    items: [],
    next_cursor: null,
  });
  for (const value of [
    { items: [publicPost(), publicPost()], next_cursor: null },
    { items: [publicPost(99), publicPost(100)], next_cursor: null },
    feedPage(100, 3, cursor),
  ])
    expect(parseFeedPage(value, eventId, {})).toBeNull();
  expect(parseFeedPage(feedPage(), eventId, { limit: 2 })).toBeNull();
  expect(parseFeedPage(feedPage(), eventId, { theme })).toBeNull();
  expect(
    parseFeedPage({ ...feedPage(100, 30, cursor) }, eventId, {}),
  ).not.toBeNull();
});
it("client requests only same-origin credentialed reads and validates DTO", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(feedPage()));
  const client = createFeedClient(
    new URL("https://web.test/api/"),
    eventId,
    fetcher,
  );
  expect(await client.list()).toEqual(feedPage());
  expect(String(fetcher.mock.calls[0]![0])).toBe(
    "https://web.test/api/feed?limit=30",
  );
  expect(fetcher.mock.calls[0]![1]).toMatchObject({
    method: "GET",
    mode: "same-origin",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
  });
  expect(
    new Headers(fetcher.mock.calls[0]![1]?.headers).get("x-event-id"),
  ).toBe(eventId);
});
it.each([
  "http://public.test/api/",
  "https://user:pass@web.test/api/",
  "https://web.test/api/?x=y",
  "https://web.test/api",
])("rejects unsafe base %s", (base) =>
  expect(() => createFeedClient(new URL(base), eventId)).toThrow(
    "INVALID_FEED_CONFIG",
  ),
);
it("does not fetch invalid query or id", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const client = createFeedClient(
    new URL("https://web.test/api/"),
    eventId,
    fetcher,
  );
  await expect(client.list({ cursor: "bad" })).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  await expect(client.post("x")).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  () => new Response("secret", { headers: { "content-type": "text/plain" } }),
  () =>
    Response.json({
      ...feedPage(),
      items: [{ ...publicPost(), event_id: id(3) }],
    }),
  () =>
    new Response("x".repeat(262145), {
      headers: { "content-type": "application/json" },
    }),
  () =>
    new Response(new Uint8Array([255]), {
      headers: { "content-type": "application/json" },
    }),
])(
  "rejects malformed or oversized output without exposing it",
  async (response) => {
    await expect(
      createFeedClient(new URL("https://web.test/api/"), eventId, async () =>
        response(),
      ).list(),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  },
);
it("sanitizes server errors and aborts a stalled body", async () => {
  const client = createFeedClient(
    new URL("https://web.test/api/"),
    eventId,
    async () =>
      Response.json(
        { code: "NOT_FOUND", request_id: id(1), secret: "never" },
        { status: 404 },
      ),
  );
  await expect(client.post(id(100))).rejects.toMatchObject({
    code: "NOT_FOUND",
    requestId: id(1),
  });
  const abort = new AbortController(),
    cancel = vi.fn();
  const stalled = createFeedClient(
    new URL("https://web.test/api/"),
    eventId,
    async () =>
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "application/json" },
      }),
  );
  const result = stalled.list({}, abort.signal);
  await Promise.resolve();
  abort.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(cancel).toHaveBeenCalled();
});
