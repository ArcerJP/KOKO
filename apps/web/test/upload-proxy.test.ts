import { afterEach, expect, it, vi } from "vitest";
import { handleUploadProxy } from "../src/api/upload-proxy";
import {
  accountId,
  csrf,
  eventId,
  input,
  origin,
  postId,
  receipt,
  signed,
  single,
  multipart,
  uploadId,
} from "./upload-fixture";

const generation = `22222222-2222-4222-8222-222222222222.${"a".repeat(64)}`;
const cookie = `__Host-koko_generation=${generation}; __Host-koko_session=v1.${generation}.synthetic.access.signature`;
const config = {
  KOKO_API_PROXY_ENABLED: "true",
  KOKO_API_COOKIE_ENABLED: "true",
  KOKO_UPLOAD_PROXY_ENABLED: "true",
  KOKO_WEB_ORIGIN: origin,
  KOKO_API_UPSTREAM_ORIGIN: "https://koko-api-dev.arcer-jp.workers.dev",
  KOKO_R2_ACCOUNT_ID: accountId,
  KOKO_API_ACCESS_CLIENT_ID: "synthetic-service-id-only",
  KOKO_API_ACCESS_CLIENT_SECRET: "synthetic-service-secret-only",
};
function request(
  path = "uploads",
  body: unknown = input,
  headers: Record<string, string> = {},
  method = "POST",
) {
  return new Request(`${origin}/api/${path}`, {
    method,
    headers: {
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      Cookie: cookie,
      "X-Event-ID": eventId,
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
      ...headers,
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
}
afterEach(() => vi.useRealTimers());
it("normalizes upper-case UUID paths without changing the allowed operation", async () => {
  const lower = "abcdefab-0000-4000-8000-000000000001";
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ ...single(), upload_id: lower }),
  );
  const response = await handleUploadProxy(
    request(`uploads/${lower.toUpperCase()}/refresh`, null),
    config,
    fetcher,
  );
  expect(response.status).toBe(200);
  expect(String(fetcher.mock.calls[0]![0])).toBe(
    `${config.KOKO_API_UPSTREAM_ORIGIN}/uploads/${lower}/refresh`,
  );
});
it.each([
  ["uploads", input, () => single(), 200],
  [`uploads/${uploadId}/refresh`, null, () => single(), 200],
  [
    `uploads/${uploadId}/recover`,
    null,
    () => ({ previous_upload_id: uploadId, ticket: multipart() }),
    200,
  ],
  [
    `uploads/${uploadId}/parts`,
    { part_numbers: [1] },
    () => ({ parts: [{ part_number: 1, ...signed(1) }] }),
    200,
  ],
  [`posts/${postId}/complete`, { upload_id: uploadId }, () => receipt, 202],
] as const)(
  "forwards only %s JSON and strips request/response secrets",
  async (path, body, output, status) => {
    // Signed fixtures depend on the current second; compare the same snapshot.
    const expected = output();
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          ...expected,
          ...(path.endsWith("/recover") ? {} : { private: "discard" }),
        },
        {
          status,
          headers: {
            "Set-Cookie": "private=discard",
            Location: "https://elsewhere.test",
            "Access-Control-Allow-Origin": "*",
          },
        },
      ),
    );
    const response = await handleUploadProxy(
      request(path, body, {
        Cookie: `${cookie}; sb-test=secret; CF_Authorization=secret`,
        "CF-Access-Client-Secret": "caller-secret",
      }),
      config,
      fetcher,
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(expected);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [target, init] = fetcher.mock.calls[0]!;
    expect(String(target)).toBe(`${config.KOKO_API_UPSTREAM_ORIGIN}/${path}`);
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      redirect: "manual",
      cache: "no-store",
    });
    const h = new Headers(init?.headers);
    expect(h.get("cookie")).toBe(
      "__Host-koko_session=synthetic.access.signature",
    );
    expect(h.get("authorization")).toBeNull();
    expect(h.get("CF-Access-Client-Secret")).toBe(
      config.KOKO_API_ACCESS_CLIENT_SECRET,
    );
    expect(h.get("X-CSRF-Token")).toBe(csrf);
    if (body === null) expect(init?.body).toBeUndefined();
  },
);
it.each([
  "KOKO_UPLOAD_PROXY_ENABLED",
  "KOKO_API_PROXY_ENABLED",
  "KOKO_API_COOKIE_ENABLED",
  "KOKO_WEB_ORIGIN",
  "KOKO_API_UPSTREAM_ORIGIN",
  "KOKO_R2_ACCOUNT_ID",
  "KOKO_API_ACCESS_CLIENT_ID",
  "KOKO_API_ACCESS_CLIENT_SECRET",
])("fails closed without %s", async (key) => {
  const fetcher = vi.fn<typeof fetch>();
  const response = await handleUploadProxy(
    request(),
    { ...config, [key]: "" },
    fetcher,
  );
  expect(response.status).toBe(key === "KOKO_UPLOAD_PROXY_ENABLED" ? 404 : 500);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  [{ Origin: "https://attacker.test" }, 403],
  [{ "Sec-Fetch-Site": "cross-site" }, 403],
  [{ Cookie: "__Host-koko_session=synthetic.access.signature" }, 401],
  [{ "X-Event-ID": "bad" }, 400],
  [{ "X-CSRF-Token": "" }, 403],
  [{ "Content-Type": "text/plain" }, 400],
  [{ "Content-Encoding": "gzip" }, 400],
  [{ Authorization: "Bearer not-accepted" }, 401],
] as const)("rejects invalid headers %j", async (headers, status) => {
  const fetcher = vi.fn<typeof fetch>();
  expect(
    (
      await handleUploadProxy(
        request("uploads", input, headers),
        config,
        fetcher,
      )
    ).status,
  ).toBe(status);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["GET", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"])(
  "blocks %s",
  async (method) => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await handleUploadProxy(
      request("uploads", null, {}, method),
      config,
      fetcher,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it.each([
  "uploads?x=1",
  `uploads/${uploadId}/refresh?x=1`,
  "uploads/bad/parts",
  "uploads/x/y",
  "media/x",
])("rejects route %s", async (path) => {
  const fetcher = vi.fn<typeof fetch>();
  expect((await handleUploadProxy(request(path), config, fetcher)).ok).toBe(
    false,
  );
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  [`uploads/${uploadId}/refresh`, {}],
  [`uploads/${uploadId}/recover`, {}],
  ["uploads", { ...input, content_type: "a".repeat(4096) }],
  [`uploads/${uploadId}/parts`, { part_numbers: [1], extra: true }],
  [
    `posts/${postId}/complete`,
    { upload_id: uploadId, parts: "a".repeat(1024 * 1024) },
  ],
])("rejects body shape/size for %s", async (path, body) => {
  const fetcher = vi.fn<typeof fetch>();
  expect(
    (await handleUploadProxy(request(path as string, body), config, fetcher))
      .status,
  ).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["secret-value", "secret-key", "redirect", "html", "large"])(
  "rejects upstream %s",
  async (type) => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      type === "redirect"
        ? new Response(null, { status: 302, headers: { Location: origin } })
        : type === "html"
          ? new Response("private")
          : Response.json({
              ...single(),
              ...(type === "secret-value"
                ? { extra: config.KOKO_API_ACCESS_CLIENT_SECRET }
                : type === "secret-key"
                  ? { [config.KOKO_API_ACCESS_CLIENT_SECRET]: "hidden" }
                  : { extra: "a".repeat(16384) }),
            }),
    );
    const response = await handleUploadProxy(request(), config, fetcher);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(
      config.KOKO_API_ACCESS_CLIENT_SECRET,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it("bounds stalled upstream and body without retry", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
  const result = handleUploadProxy(request(), config, fetcher);
  await vi.advanceTimersByTimeAsync(10001);
  expect((await result).status).toBe(500);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const cancel = vi.fn();
  const req = new Request(`${origin}/api/uploads`, {
    method: "POST",
    headers: request().headers,
    body: new ReadableStream({ cancel }),
    duplex: "half",
  } as RequestInit);
  const pending = handleUploadProxy(req, config, fetcher);
  await vi.advanceTimersByTimeAsync(1001);
  expect((await pending).status).toBe(400);
  expect(cancel).toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
