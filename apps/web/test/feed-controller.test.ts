import { afterEach, expect, it, vi } from "vitest";
import { ApiFailure } from "../src/api/client";
import { createFeedController } from "../src/api/feed-controller";
import type { FeedQuery } from "../src/api/feed-contract";
import {
  cursor,
  eventId,
  feedPage,
  id,
  me,
  owner,
  publicPost,
  theme,
} from "./feed-fixture";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((r) => {
      resolve = r;
    }),
    resolve,
  };
};
function setup() {
  let now = 1000;
  const client = {
    getMe: vi.fn(async () => me),
    list: vi.fn<
      (
        query: FeedQuery,
        signal: AbortSignal,
      ) => Promise<ReturnType<typeof feedPage>>
    >(async () => feedPage()),
    post: vi.fn(async (idValue: string) =>
      publicPost(Number(idValue.slice(-12))),
    ),
  };
  const prepare = vi.fn(async () => true);
  const c = createFeedController(
    owner,
    eventId,
    undefined,
    client,
    prepare,
    () => now,
  );
  return {
    c,
    client,
    prepare,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
afterEach(() => vi.useRealTimers());
it("defaults empty; prepares and verifies identity before and after publishing", async () => {
  const { c, client, prepare } = setup();
  expect(c.getSnapshot().items).toEqual([]);
  expect(await c.reload()).toBe(true);
  expect(prepare).toHaveBeenCalledOnce();
  expect(client.getMe).toHaveBeenCalledTimes(2);
  expect(c.getSnapshot().items[0]?.validUntil).toBe(11000);
});
it.each([false, true])(
  "rejects owner switch %s before/after read",
  async (after) => {
    const { c, client } = setup();
    if (after) client.getMe.mockResolvedValueOnce(me);
    client.getMe.mockResolvedValue({ ...me, user_id: id(999) });
    expect(await c.reload()).toBe(false);
    expect(c.getSnapshot().items).toEqual([]);
    expect(client.list).toHaveBeenCalledTimes(after ? 1 : 0);
  },
);
it("role changes invalidate the current operation and allow a fresh explicit reload", async () => {
  const { c, client } = setup();
  await c.reload();
  client.getMe.mockResolvedValue({ ...me, role: "moderator" });
  expect(await c.poll()).toBe(false);
  expect(c.getSnapshot().items).toEqual([]);
  expect(await c.reload()).toBe(true);
});
it.each([
  ["is_banned", false],
  ["is_banned", true],
  ["consent_required", false],
  ["consent_required", true],
] as const)(
  "clears metadata when %s becomes true %s after the read",
  async (field, after) => {
    const { c, client } = setup();
    if (after) client.getMe.mockResolvedValueOnce(me);
    client.getMe.mockResolvedValue({ ...me, [field]: true });
    expect(await c.reload()).toBe(false);
    expect(c.getSnapshot().items).toEqual([]);
    expect(client.list).toHaveBeenCalledTimes(after ? 1 : 0);
  },
);
it("failed preparation never reads metadata", async () => {
  const { c, client, prepare } = setup();
  prepare.mockResolvedValue(false);
  expect(await c.reload()).toBe(false);
  expect(client.list).not.toHaveBeenCalled();
});
it("new head posts announce but do not insert or alter anchor order", async () => {
  const { c, client } = setup();
  await c.reload();
  client.list.mockResolvedValue(feedPage(102, 5));
  await c.poll();
  expect(c.getSnapshot().newCount).toBe(2);
  expect(c.getSnapshot().items.map((i) => i.post.id)).toEqual(
    feedPage().items.map((p) => p.id),
  );
});
it("rechecks visible old posts, removes NOT_FOUND and updates only matching theme", async () => {
  const { c, client } = setup();
  await c.reload();
  c.visible([id(98), id(99)]);
  client.list.mockResolvedValue(feedPage(110, 3));
  client.post.mockRejectedValueOnce(new ApiFailure("NOT_FOUND"));
  await c.poll();
  expect(client.post).toHaveBeenCalledTimes(2);
  expect(c.getSnapshot().items).toHaveLength(2);
});
it("uses theme on all list reads and rejects a changed old visible theme", async () => {
  const { client, prepare } = setup();
  client.list.mockResolvedValue({
    items: [{ ...publicPost(), theme_id: theme }],
    next_cursor: null,
  });
  const c = createFeedController(owner, eventId, theme, client, prepare);
  await c.reload();
  c.visible([id(100)]);
  client.list.mockResolvedValue({ items: [], next_cursor: null });
  await c.poll();
  expect(c.getSnapshot().items).toEqual([]);
  expect(client.list.mock.calls[0]?.[0]).toMatchObject({ theme });
});
it("expires display leases and clears data on authorization/read errors", async () => {
  const { c, client, advance } = setup();
  await c.reload();
  advance(10000);
  c.expire();
  expect(c.getSnapshot().items.every((i) => i.validUntil === 0)).toBe(true);
  client.list.mockRejectedValue(new ApiFailure("FORBIDDEN"));
  await c.poll();
  expect(c.getSnapshot().items).toEqual([]);
  expect(c.getSnapshot().phase).toBe("error");
});
it("appends a nonoverlapping older page and does not renew old leases", async () => {
  const { c, client, advance } = setup();
  client.list.mockResolvedValueOnce(feedPage(100, 30, cursor));
  await c.reload();
  advance(500);
  client.list.mockResolvedValue(feedPage(70, 2));
  await c.more();
  expect(c.getSnapshot().items).toHaveLength(32);
  expect(c.getSnapshot().items[0]?.validUntil).toBe(11000);
  expect(c.getSnapshot().items[30]?.validUntil).toBe(11500);
});
it.each([feedPage(101, 2), feedPage(71, 2), feedPage(70, 30, cursor)])(
  "rejects overlapping/newer/repeated cursor page",
  async (page) => {
    const { c, client } = setup();
    client.list.mockResolvedValueOnce(feedPage(100, 30, cursor));
    await c.reload();
    client.list.mockResolvedValue(page);
    expect(await c.more()).toBe(false);
    expect(c.getSnapshot().items).toEqual([]);
  },
);
it("close ignores late responses even when transport ignores abort", async () => {
  const { c, client } = setup();
  const pending = deferred<ReturnType<typeof feedPage>>();
  client.list.mockReturnValue(pending.promise);
  const result = c.reload();
  await vi.waitFor(() => expect(client.list).toHaveBeenCalled());
  c.close();
  pending.resolve(feedPage());
  expect(await result).toBe(false);
  expect(c.getSnapshot().phase).toBe("closed");
  expect(c.getSnapshot().items).toEqual([]);
  expect(await c.reload()).toBe(false);
});
it("completed report cancels in-flight read so it cannot resurrect a post", async () => {
  const { c, client } = setup();
  await c.reload();
  const pending = deferred<ReturnType<typeof feedPage>>();
  client.list.mockReturnValue(pending.promise);
  const result = c.poll();
  await vi.waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
  c.remove(id(100));
  pending.resolve(feedPage());
  expect(await result).toBe(false);
  expect(c.getSnapshot().items.some((i) => i.post.id === id(100))).toBe(false);
  expect(c.getSnapshot().phase).toBe("ready");
});
it("bounds a hung request to ten seconds and does not auto-retry", async () => {
  vi.useFakeTimers();
  const { c, client } = setup();
  client.list.mockImplementation(() => new Promise(() => {}));
  const result = c.reload();
  await vi.advanceTimersByTimeAsync(10001);
  expect(await result).toBe(false);
  expect(c.getSnapshot().items).toEqual([]);
  expect(client.list).toHaveBeenCalledOnce();
});
it("does not run competing refreshes or more without cursor", async () => {
  const { c, client } = setup();
  expect(await c.more()).toBe(false);
  await c.reload();
  expect(await c.more()).toBe(false);
  const pending = deferred<ReturnType<typeof feedPage>>();
  client.list.mockReturnValue(pending.promise);
  const result = c.poll();
  expect(await c.poll()).toBe(false);
  pending.resolve(feedPage());
  await result;
});

it("reaches 1500 posts in bounded explicit windows without dropping a cursor item", async () => {
  const { c, client } = setup();
  let next = 1500;
  client.list.mockImplementation(async (query) => {
    const count = Math.min(query.limit ?? 30, next);
    const page = feedPage(
      next,
      count,
      next > count ? `cursor-${next - count}` : null,
    );
    next -= count;
    return page;
  });
  expect(await c.reload()).toBe(true);
  const seen = new Set<string>();
  while (true) {
    const snapshot = c.getSnapshot();
    expect(snapshot.items.length).toBeLessThanOrEqual(300);
    snapshot.items.forEach((item) => seen.add(item.post.id));
    if (!snapshot.nextCursor) break;
    const replace = snapshot.items.length === 300;
    expect(await c.more()).toBe(true);
    if (replace) {
      expect(c.getSnapshot().items).toHaveLength(30);
      expect(
        c
          .getSnapshot()
          .items.some((item) => item.post.id === snapshot.items[0]!.post.id),
      ).toBe(false);
      expect(c.getSnapshot().message).toContain("直前の表示分は破棄");
    }
  }
  expect(seen.size).toBe(1500);
  expect(seen.has(id(1))).toBe(true);
});
it("caps the final append after a removed post and rejects an oversized response", async () => {
  const { c, client } = setup();
  let next = 1000;
  client.list.mockImplementation(async (query) => {
    const limit = query.limit ?? 30;
    const page = feedPage(next, limit, `cursor-${next - limit}`);
    next -= limit;
    return page;
  });
  await c.reload();
  for (let n = 0; n < 9; n++) await c.more();
  c.remove(id(1000));
  await c.more();
  expect(client.list.mock.lastCall?.[0].limit).toBe(1);
  expect(c.getSnapshot().items).toHaveLength(300);
  c.remove(id(999));
  client.list.mockResolvedValue(feedPage(next, 2, "other-cursor"));
  expect(await c.more()).toBe(false);
  expect(c.getSnapshot().items).toEqual([]);
});
it("media retry fresh-checks one post and identity on both sides without moving the list", async () => {
  const { c, client, prepare, advance } = setup();
  await c.reload();
  const before = c.getSnapshot();
  advance(500);
  expect(await c.retryMedia(id(99))).toBe(true);
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(client.getMe).toHaveBeenCalledTimes(4);
  expect(client.post).toHaveBeenCalledWith(id(99), expect.any(AbortSignal));
  expect(client.list).toHaveBeenCalledOnce();
  expect(c.getSnapshot().items.map((item) => item.post.id)).toEqual(
    before.items.map((item) => item.post.id),
  );
  expect(
    c.getSnapshot().items.find((item) => item.post.id === id(99))?.validUntil,
  ).toBe(11500);
  expect(c.getSnapshot().items[0]?.validUntil).toBe(11000);
  expect(c.getSnapshot().nextCursor).toBe(before.nextCursor);
});
it.each(["owner", "event", "banned", "consent", "role"] as const)(
  "media retry stops on %s revocation after reading",
  async (kind) => {
    const { c, client } = setup();
    await c.reload();
    const next = {
      ...me,
      ...(kind === "owner"
        ? { user_id: id(999) }
        : kind === "event"
          ? { event_id: id(999) }
          : kind === "banned"
            ? { is_banned: true }
            : kind === "consent"
              ? { consent_required: true }
              : { role: "moderator" as const }),
    };
    client.getMe.mockResolvedValueOnce(me).mockResolvedValueOnce(next);
    expect(await c.retryMedia(id(100))).toBe(false);
    expect(c.getSnapshot().items).toEqual([]);
  },
);
it("media retry cannot resurrect a removed/reported post with a late result", async () => {
  const { c, client } = setup();
  await c.reload();
  const pending = deferred<ReturnType<typeof publicPost>>();
  client.post.mockReturnValue(pending.promise);
  const result = c.retryMedia(id(100));
  await vi.waitFor(() => expect(client.post).toHaveBeenCalledOnce());
  expect(await c.retryMedia(id(100))).toBe(false);
  c.remove(id(100));
  pending.resolve(publicPost(100));
  expect(await result).toBe(false);
  expect(c.getSnapshot().items.some((item) => item.post.id === id(100))).toBe(
    false,
  );
  expect(await c.retryMedia(id(100))).toBe(false);
});
it.each(["not-found", "wrong-post", "wrong-event"])(
  "media retry rejects %s",
  async (kind) => {
    const { c, client } = setup();
    await c.reload();
    if (kind === "not-found")
      client.post.mockRejectedValue(new ApiFailure("NOT_FOUND"));
    else
      client.post.mockResolvedValue({
        ...publicPost(kind === "wrong-post" ? 99 : 100),
        event_id: kind === "wrong-event" ? id(999) : eventId,
      });
    expect(await c.retryMedia(id(100))).toBe(false);
    expect(c.getSnapshot().items).toEqual([]);
  },
);
it("a late media retry after sign-out cannot restore metadata", async () => {
  const { c, client } = setup();
  await c.reload();
  const pending = deferred<ReturnType<typeof publicPost>>();
  client.post.mockReturnValue(pending.promise);
  const result = c.retryMedia(id(100));
  await vi.waitFor(() => expect(client.post).toHaveBeenCalledOnce());
  c.close();
  pending.resolve(publicPost());
  expect(await result).toBe(false);
  expect(c.getSnapshot().items).toEqual([]);
  expect(c.getSnapshot().phase).toBe("closed");
});
it("media confirmation is finite even when the transport ignores abort", async () => {
  vi.useFakeTimers();
  const { c, client } = setup();
  await c.reload();
  client.post.mockImplementation(() => new Promise(() => {}));
  const result = c.retryMedia(id(100));
  await vi.advanceTimersByTimeAsync(10001);
  expect(await result).toBe(false);
  expect(client.post).toHaveBeenCalledOnce();
  expect(c.getSnapshot().items).toEqual([]);
});
