import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUploadClient } from "../src/api/upload-client";
import {
  completion,
  signedPut,
  ticket,
  tickets,
  uploadRequest,
} from "../src/api/upload-contract";
import {
  accountId,
  csrf,
  destination,
  eventId,
  input,
  multipart,
  origin,
  postId,
  receipt,
  signed,
  single,
  uploadId,
} from "./upload-fixture";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
beforeEach(() =>
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-05T00:00:00Z")),
);
const api = (fetcher: typeof fetch) =>
  createUploadClient(new URL(`${origin}/api/`), destination, fetcher);
describe("upload control client", () => {
  it("accepts 100 signed parts and a 10,000-part completion within bounded JSON", async () => {
    const numbers = Array.from({ length: 100 }, (_, i) => i + 1);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          parts: numbers.map((n) => ({ part_number: n, ...signed(n) })),
        }),
      )
      .mockResolvedValueOnce(Response.json(receipt, { status: 202 }));
    const client = api(fetcher);
    expect((await client.parts(uploadId, numbers, csrf)).parts).toHaveLength(
      100,
    );
    const parts = Array.from({ length: 10000 }, (_, i) => ({
      part_number: i + 1,
      etag: "d".repeat(32),
    }));
    expect(
      await client.complete(postId, { upload_id: uploadId, parts }, csrf),
    ).toEqual(receipt);
    expect(
      new TextEncoder().encode(String(fetcher.mock.calls[1]![1]!.body)).length,
    ).toBeLessThan(1024 * 1024);
  });
  it("rejects a refreshed ticket for another upload", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ ...single(), upload_id: postId }),
    );
    await expect(api(fetcher).refresh(uploadId, csrf)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });
  it("opens, refreshes without body, signs parts and accepts only the 202 receipt", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ ...single(), internal: "discard" }),
      )
      .mockResolvedValueOnce(Response.json(single()))
      .mockResolvedValueOnce(
        Response.json({
          parts: [{ part_number: 1, ...signed(1), internal: "discard" }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ ...receipt, internal: "discard" }, { status: 202 }),
      );
    const client = api(fetcher);
    expect(await client.open(input, csrf)).toEqual(single());
    expect(await client.refresh(uploadId, csrf)).toEqual(single());
    expect(await client.parts(uploadId, [1], csrf)).toEqual({
      parts: [{ part_number: 1, ...signed(1) }],
    });
    expect(
      await client.complete(postId, { upload_id: uploadId }, csrf),
    ).toEqual(receipt);
    expect(
      fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual([
      "/api/uploads",
      `/api/uploads/${uploadId}/refresh`,
      `/api/uploads/${uploadId}/parts`,
      `/api/posts/${postId}/complete`,
    ]);
    expect(fetcher.mock.calls[1]![1]!.body).toBeUndefined();
    for (const [, init] of fetcher.mock.calls)
      expect(init).toMatchObject({
        method: "POST",
        mode: "same-origin",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { "X-CSRF-Token": csrf, "X-Event-ID": eventId },
      });
  });
  it.each([
    {},
    { file_size_bytes: 0 },
    { file_size_bytes: 1.5 },
    { file_size_bytes: Infinity },
    { content_type: "image/png\r\nheader" },
    { theme_id: "not-id" },
    { client_request_id: "bad" },
    { original_scope: "client_trimmed" },
    { extra: true },
    { kind: ["video"], original_scope: "client_trimmed" },
    { kind: "video", original_scope: ["client_trimmed"] },
  ])("rejects malformed admission %j", async (change) => {
    const fetcher = vi.fn<typeof fetch>();
    const bad = Object.keys(change).length === 0 ? {} : { ...input, ...change };
    await expect(
      api(fetcher).open(bad as typeof input, csrf),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(
    [
      [],
      [0],
      [10001],
      [1, 1],
      [1.1],
      Array.from({ length: 101 }, (_, i) => i + 1),
    ].map((numbers) => [numbers]),
  )("rejects invalid parts", async (numbers) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      api(fetcher).parts(uploadId, numbers, csrf),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["", "short", "a".repeat(257), "a".repeat(32) + "\n"])(
    "requires safe CSRF",
    async (token) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(api(fetcher).open(input, token)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("normalizes IDs and freezes configuration", async () => {
    const base = new URL(`${origin}/api/`),
      scope = { ...destination };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(single()));
    const client = createUploadClient(base, scope, fetcher);
    base.hostname = "elsewhere.test";
    scope.r2AccountId = "f".repeat(32);
    await client.open(input, csrf);
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${origin}/api/uploads`);
  });
  it("rejects another browser origin before and after construction", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = api(fetcher);
    vi.stubGlobal("location", { origin: "https://elsewhere.test" });
    expect(() => api(fetcher)).toThrow(TypeError);
    await expect(client.open(input, csrf)).rejects.toThrow(TypeError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    "http://remote.test/api/",
    "https://u:p@web.example.test/api/",
    `${origin}/api`,
    `${origin}/api/?x=1`,
    `${origin}/api/#x`,
  ])("rejects unsafe base %s", (url) =>
    expect(() => createUploadClient(new URL(url), destination)).toThrow(
      TypeError,
    ),
  );
  it("preserves known errors and drops provider internals", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(
        { code: "RATE_LIMITED", request_id: uploadId, secret: "never return" },
        { status: 429 },
      ),
    );
    await expect(api(fetcher).open(input, csrf)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      requestId: uploadId,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    Response.json(receipt),
    Response.json({ ...receipt, id: uploadId }, { status: 202 }),
    Response.json({ ...receipt, event_id: uploadId }, { status: 202 }),
    Response.json({ ...receipt, status: "approved" }, { status: 202 }),
    Response.json({ ...receipt, version: 1 }, { status: 202 }),
  ])("requires matching immutable completion receipt", async (response) => {
    await expect(
      api(vi.fn<typeof fetch>(async () => response)).complete(
        postId,
        { upload_id: uploadId },
        csrf,
      ),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
  it.each([
    Response.json({ code: "FORBIDDEN", request_id: uploadId }, { status: 401 }),
    new Response("secret"),
    new Response(null, { status: 302, headers: { location: origin } }),
    Response.json({ data: "x".repeat(1024 * 1024) }),
  ])("rejects invalid upstream payload", async (response) => {
    await expect(
      api(vi.fn<typeof fetch>(async () => response)).open(input, csrf),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
  it("does not leak network errors or retry", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error("signed-secret-url");
    });
    await expect(api(fetcher).open(input, csrf)).rejects.toMatchObject({
      code: "NETWORK_UNAVAILABLE",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("cancels before send and during response streaming", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(single()));
    controller.abort();
    await expect(
      api(fetcher).open(input, csrf, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
    const next = new AbortController();
    const streamed = api(
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            new ReadableStream({
              pull() {
                next.abort();
              },
              cancel,
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    ).open(input, csrf, next.signal);
    await expect(streamed).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalled();
  });
});

describe("upload contract projections", () => {
  it("accepts Postgres timestamptz offsets and microseconds in multipart tickets", () => {
    const expires_at = "2026-10-05T09:10:00.000123+09:00";
    expect(
      ticket({ ...multipart(), expires_at }, destination, Date.now()),
    ).toEqual({ ...multipart(), expires_at });
    expect(
      ticket(
        { ...multipart(), expires_at: "2026-10-05T00:10:00+00:00" },
        destination,
        Date.now(),
      ).mode,
    ).toBe("multipart");
  });
  it("retains valid single/multipart only", () => {
    expect(ticket(single(), destination, Date.now())).toEqual(single());
    expect(
      ticket({ ...multipart(), internal: "hidden" }, destination, Date.now()),
    ).toEqual(multipart());
  });
  it.each([
    (url: URL) => (url.hostname = "evil.test"),
    (url: URL) => (url.hostname = `${"f".repeat(32)}.r2.cloudflarestorage.com`),
    (url: URL) => (url.protocol = "http:"),
    (url: URL) => (url.username = "secret"),
    (url: URL) => (url.hash = "leak"),
    (url: URL) => (url.pathname = url.pathname.replace(eventId, uploadId)),
    (url: URL) =>
      (url.pathname = url.pathname.replace(
        "koko-dev-originals",
        "koko-dev-derived",
      )),
    (url: URL) => url.searchParams.set("X-Amz-Expires", "901"),
    (url: URL) => url.searchParams.set("X-Amz-SignedHeaders", "host"),
    (url: URL) => url.searchParams.append("X-Amz-Signature", "d".repeat(64)),
    (url: URL) => url.searchParams.set("redirect", "evil"),
    (url: URL) => url.searchParams.delete("X-Amz-Credential"),
    (url: URL) => url.searchParams.set("X-Amz-Date", "invalid"),
    (url: URL) => url.searchParams.set("X-Amz-Content-Sha256", "not-unsigned"),
  ])("rejects tampered signed destination", (change) => {
    const s = single();
    const url = new URL(s.put_url);
    change(url);
    expect(() =>
      ticket({ ...s, put_url: url.href }, destination, Date.now()),
    ).toThrow();
  });
  it.each([
    {
      required_headers: {
        "content-type": "image/png",
        authorization: "secret",
      },
    },
    { part_size_bytes: 5 },
    {
      required_headers: {
        "content-type": "image/png",
        "if-none-match": "*",
        cookie: "secret",
      },
    },
    { post_id: uploadId },
    { expires_at: new Date(Date.now() + 901000).toISOString() },
  ])("rejects invalid single ticket %j", (change) =>
    expect(() =>
      ticket({ ...single(), ...change }, destination, Date.now()),
    ).toThrow(),
  );
  it.each([0, 1, 5 * 1024 ** 3 + 1, 1.5])(
    "rejects invalid part size %s",
    (size) =>
      expect(() =>
        ticket(
          { ...multipart(), part_size_bytes: size },
          destination,
          Date.now(),
        ),
      ).toThrow(),
  );
  it("rejects expired tickets", () =>
    expect(() =>
      ticket(
        { ...single(), ...signed(undefined, Date.now() - 601000) },
        destination,
        Date.now(),
      ),
    ).toThrowError(expect.objectContaining({ code: "UPLOAD_EXPIRED" })));
  it("requires exact requested parts and same provider identity", () => {
    const one = { part_number: 1, ...signed(1) },
      two = { part_number: 2, ...signed(2) };
    expect(
      tickets({ parts: [two, one] }, [1, 2], destination, Date.now()).parts.map(
        (p) => p.part_number,
      ),
    ).toEqual([1, 2]);
    for (const parts of [
      [],
      [one, one],
      [one],
      [
        one,
        {
          ...two,
          put_url: two.put_url.replace("synthetic-provider-id", "other"),
        },
      ],
    ])
      expect(() =>
        tickets({ parts }, [1, 2], destination, Date.now()),
      ).toThrow();
    expect(() =>
      signedPut(two.put_url, two.expires_at, destination, 1),
    ).toThrow();
  });
  it("normalizes a complete manifest, rejects duplicates/gaps/non-MD5", () => {
    expect(
      completion({
        upload_id: uploadId,
        parts: [{ part_number: 1, etag: `"${"a".repeat(32)}"` }],
      }),
    ).toEqual({
      upload_id: uploadId,
      parts: [{ part_number: 1, etag: "a".repeat(32) }],
    });
    for (const parts of [
      [],
      [{ part_number: 2, etag: "a".repeat(32) }],
      [{ part_number: 1, etag: "secret" }],
      [{ part_number: 1, etag: "a".repeat(32), extra: true }],
    ])
      expect(() => completion({ upload_id: uploadId, parts })).toThrow();
  });
  it("rejects invalid account IDs and returns declared metadata only", () => {
    expect(() =>
      createUploadClient(new URL(origin), {
        eventId,
        r2AccountId: accountId + "f",
      }),
    ).toThrow();
    expect(uploadRequest(input)).toEqual({ ...input, theme_id: null });
  });
});
