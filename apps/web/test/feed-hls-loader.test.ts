import { afterEach, expect, it, vi } from "vitest";
import type {
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
} from "hls.js";
import {
  createScopedHlsLoader,
  scopedMediaUrl,
} from "../src/components/feed-hls-loader";
import { eventId, id } from "./feed-fixture";
const origin = "https://web.test",
  prefix = `/media/${eventId}/${id(100)}/`,
  child = `${prefix}hls-${"a".repeat(16)}.${"b".repeat(30)}`;
const manifest = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\n${child}\n`;
function setup(fetcher: typeof fetch = async () => new Response(manifest)) {
  const Loader = createScopedHlsLoader(origin, eventId, id(100), fetcher),
    loader = new Loader();
  const callbacks = {
    onSuccess: vi.fn(),
    onError: vi.fn(),
    onTimeout: vi.fn(),
  };
  const load = (patch: Partial<LoaderContext> = {}) =>
    loader.load(
      {
        url: prefix + "hls",
        type: "manifest" as LoaderContext["type"],
        responseType: "text",
        ...patch,
      },
      {} as LoaderConfiguration,
      callbacks as LoaderCallbacks<LoaderContext>,
    );
  return { loader, callbacks, load };
}
afterEach(() => vi.useRealTimers());
it("does not mark successfully completed fragments as aborted when hls destroys the loader", async () => {
  const { load, loader, callbacks } = setup();
  load();
  await vi.waitFor(() => expect(callbacks.onSuccess).toHaveBeenCalledOnce());
  const stats = callbacks.onSuccess.mock.calls[0]?.[1];
  loader.destroy();
  expect(stats.aborted).toBe(false);
});
it("accepts hls.js's full-fragment 0/0 sentinel without a Range header", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(new Uint8Array([1, 2, 3])),
  );
  const { load, callbacks } = setup(fetcher);
  load({
    url: child,
    type: "media-fragment" as LoaderContext["type"],
    responseType: "arraybuffer",
    rangeStart: 0,
    rangeEnd: 0,
  });
  await vi.waitFor(() => expect(callbacks.onSuccess).toHaveBeenCalledOnce());
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("range")).toBe(
    false,
  );
});
it.each([prefix + "hls", origin + prefix + "hls", child])(
  "accepts scoped resource %s",
  (url) => expect(scopedMediaUrl(url, origin, eventId, id(100))).not.toBeNull(),
);
it.each([
  "https://evil.test/a",
  "https://user:pass@web.test" + prefix + "hls",
  prefix + "hls?token=x",
  prefix + "hls#x",
  `/media/${eventId}/${id(101)}/hls`,
  prefix + "thumbnail",
  prefix + "../hls",
  prefix + "hls-a.b",
  "//evil.test/x",
])("blocks resource %s before network", (url) =>
  expect(scopedMediaUrl(url, origin, eventId, id(100))).toBeNull(),
);
it("loads only authorized same-origin rewritten children, never forwards injected headers", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(manifest));
  const { load, callbacks } = setup(fetcher);
  load({
    headers: { authorization: "secret", "CF-Access-Client-Secret": "private" },
  });
  await vi.waitFor(() => expect(callbacks.onSuccess).toHaveBeenCalledOnce());
  expect(callbacks.onSuccess.mock.calls[0]?.[0]).toMatchObject({
    data: manifest,
  });
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    mode: "same-origin",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
  });
  expect(
    new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("authorization"),
  ).toBe(false);
  expect(
    new Headers(fetcher.mock.calls[0]?.[1]?.headers).has(
      "CF-Access-Client-Secret",
    ),
  ).toBe(false);
});
it.each([
  "steering-manifest",
  "server-certificate",
  "interstitial-asset-list",
  "subtitleTrack",
])("rejects unsupported loader context %s", (type) => {
  const fetcher = vi.fn<typeof fetch>();
  const { load, callbacks } = setup(fetcher);
  load({ type: type as LoaderContext["type"] });
  expect(callbacks.onError).toHaveBeenCalledOnce();
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  "#EXTM3U\nhttps://evil.test/secret",
  `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://evil.test/key"`,
  "plain",
  "#EXTM3U\n" + `/media/${eventId}/${id(101)}/hls`,
])("rejects untrusted playlist without fetching its targets", async (body) => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(body));
  const { load, callbacks } = setup(fetcher);
  load();
  await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledOnce());
  expect(callbacks.onSuccess).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(JSON.stringify(callbacks.onError.mock.calls[0]?.[0])).not.toContain(
    "evil",
  );
});
it.each([401, 403, 404, 302, 500, 206])(
  "rejects unsuccessful or unsolicited partial response %s",
  async (status) => {
    const { load, callbacks } = setup(
      async () => new Response("private", { status }),
    );
    load();
    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledOnce());
    expect(callbacks.onSuccess).not.toHaveBeenCalled();
  },
);
it("rejects a followed redirect even with a valid body", async () => {
  const response = new Response(manifest);
  Object.defineProperty(response, "redirected", { value: true });
  const { load, callbacks } = setup(async () => response);
  load();
  await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledOnce());
});
it.each([
  () => new Response("a".repeat(262145)),
  () => new Response(manifest, { headers: { "content-length": "999999" } }),
  () => new Response(manifest, { headers: { "content-length": "1" } }),
  () => new Response(new Uint8Array([255])),
  () => new Response(""),
])(
  "rejects overlimit, invalid UTF8, empty and length mismatches",
  async (response) => {
    const { load, callbacks } = setup(async () => response());
    load();
    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledOnce());
  },
);
it("validates range length, supplies its own Range header and accepts bounded fragments", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: { "content-range": "bytes 4-6/10", "content-length": "3" },
      }),
  );
  const { load, callbacks } = setup(fetcher);
  load({
    url: child,
    type: "media-fragment" as LoaderContext["type"],
    responseType: "arraybuffer",
    rangeStart: 4,
    rangeEnd: 7,
  });
  await vi.waitFor(() => expect(callbacks.onSuccess).toHaveBeenCalledOnce());
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("range")).toBe(
    "bytes=4-6",
  );
  expect(callbacks.onSuccess.mock.calls[0]?.[0].data.byteLength).toBe(3);
});
it.each([
  { rangeStart: 0 },
  { rangeEnd: 10 },
  { rangeStart: -1, rangeEnd: 3 },
  { rangeStart: 1, rangeEnd: 1 },
  { rangeStart: 0, rangeEnd: 16777217 },
])("rejects unsafe range %j", (range) => {
  const fetcher = vi.fn<typeof fetch>();
  const { load, callbacks } = setup(fetcher);
  load({
    ...range,
    type: "media-fragment" as LoaderContext["type"],
    responseType: "arraybuffer",
  });
  expect(callbacks.onError).toHaveBeenCalledOnce();
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  new Response(new Uint8Array([1, 2]), {
    status: 206,
    headers: { "content-range": "bytes 4-6/10" },
  }),
  new Response(new Uint8Array([1, 2, 3]), {
    status: 206,
    headers: { "content-range": "bytes 0-2/10" },
  }),
])("rejects inaccurate partial range response", async (response) => {
  const { load, callbacks } = setup(async () => response);
  load({
    url: child,
    type: "media-fragment" as LoaderContext["type"],
    responseType: "arraybuffer",
    rangeStart: 4,
    rangeEnd: 7,
  });
  await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledOnce());
});
it.each([16, 17, 65])("allows only AES128 key bytes %s", async (size) => {
  const { load, callbacks } = setup(
    async () => new Response(new Uint8Array(size)),
  );
  load({
    url: child,
    type: "key" as LoaderContext["type"],
    responseType: "arraybuffer",
  });
  await vi.waitFor(() =>
    expect(
      size === 16 ? callbacks.onSuccess : callbacks.onError,
    ).toHaveBeenCalledOnce(),
  );
});
it("aborts a stalled body at ten seconds without retry or late callback", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn(),
    fetcher = vi.fn<typeof fetch>(
      async () => new Response(new ReadableStream({ cancel })),
    );
  const { load, callbacks } = setup(fetcher);
  load();
  await vi.advanceTimersByTimeAsync(10001);
  expect(callbacks.onTimeout).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
  expect(callbacks.onError).not.toHaveBeenCalled();
  expect(callbacks.onSuccess).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledOnce();
});
it("destroy prevents a late fetch from succeeding and cancels its body", async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn<typeof fetch>(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const { load, loader, callbacks } = setup(fetcher);
  load();
  loader.destroy();
  const cancel = vi.fn();
  resolve(new Response(new ReadableStream({ cancel })));
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  expect(callbacks.onSuccess).not.toHaveBeenCalled();
  expect(callbacks.onError).not.toHaveBeenCalled();
  expect(loader.context).toBeNull();
});
