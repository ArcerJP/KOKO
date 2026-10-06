import { afterEach, expect, it, vi } from "vitest";
import { ApiFailure } from "../src/api/client";
import { createOwnPostsController } from "../src/api/own-posts-controller";
import { cursor, eventId, me, page, post } from "./own-posts-fixture";

function setup() {
  const client = {
    getMe: vi.fn().mockResolvedValue(me),
    listOwnPosts: vi.fn().mockResolvedValue(page()),
    getPostStatus: vi
      .fn()
      .mockResolvedValue(post(1, { status: "processing", version: 2 })),
  };
  const prepare = vi.fn().mockResolvedValue(true);
  const controller = createOwnPostsController(
    me.user_id,
    eventId,
    client,
    prepare,
  );
  return { controller, client, prepare };
}
afterEach(() => vi.useRealTimers());
it("checks identity on both sides of every read, even when banned or lacking consent", async () => {
  const { controller, client, prepare } = setup();
  client.getMe.mockResolvedValue({
    ...me,
    is_banned: true,
    consent_required: true,
  });
  expect(controller.getSnapshot().items).toEqual([]);
  expect(prepare).not.toHaveBeenCalled();
  await controller.reload();
  expect(controller.getSnapshot()).toMatchObject({
    phase: "ready",
    items: page().items,
    nextCursor: cursor,
  });
  expect(client.getMe).toHaveBeenCalledTimes(2);
  client.listOwnPosts.mockResolvedValueOnce(page(31, 2, null));
  await controller.more();
  expect(controller.getSnapshot().items).toHaveLength(32);
  expect(client.listOwnPosts.mock.calls[1]?.[0]).toEqual({ limit: 30, cursor });
  await controller.refresh(post().id);
  expect(controller.getSnapshot().items[0]).toMatchObject({
    status: "processing",
    version: 2,
  });
  expect(controller.getSnapshot().message).toContain("他の投稿は前回");
  expect(prepare).toHaveBeenCalledTimes(3);
  expect(client.getMe).toHaveBeenCalledTimes(6);
});
it.each(["before", "after", "event"])(
  "discards data after %s identity mismatch",
  async (when) => {
    const { controller, client } = setup();
    if (when === "before")
      client.getMe.mockResolvedValue({ ...me, user_id: post(3).id });
    else if (when === "event")
      client.getMe.mockResolvedValue({ ...me, event_id: post(3).id });
    else
      client.getMe
        .mockResolvedValueOnce(me)
        .mockResolvedValueOnce({ ...me, user_id: post(3).id });
    await controller.reload();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      items: [],
      nextCursor: null,
    });
    expect(client.listOwnPosts).toHaveBeenCalledTimes(when === "after" ? 1 : 0);
  },
);
it("never reads without session preparation and ignores status for an unlisted ID", async () => {
  const { controller, client, prepare } = setup();
  prepare.mockResolvedValue(false);
  await controller.reload();
  await controller.refresh(post(99).id);
  await controller.more();
  expect(client.getMe).not.toHaveBeenCalled();
  expect(client.listOwnPosts).not.toHaveBeenCalled();
  expect(client.getPostStatus).not.toHaveBeenCalled();
});
it.each(["duplicate", "order", "cursor", "expired"])(
  "clears the entire list on invalid continuation: %s",
  async (kind) => {
    const { controller, client } = setup();
    await controller.reload();
    if (kind === "expired")
      client.listOwnPosts.mockRejectedValueOnce(
        new ApiFailure("INVALID_CURSOR"),
      );
    else
      client.listOwnPosts.mockResolvedValueOnce(
        kind === "cursor"
          ? page(31, 30)
          : kind === "order"
            ? page(0, 1, null)
            : page(30, 1, null),
      );
    await controller.more();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      items: [],
      nextCursor: null,
    });
    if (kind === "expired")
      expect(controller.getSnapshot().message).toContain("期限切れ");
    await controller.more();
    expect(client.listOwnPosts).toHaveBeenCalledTimes(2);
    await controller.reload();
    expect(controller.getSnapshot().phase).toBe("ready");
  },
);
it.each([
  { version: 0 },
  { id: post(3).id },
  { event_id: post(3).id },
  { created_at: post(2).created_at },
])("rejects stale or replaced status %j", async (change) => {
  const { controller, client } = setup();
  await controller.reload();
  client.getPostStatus.mockResolvedValueOnce({ ...post(), ...change });
  await controller.refresh(post().id);
  expect(controller.getSnapshot()).toMatchObject({ phase: "error", items: [] });
});
it("reaches older posts through bounded windows without automatic reads", async () => {
  const { controller, client } = setup();
  await controller.reload();
  for (let n = 1; n <= 20; n++) {
    client.listOwnPosts.mockResolvedValueOnce(
      page(n * 30 + 1, 30, `page${n}.${"b".repeat(43)}`),
    );
    await controller.more();
    expect(controller.getSnapshot().items.length).toBeLessThanOrEqual(300);
    if (n % 10 === 0) {
      expect(controller.getSnapshot().items).toEqual(page(n * 30 + 1).items);
      expect(controller.getSnapshot().message).toContain("直前の表示分は破棄");
    }
  }
  expect(controller.getSnapshot().items[0]?.id).toBe(post(601).id);
  expect(client.listOwnPosts).toHaveBeenCalledTimes(21);
  expect(client.getMe).toHaveBeenCalledTimes(42);
  expect(client.listOwnPosts.mock.calls[10]?.[0]).toEqual({
    limit: 30,
    cursor: `page9.${"b".repeat(43)}`,
  });
  client.getPostStatus.mockResolvedValueOnce(
    post(601, { status: "deleted", version: 2 }),
  );
  await controller.refresh(post(601).id);
  expect(controller.getSnapshot().items[0]).toMatchObject({
    status: "deleted",
    version: 2,
  });
  await controller.refresh(post(1).id);
  expect(client.getPostStatus).toHaveBeenCalledTimes(1);
  await controller.reload();
  expect(controller.getSnapshot().items).toEqual(page().items);
});
it.each(["valid", "oversized"])("bounds a partial window: %s", async (kind) => {
  const { controller, client } = setup();
  client.listOwnPosts.mockResolvedValueOnce(page(1, 25));
  await controller.reload();
  for (let n = 1; n <= 9; n++) {
    client.listOwnPosts.mockResolvedValueOnce(
      page(26 + (n - 1) * 30, 30, `page${n}.${"b".repeat(43)}`),
    );
    await controller.more();
  }
  expect(controller.getSnapshot().items).toHaveLength(295);
  client.listOwnPosts.mockResolvedValueOnce(
    page(296, kind === "valid" ? 5 : 6, `next.${"c".repeat(43)}`),
  );
  await controller.more();
  expect(client.listOwnPosts.mock.calls.at(-1)?.[0]).toMatchObject({
    limit: 5,
  });
  if (kind === "oversized") {
    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      items: [],
      nextCursor: null,
    });
  } else {
    expect(controller.getSnapshot().items).toHaveLength(300);
    client.listOwnPosts.mockResolvedValueOnce(page(301, 7, null));
    await controller.more();
    expect(client.listOwnPosts.mock.calls.at(-1)?.[0]).toEqual({
      limit: 30,
      cursor: `next.${"c".repeat(43)}`,
    });
    expect(controller.getSnapshot().items).toEqual(page(301, 7, null).items);
    const calls = client.listOwnPosts.mock.calls.length;
    await controller.more();
    expect(client.listOwnPosts).toHaveBeenCalledTimes(calls);
  }
});
it.each(["duplicate", "cursor", "identity"])(
  "checks %s before replacing a full window",
  async (kind) => {
    const { controller, client } = setup();
    await controller.reload();
    for (let n = 1; n < 10; n++) {
      client.listOwnPosts.mockResolvedValueOnce(
        page(n * 30 + 1, 30, `page${n}.${"b".repeat(43)}`),
      );
      await controller.more();
    }
    client.listOwnPosts.mockResolvedValueOnce(
      kind === "duplicate"
        ? page(300, 1, null)
        : page(
            301,
            30,
            kind === "cursor" ? controller.getSnapshot().nextCursor : null,
          ),
    );
    if (kind === "identity")
      client.getMe
        .mockResolvedValueOnce(me)
        .mockResolvedValueOnce({ ...me, user_id: post(900).id });
    await controller.more();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      items: [],
      nextCursor: null,
    });
  },
);
it.each(["invalidate", "close"] as const)(
  "%s aborts and ignores a late response; concurrent requests are deduplicated",
  async (action) => {
    const { controller, client } = setup();
    let finish!: (value: ReturnType<typeof page>) => void;
    client.listOwnPosts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const running = controller.reload();
    await vi.waitFor(() => expect(client.listOwnPosts).toHaveBeenCalledOnce());
    await controller.reload();
    const signal = client.listOwnPosts.mock.calls[0]![1] as AbortSignal;
    controller[action]();
    expect(signal.aborted).toBe(true);
    finish(page());
    await running;
    expect(controller.getSnapshot()).toMatchObject({
      phase: action === "close" ? "closed" : "idle",
      items: [],
    });
    await controller.reload();
    expect(client.listOwnPosts).toHaveBeenCalledTimes(
      action === "close" ? 1 : 2,
    );
  },
);
it("bounds uncooperative operations to 30 seconds without exposing raw errors", async () => {
  vi.useFakeTimers();
  const { controller, prepare, client } = setup();
  prepare.mockImplementationOnce(() => new Promise(() => {}));
  const run = controller.reload();
  await vi.advanceTimersByTimeAsync(30_000);
  await run;
  expect(controller.getSnapshot()).toMatchObject({ phase: "error", items: [] });
  expect(client.listOwnPosts).not.toHaveBeenCalled();
  prepare.mockRejectedValueOnce(new Error("SECRET_RAW_ERROR"));
  await controller.reload();
  expect(JSON.stringify(controller.getSnapshot())).not.toContain("SECRET");
});
it("notifies subscribers and drops all retained items on clear", async () => {
  const { controller } = setup();
  const listener = vi.fn();
  const unsubscribe = controller.subscribe(listener);
  await controller.reload();
  expect(listener).toHaveBeenCalledTimes(2);
  controller.invalidate();
  expect(controller.getSnapshot().items).toEqual([]);
  unsubscribe();
  controller.close();
  controller.invalidate();
  expect(controller.getSnapshot().phase).toBe("closed");
  expect(listener).toHaveBeenCalledTimes(3);
});
