import { describe, it, expect, vi } from "vitest";
import { handleMediaProxy } from "../src/api/media-proxy";
const event = "22222222-2222-4222-8222-222222222222";
const post = "33333333-3333-4333-8333-333333333333";
const generation = `${event}.${"a".repeat(64)}`;
const cookie = `__Host-koko_generation=${generation}; __Host-koko_session=v1.${generation}.synthetic.access.signature`;
const origin = "https://web.example.test";
const path = `/media/${event}/${post}/webp-600`;
const original = `/api/admin/posts/${post}/original?expected_version=1`;
const config = {
  KOKO_API_PROXY_ENABLED: "true",
  KOKO_API_COOKIE_ENABLED: "true",
  KOKO_MEDIA_DELIVERY_ENABLED: "true",
  KOKO_ADMIN_ORIGINALS_ENABLED: "true",
  KOKO_EVENT_ID: event,
  KOKO_WEB_ORIGIN: origin,
  KOKO_API_UPSTREAM_ORIGIN: "https://koko-api-dev.arcer-jp.workers.dev",
  KOKO_API_ACCESS_CLIENT_ID: "synthetic-id",
  KOKO_API_ACCESS_CLIENT_SECRET: "synthetic-secret",
};
const req = (p = path, headers = {}) =>
  new Request(origin + p, {
    headers: { cookie, "sec-fetch-site": "same-origin", ...headers },
  });
const ok = (type = "image/webp", extra = {}) =>
  new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-type": type, "content-length": "3", ...extra },
  });
describe("fixed authenticated media proxy", () => {
  it("forwards only server credentials and generation-checked session", async () => {
    const f = vi.fn<typeof fetch>(async () =>
      ok("image/webp", {
        "set-cookie": "bad=secret",
        location: "https://private.test",
        "x-object-key": "private",
      }),
    );
    const r = await handleMediaProxy(
      req(path, {
        "cf-access-client-id": "attacker",
        "x-forwarded-host": "attacker",
      }),
      config,
      f,
    );
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(String(f.mock.calls[0]![0])).toBe(
      config.KOKO_API_UPSTREAM_ORIGIN + path,
    );
    const h = new Headers(f.mock.calls[0]![1]!.headers);
    expect(h.get("cookie")).toBe(
      "__Host-koko_session=synthetic.access.signature",
    );
    expect(h.get("x-event-id")).toBe(event);
    expect(h.get("cf-access-client-id")).toBe(config.KOKO_API_ACCESS_CLIENT_ID);
    expect(h.has("x-forwarded-host")).toBe(false);
    expect(r.headers.has("set-cookie")).toBe(false);
    expect(r.headers.has("location")).toBe(false);
    expect(r.headers.has("x-object-key")).toBe(false);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(f.mock.calls[0]![1]).toMatchObject({
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
    });
  });
  it("downloads operator original with fixed attachment name, not upstream metadata", async () => {
    const f = vi.fn<typeof fetch>(async () =>
      ok("application/octet-stream", {
        "content-disposition": "inline; filename=unsafe.html",
      }),
    );
    const r = await handleMediaProxy(req(original), config, f);
    expect(r.headers.get("content-disposition")).toBe(
      `attachment; filename="${post}-original.bin"`,
    );
    expect(r.headers.get("content-security-policy")).toContain("sandbox");
    expect(String(f.mock.calls[0]![0])).toBe(
      `${config.KOKO_API_UPSTREAM_ORIGIN}/admin/posts/${post}/original?expected_version=1`,
    );
    await r.arrayBuffer();
  });
  it.each([
    ["/media/x/y/webp-600", 400],
    [path.replace(event, post), 400],
    [path + "?token=secret", 404],
    [path.replace("webp-600", "https:%2f%2fattacker"), 404],
    [original + "&expected_version=2", 400],
    [original.replace("=1", "=0"), 400],
    [original.replace("=1", "=2147483648"), 400],
    [original + "&url=https://attacker", 400],
    ["/api/anything", 404],
  ])("rejects route %s", async (p, status) => {
    const f = vi.fn<typeof fetch>();
    const r = await handleMediaProxy(req(String(p)), config, f);
    expect(r.status).toBe(status);
    expect(f).not.toHaveBeenCalled();
  });
  it.each([
    [{ cookie: "" }, 401],
    [{ authorization: "Bearer malicious" }, 401],
    [{ cookie: cookie + "; __Host-koko_generation=other" }, 401],
    [{ origin: "https://attacker.test" }, 403],
    [{ "sec-fetch-site": "cross-site" }, 403],
    [{ "sec-fetch-site": "same-site" }, 403],
    [{ "x-event-id": post }, 403],
    [{ "content-encoding": "gzip" }, 403],
    [{ range: "bytes=0-1,3-4" }, 416],
    [{ range: "bytes=-" }, 416],
  ])("rejects malformed request %#", async (h, status) => {
    const f = vi.fn<typeof fetch>();
    const r = await handleMediaProxy(req(path, h), config, f);
    expect(r.status).toBe(status);
    expect(f).not.toHaveBeenCalled();
  });
  it.each([
    "KOKO_API_PROXY_ENABLED",
    "KOKO_API_COOKIE_ENABLED",
    "KOKO_MEDIA_DELIVERY_ENABLED",
    "KOKO_API_ACCESS_CLIENT_SECRET",
    "KOKO_EVENT_ID",
    "KOKO_API_UPSTREAM_ORIGIN",
  ])("closed without %s", async (k) => {
    const f = vi.fn<typeof fetch>();
    const r = await handleMediaProxy(req(), { ...config, [k]: "" }, f);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(f).not.toHaveBeenCalled();
  });
  it.each([301, 302, 307, 400, 401, 403, 404, 409, 416, 429, 500])(
    "never reflects error/redirect %i",
    async (status) => {
      const r = await handleMediaProxy(
        req(),
        config,
        async () =>
          new Response("secret", {
            status,
            headers: {
              location: "https://secret.test",
              "set-cookie": "secret",
            },
          }),
      );
      expect(r.status).toBe(
        [401, 403, 404, 409, 416, 429].includes(status) ? status : 502,
      );
      expect(await r.text()).toBe("");
      expect(r.headers.has("location")).toBe(false);
    },
  );
  it.each(["text/html", "application/json", "image/svg+xml", "text/plain"])(
    "rejects unsafe type %s",
    async (type) => {
      expect(
        (await handleMediaProxy(req(), config, async () => ok(type))).status,
      ).toBe(502);
    },
  );
  it.each(["-1", "0", "3.1", "5492189429761", "Infinity"])(
    "rejects invalid length %s",
    async (n) => {
      expect(
        (
          await handleMediaProxy(req(), config, async () =>
            ok("image/webp", { "content-length": n }),
          )
        ).status,
      ).toBe(502);
    },
  );
  it("enforces streaming length after headers", async () => {
    const r = await handleMediaProxy(req(), config, async () =>
      ok("image/webp", { "content-length": "2" }),
    );
    await expect(r.arrayBuffer()).rejects.toThrow("Media transfer interrupted");
  });
  it("does not buffer a full original and cancels upstream on downstream cancel", async () => {
    const cancel = vi.fn();
    const r = await handleMediaProxy(
      req(original),
      config,
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": "99999",
          },
        }),
    );
    await r.body!.cancel();
    expect(cancel).toHaveBeenCalled();
  });
  it("supports a validated single byte range", async () => {
    const f = vi.fn<typeof fetch>(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 206,
          headers: {
            "content-type": "video/mp4",
            "content-length": "3",
            "content-range": "bytes 2-4/10",
          },
        }),
    );
    const r = await handleMediaProxy(
      req(path.replace("webp-600", "mp4"), { range: "bytes=2-4" }),
      config,
      f,
    );
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 2-4/10");
    await r.arrayBuffer();
    expect(new Headers(f.mock.calls[0]![1]!.headers).get("range")).toBe(
      "bytes=2-4",
    );
  });
  it.each(["audio/mp4", "audio/aac", "video/iso.segment"])(
    "relays the authorized HLS child type %s",
    async (type) => {
      const r = await handleMediaProxy(
        req(path.replace("webp-600", "hls-opaque.child")),
        config,
        async () => ok(type),
      );
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe(type);
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    },
  );
  it.each(["bytes=-0", "bytes=4-2", "bytes=9007199254740993-"])(
    "rejects invalid range semantics %s",
    async (range) => {
      const f = vi.fn<typeof fetch>();
      expect(
        (await handleMediaProxy(req(path, { range }), config, f)).status,
      ).toBe(416);
      expect(f).not.toHaveBeenCalled();
    },
  );
  it("unvalidated If-Range falls back to a full authenticated response", async () => {
    const f = vi.fn<typeof fetch>(async () => ok());
    const r = await handleMediaProxy(
      req(path, { range: "bytes=0-1", "if-range": "untrusted" }),
      config,
      f,
    );
    expect(r.status).toBe(200);
    expect(new Headers(f.mock.calls[0]![1]!.headers).has("range")).toBe(false);
    await r.arrayBuffer();
  });
  it.each(["bytes 3-5/10", "bytes 0-2/10"])(
    "rejects internally valid but wrong range response %s",
    async (range) => {
      const r = await handleMediaProxy(
        req(path, { range: "bytes=2-4" }),
        config,
        async () =>
          new Response(new Uint8Array(3), {
            status: 206,
            headers: {
              "content-type": "video/mp4",
              "content-length": "3",
              "content-range": range,
            },
          }),
      );
      expect(r.status).toBe(502);
    },
  );
  it.each([
    ["bytes=-3", "bytes 7-9/10"],
    ["bytes=7-", "bytes 7-9/10"],
    ["bytes=7-20", "bytes 7-9/10"],
  ])(
    "relays a correct suffix/open/clipped range %s",
    async (range, contentRange) => {
      const r = await handleMediaProxy(
        req(path, { range }),
        config,
        async () =>
          new Response(new Uint8Array(3), {
            status: 206,
            headers: {
              "content-type": "video/mp4",
              "content-length": "3",
              "content-range": contentRange!,
            },
          }),
      );
      expect(r.status).toBe(206);
      await r.arrayBuffer();
    },
  );
  it("bounds a non-cooperative header fetch and cancels its late body", async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (r: Response) => void;
      const pending = handleMediaProxy(
        req(),
        config,
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await pending).status).toBe(502);
      const cancel = vi.fn();
      resolve(
        new Response(new ReadableStream({ cancel }), {
          headers: { "content-type": "image/webp" },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds a stalled response body", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const r = await handleMediaProxy(
        req(),
        config,
        async () =>
          new Response(new ReadableStream({ cancel }), {
            headers: { "content-type": "image/webp", "content-length": "3" },
          }),
      );
      const rejected = expect(r.arrayBuffer()).rejects.toThrow(
        "Media transfer interrupted",
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["bytes 4-2/10", "bytes 2-4/4", "bytes 2-5/10", "bad"])(
    "rejects invalid range response %s",
    async (range) => {
      const r = await handleMediaProxy(
        req(path, { range: "bytes=2-4" }),
        config,
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 206,
            headers: {
              "content-type": "video/mp4",
              "content-length": "3",
              "content-range": range,
            },
          }),
      );
      expect(r.status).toBe(502);
    },
  );
});
