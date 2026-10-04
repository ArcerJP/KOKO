import { afterEach, expect, it, vi } from "vitest";
import { ApiFailure } from "../src/api/client";
import type { createUploadClient } from "../src/api/upload-client";
import { createUploadQueue } from "../src/media/upload-queue";
import {
  queueRecord,
  type QueueRecord,
  type QueueStore,
} from "../src/media/upload-queue-record";
import {
  destination,
  input,
  single,
  multipart,
  signed,
  receipt,
  csrf,
  uploadId,
} from "./upload-fixture";

const owner = "00000000-0000-4000-8000-000000000009";
const blob = new Blob(["abc"], { type: "image/png" });
function setup() {
  const entries = new Map<string, QueueRecord>();
  const blobs = new Map<string, Blob>();
  const copy = (item: QueueRecord) => structuredClone(item);
  const store: QueueStore = {
    list: vi.fn(async () => [...entries.values()].map(copy)),
    get: vi.fn(async (id) => (entries.has(id) ? copy(entries.get(id)!) : null)),
    add: vi.fn(async (item, blob) => {
      entries.set(item.id, copy(item));
      blobs.set(item.id, blob);
    }),
    save: vi.fn(async (item) => {
      queueRecord(item, owner, destination.eventId);
      entries.set(item.id, copy(item));
      if (item.phase === "done") blobs.delete(item.id);
    }),
    blob: vi.fn(async (id) => blobs.get(id)!),
    remove: vi.fn(async (id) => {
      entries.delete(id);
      blobs.delete(id);
    }),
  };
  const client = {
    open: vi.fn<ReturnType<typeof createUploadClient>["open"]>(async () =>
      single(),
    ),
    refresh: vi.fn<ReturnType<typeof createUploadClient>["refresh"]>(async () =>
      single(),
    ),
    parts: vi.fn(async (_id: string, numbers: number[]) => ({
      parts: numbers.map((part_number) => ({
        part_number,
        ...signed(part_number),
      })),
    })),
    complete: vi.fn<ReturnType<typeof createUploadClient>["complete"]>(
      async () => ({ ...receipt, status: "uploaded" as const }),
    ),
  };
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(null, { headers: { etag: `"${"d".repeat(32)}"` } }),
  );
  const authorize = vi.fn(async () => csrf);
  const lock = vi.fn(async (run: () => Promise<void>) => {
    await run();
    return true;
  });
  const wait = vi.fn(async (_ms: number, signal: AbortSignal) => {
    signal.throwIfAborted();
  });
  const deps = {
    owner,
    destination,
    store,
    client,
    authorize,
    lock,
    wait,
    fetcher,
  };
  const queue = createUploadQueue(deps);
  return {
    queue,
    deps,
    entries,
    blobs,
    store,
    client,
    fetcher,
    authorize,
    lock,
    wait,
  };
}
afterEach(() => vi.useRealTimers());
it("enqueueing a new item after reload does not silently resume older entries", async () => {
  const s = setup();
  await s.queue.initialize();
  s.lock.mockResolvedValue(false);
  await s.queue.enqueue(blob, input);
  await s.queue.settled();
  const next = createUploadQueue(s.deps);
  s.lock.mockImplementation(async (run) => {
    await run();
    return true;
  });
  await next.initialize();
  const second = {
    ...input,
    client_request_id: "00000000-0000-4000-8000-000000000099",
  };
  await next.enqueue(blob, second);
  await next.settled();
  expect(
    s.client.open.mock.calls.map(([request]) => request.client_request_id),
  ).toEqual([second.client_request_id]);
  expect(s.entries.get(input.client_request_id)?.phase).toBe("queued");
});
it("changed session from refresh stops before resending the original", async () => {
  const s = setup();
  await s.queue.initialize();
  s.fetcher.mockRejectedValueOnce(new Error());
  s.client.complete.mockRejectedValue(new ApiFailure("UPLOAD_INCOMPLETE"));
  s.client.refresh.mockResolvedValue({ ...single(), post_id: owner });
  await s.queue.enqueue(blob, input);
  await s.queue.settled();
  expect(s.fetcher).toHaveBeenCalledTimes(1);
  expect(s.entries.get(input.client_request_id)?.paused).toBe(true);
});
it("persists before admission; PUT then durable intent then complete; purges Blob only after receipt", async () => {
  const s = setup();
  await s.queue.initialize();
  expect(s.client.open).not.toHaveBeenCalled();
  expect(await s.queue.enqueue(blob, input)).toBe(true);
  await s.queue.settled();
  expect(s.entries.get(input.client_request_id)?.phase).toBe("done");
  expect(s.blobs.size).toBe(0);
  expect(s.client.open).toHaveBeenCalledTimes(1);
  expect(s.fetcher).toHaveBeenCalledTimes(1);
  const serialized = JSON.stringify([...s.entries.values()]);
  for (const forbidden of [
    "X-Amz",
    "put_url",
    "csrf",
    "Authorization",
    "Cookie",
  ])
    expect(serialized).not.toContain(forbidden);
  expect(vi.mocked(s.store.add).mock.invocationCallOrder[0]).toBeLessThan(
    s.client.open.mock.invocationCallOrder[0]!,
  );
  const lastIntent = vi
    .mocked(s.store.save)
    .mock.calls.find(([item]) => item.phase === "completing");
  expect(lastIntent?.[0].manifest).toEqual({ upload_id: uploadId });
});
it("storage failure never claims acceptance or contacts API/R2", async () => {
  const s = setup();
  await s.queue.initialize();
  vi.mocked(s.store.add).mockRejectedValue(
    new ApiFailure("LOCAL_STORAGE_UNAVAILABLE"),
  );
  expect(await s.queue.enqueue(blob, input)).toBe(false);
  expect(s.queue.getSnapshot().message).toContain("保存できません");
  expect(s.client.open).not.toHaveBeenCalled();
  expect(s.fetcher).not.toHaveBeenCalled();
});
it("slow persistence shows no false 3-second acceptance and serializes double submit", async () => {
  vi.useFakeTimers();
  const s = setup();
  await s.queue.initialize();
  let release!: () => void;
  vi.mocked(s.store.add).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const pending = s.queue.enqueue(blob, input);
  await vi.advanceTimersByTimeAsync(3001);
  expect(s.queue.getSnapshot().message).toContain("まだ受付は完了していません");
  expect(await s.queue.enqueue(blob, input)).toBe(false);
  expect(s.client.open).not.toHaveBeenCalled();
  s.queue.stop();
  release();
  expect(await pending).toBe(false);
});
it("unknown single PUT outcome is reconciled without another PUT", async () => {
  const s = setup();
  await s.queue.initialize();
  s.fetcher.mockRejectedValueOnce(new Error("private URL must not leak"));
  await s.queue.enqueue(blob, input);
  await s.queue.settled();
  expect(s.fetcher).toHaveBeenCalledTimes(1);
  expect(s.client.complete).toHaveBeenCalledTimes(1);
  expect(s.entries.get(input.client_request_id)?.phase).toBe("done");
  expect(s.client.refresh).not.toHaveBeenCalled();
});
it("verified missing single object allows conditional retry on the SAME upload", async () => {
  const s = setup();
  await s.queue.initialize();
  s.fetcher.mockRejectedValueOnce(new Error());
  s.client.complete.mockRejectedValueOnce(new ApiFailure("UPLOAD_INCOMPLETE"));
  await s.queue.enqueue(blob, input);
  await s.queue.settled();
  expect(s.client.open).toHaveBeenCalledTimes(1);
  expect(s.client.refresh).toHaveBeenCalledTimes(1);
  expect(s.fetcher).toHaveBeenCalledTimes(2);
  expect(s.fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
    "if-none-match": "*",
  });
});
it("lost complete response replays the immutable manifest without refresh or PUT", async () => {
  const s = setup();
  await s.queue.initialize();
  s.client.complete.mockRejectedValueOnce(
    new ApiFailure("NETWORK_UNAVAILABLE"),
  );
  await s.queue.enqueue(blob, input);
  await s.queue.settled();
  expect(s.client.complete).toHaveBeenCalledTimes(2);
  expect(s.fetcher).toHaveBeenCalledTimes(1);
  expect(s.client.refresh).not.toHaveBeenCalled();
  expect(s.client.complete.mock.calls[0]?.slice(0, 3)).toEqual(
    s.client.complete.mock.calls[1]?.slice(0, 3),
  );
});
it("initial attempt + three retries, persistent exhausted state, explicit resume uses same id", async () => {
  const s = setup();
  await s.queue.initialize();
  s.client.open.mockRejectedValue(new ApiFailure("NETWORK_UNAVAILABLE"));
  await s.queue.enqueue(blob, input);
  await s.queue.settled();
  expect(s.client.open).toHaveBeenCalledTimes(4);
  expect(s.wait.mock.calls.map(([ms]) => Math.round(ms / 100))).toEqual([
    10, 20, 40,
  ]);
  expect(s.entries.get(input.client_request_id)).toMatchObject({
    failures: 4,
    paused: true,
  });
  const reloaded = createUploadQueue(s.deps);
  await reloaded.initialize();
  expect(s.client.open).toHaveBeenCalledTimes(4);
  s.client.open.mockResolvedValue(single());
  await reloaded.resume(input.client_request_id);
  expect(s.client.open).toHaveBeenCalledTimes(5);
  expect(
    s.client.open.mock.calls.every(
      (call) =>
        (call as unknown as [typeof input])[0].client_request_id ===
        input.client_request_id,
    ),
  ).toBe(true);
});
it.each([
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "CONSENT_REQUIRED",
  "ACCOUNT_BANNED",
] as const)(
  "%s stops all work and removes visible private state",
  async (code) => {
    const s = setup();
    await s.queue.initialize();
    s.authorize.mockRejectedValue(new ApiFailure(code));
    await s.queue.enqueue(blob, input);
    await s.queue.settled();
    expect(s.client.open).not.toHaveBeenCalled();
    expect(s.wait).not.toHaveBeenCalled();
    expect(s.queue.getSnapshot()).toMatchObject({
      ready: false,
      items: [],
      busy: false,
    });
    expect(s.blobs.size).toBe(1);
  },
);
it.each([
  "EVENT_CLOSED",
  "PUBLICATION_STOPPED",
  "THEME_UNAVAILABLE",
  "STATE_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "PROVIDER_LIMIT",
] as const)("%s is not automatically retried", async (code) => {
  const s = setup();
  await s.queue.initialize();
  s.client.open.mockRejectedValue(new ApiFailure(code));
  await s.queue.enqueue(blob, input);
  await s.queue.settled();
  expect(s.client.open).toHaveBeenCalledTimes(1);
  expect(s.wait).not.toHaveBeenCalled();
});
it("rate limit waits at least 60 seconds even without Retry-After forwarding", async () => {
  const s = setup();
  await s.queue.initialize();
  s.client.open.mockRejectedValueOnce(new ApiFailure("RATE_LIMITED"));
  await s.queue.enqueue(blob, input);
  await s.queue.settled();
  expect(s.wait.mock.calls[0]![0]).toBeGreaterThanOrEqual(59_000);
});
it("unavailable cross-tab lock keeps durable item but sends nothing", async () => {
  const s = setup();
  await s.queue.initialize();
  s.lock.mockResolvedValue(false);
  await s.queue.enqueue(blob, input);
  await s.queue.settled();
  expect(s.queue.getSnapshot().message).toContain("別のタブ");
  expect(s.client.open).not.toHaveBeenCalled();
});
it("stop while waiting for an API response suppresses later PUT and visible stale results", async () => {
  const s = setup();
  await s.queue.initialize();
  let release!: (value: ReturnType<typeof single>) => void;
  s.client.open.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await s.queue.enqueue(blob, input);
  await vi.waitFor(() => expect(release).toBeDefined());
  s.queue.stop();
  release(single());
  await s.queue.settled();
  expect(s.fetcher).not.toHaveBeenCalled();
  expect(s.queue.getSnapshot().items).toEqual([]);
});
it("multipart restart skips acknowledged part and preserves ETags", async () => {
  const s = setup();
  await s.queue.initialize();
  s.client.open.mockResolvedValue(multipart());
  s.client.refresh.mockResolvedValue(multipart());
  let count = 0;
  s.fetcher.mockImplementation(async () => {
    if (++count === 2) throw new Error();
    return new Response(null, { headers: { etag: "d".repeat(32) } });
  });
  const large = new Blob([new Uint8Array(5 * 1024 ** 2), "xyz"]);
  await s.queue.enqueue(large, { ...input, file_size_bytes: large.size });
  await s.queue.settled();
  expect(s.client.parts.mock.calls.map(([, nums]) => nums)).toEqual([
    [1],
    [2],
    [2],
  ]);
  expect(s.fetcher).toHaveBeenCalledTimes(3);
  const done = s.entries.get(input.client_request_id)!;
  expect(done.phase).toBe("done");
  expect(done.manifest?.parts?.length).toBe(2);
});
it("durable completion intent survives a fresh engine without media present", async () => {
  const s = setup();
  await s.queue.initialize();
  s.client.complete.mockRejectedValue(new ApiFailure("NETWORK_UNAVAILABLE"));
  await s.queue.enqueue(blob, input);
  await s.queue.settled();
  expect(s.entries.get(input.client_request_id)?.phase).toBe("completing");
  const next = createUploadQueue(s.deps);
  await next.initialize();
  s.client.complete.mockResolvedValue({ ...receipt, status: "uploaded" });
  await next.resume(input.client_request_id);
  expect(s.fetcher).toHaveBeenCalledTimes(1);
});
it("same draft id after ambiguous local result does not create another item", async () => {
  const s = setup();
  await s.queue.initialize();
  s.lock.mockResolvedValue(false);
  await s.queue.enqueue(blob, input);
  await s.queue.settled();
  await s.queue.enqueue(blob, input);
  await s.queue.settled();
  expect(s.store.add).toHaveBeenCalledTimes(1);
});
it("initial identity preparation cannot change a shared Cookie while another tab holds the lock", async () => {
  const s = setup();
  s.lock.mockResolvedValue(false);
  await s.queue.initialize();
  expect(s.authorize).not.toHaveBeenCalled();
  expect(s.store.list).not.toHaveBeenCalled();
  expect(s.queue.getSnapshot()).toMatchObject({ ready: false, items: [] });
  expect(s.queue.getSnapshot().message).toContain("別のタブ");
});
it("checkpoint save failure stops before next part or complete", async () => {
  const s = setup();
  await s.queue.initialize();
  s.client.open.mockResolvedValue(multipart());
  const save = s.store.save;
  s.store.save = vi.fn(async (item) => {
    if (item.checkpoint) throw new ApiFailure("LOCAL_STORAGE_UNAVAILABLE");
    await save(item);
  });
  const large = new Blob([new Uint8Array(5 * 1024 ** 2), "xyz"]);
  await s.queue.enqueue(large, { ...input, file_size_bytes: large.size });
  await s.queue.settled();
  expect(s.fetcher).toHaveBeenCalledTimes(1);
  expect(s.client.complete).not.toHaveBeenCalled();
  expect(s.queue.getSnapshot().ready).toBe(false);
});
