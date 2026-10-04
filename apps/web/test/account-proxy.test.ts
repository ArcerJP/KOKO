import { afterEach, describe, expect, it, vi } from "vitest";
import { errors } from "@koko/contract";
import { handleAccountProxy } from "../src/api/account-proxy";
import { mockEventId, mockMe } from "../src/mocks/handlers";

const origin = "https://web.example.test";
const upstream = "https://koko-api-dev.arcer-jp.workers.dev";
const rawCookie = "__Host-koko_session=synthetic.access.signature";
const generation = `22222222-2222-4222-8222-222222222222.${"a".repeat(64)}`;
const generationCookie = `__Host-koko_generation=${generation}`;
const apiCookie = `__Host-koko_session=v1.${generation}.synthetic.access.signature`;
const cookie = `${generationCookie}; ${apiCookie}`;
const csrf = "synthetic-csrf-value-for-tests-only";
const requestId = "00000000-0000-4000-8000-000000000001";
const accessId = "synthetic-access-client-id-for-tests-only";
const accessSecret = "synthetic-access-client-secret-for-tests-only";
const config = {
  KOKO_API_PROXY_ENABLED: "true",
  KOKO_API_COOKIE_ENABLED: "true",
  KOKO_WEB_ORIGIN: origin,
  KOKO_API_UPSTREAM_ORIGIN: upstream,
  KOKO_API_ACCESS_CLIENT_ID: accessId,
  KOKO_API_ACCESS_CLIENT_SECRET: accessSecret,
};
type Resource = "me" | "consents";
function request(
  method = "GET",
  resource: Resource = "me",
  headers: Record<string, string | null> = {},
  body?: BodyInit,
  url = `${origin}/api/${resource}`,
  signal?: AbortSignal,
) {
  const merged = new Headers({
    "X-Event-ID": mockEventId,
    Cookie: cookie,
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
    ...(method !== "GET" && method !== "HEAD"
      ? { "Content-Type": "application/json", "X-CSRF-Token": csrf }
      : {}),
  });
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) merged.delete(name);
    else merged.set(name, value);
  }
  return new Request(url, {
    method,
    headers: merged,
    ...(body === undefined ? {} : { body }),
    ...(signal ? { signal } : {}),
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  });
}
function success(method = "GET") {
  return Response.json(
    method === "GET"
      ? { ...mockMe, csrf_token: csrf, private_data: "must-not-return" }
      : { request_id: requestId, private_data: "must-not-return" },
    {
      headers: {
        "Set-Cookie": "upstream-secret=must-not-return",
        "Cache-Control": "public, max-age=999",
        "Access-Control-Allow-Origin": "*",
        Location: "https://other.example.test",
      },
    },
  );
}
async function expectError(response: Response, code: keyof typeof errors) {
  expect(response.status).toBe(errors[code].status);
  expect(await response.json()).toEqual({
    code,
    request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
  });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.has("set-cookie")).toBe(false);
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("固定された本人情報中継", () => {
  it.each([
    ["GET", "me", undefined],
    ["PATCH", "me", { display_name: "🐱飯島" }],
    ["POST", "consents", { terms_version: "2026-10", accepted: true }],
  ] as const)(
    "%s %sを1回だけ転送し入出力を投影",
    async (method, resource, input) => {
      const fetcher = vi.fn<typeof fetch>(async () => success(method));
      const response = await handleAccountProxy(
        request(
          method,
          resource,
          {
            Cookie: `sb-project-auth-token=private-ssr; ${cookie}; CF_Authorization=private-access`,
            "CF-Access-Client-Id": "must-not-forward",
            "CF-Access-Client-Secret": "must-not-forward",
            "X-Forwarded-Host": "attacker.example.test",
            "X-Internal-Key": "must-not-forward",
          },
          input === undefined ? undefined : JSON.stringify(input),
        ),
        resource,
        config,
        fetcher,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(
        method === "GET"
          ? { ...mockMe, csrf_token: csrf }
          : { request_id: requestId },
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [target, init] = fetcher.mock.calls[0]!;
      expect(String(target)).toBe(`${upstream}/${resource}`);
      expect(init).toMatchObject({
        method,
        credentials: "omit",
        redirect: "manual",
        cache: "no-store",
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
        accept: "application/json",
        "cf-access-client-id": accessId,
        "cf-access-client-secret": accessSecret,
        cookie: rawCookie,
        origin,
        "sec-fetch-site": "same-origin",
        "x-event-id": mockEventId,
        ...(method === "GET"
          ? {}
          : { "content-type": "application/json", "x-csrf-token": csrf }),
      });
      expect(init?.body).toBe(
        input === undefined ? undefined : JSON.stringify(input),
      );
      for (const header of [
        "set-cookie",
        "location",
        "access-control-allow-origin",
        "cf-access-client-id",
        "cf-access-client-secret",
      ])
        expect(response.headers.has(header)).toBe(false);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    },
  );

  it.each([
    {},
    { ...config, KOKO_API_PROXY_ENABLED: undefined },
    { ...config, KOKO_API_PROXY_ENABLED: "TRUE" },
    { ...config, KOKO_API_COOKIE_ENABLED: "false" },
    ...["KOKO_API_ACCESS_CLIENT_ID", "KOKO_API_ACCESS_CLIENT_SECRET"].flatMap(
      (key) =>
        [
          undefined,
          "",
          " value",
          "value ",
          "a b",
          "a\rb",
          "a\nb",
          "a\tb",
          "a\0b",
          "あ",
          "a".repeat(513),
        ].map((value) => ({ ...config, [key]: value })),
    ),
    ...[
      undefined,
      "http://web.example.test",
      `${origin}/`,
      `${origin}/path`,
      `${origin}?x=1`,
      `${origin}#x`,
      "https://name@web.example.test",
      "not a url",
    ].map((value) => ({ ...config, KOKO_WEB_ORIGIN: value })),
    ...[
      undefined,
      "https://other.example.test",
      "http://127.0.0.1",
      `${upstream}/`,
      `${upstream}:444`,
      `${upstream}/me`,
    ].map((value) => ({ ...config, KOKO_API_UPSTREAM_ORIGIN: value })),
  ])("不完全/不正設定を通信前に拒否 %#", async (settings) => {
    const fetcher = vi.fn<typeof fetch>();
    await expectError(
      await handleAccountProxy(request(), "me", settings, fetcher),
      "INTERNAL_ERROR",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "DELETE", "HEAD", "OPTIONS"])(
    "meの%sを拒否",
    async (method) => {
      const fetcher = vi.fn<typeof fetch>();
      const response = await handleAccountProxy(
        request(method),
        "me",
        config,
        fetcher,
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, PATCH");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(["GET", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"])(
    "consentsの%sを拒否",
    async (method) => {
      const response = await handleAccountProxy(
        request(method, "consents"),
        "consents",
        config,
        vi.fn(),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    },
  );

  it.each([
    ["Origin", "https://evil.example.test", "FORBIDDEN"],
    ["Sec-Fetch-Site", "cross-site", "FORBIDDEN"],
    ["Sec-Fetch-Site", "same-site", "FORBIDDEN"],
    ["X-Event-ID", null, "INVALID_INPUT"],
    ["X-Event-ID", "not-uuid", "INVALID_INPUT"],
    ["Cookie", null, "AUTH_REQUIRED"],
    ["Cookie", `${cookie}; ${apiCookie}`, "AUTH_REQUIRED"],
    ["Cookie", `${cookie}; __Host-koko_session.0=chunk`, "AUTH_REQUIRED"],
    ["Cookie", `${generationCookie}; __Host-koko_session`, "AUTH_REQUIRED"],
    ["Cookie", `${generationCookie}; __Host-koko_session=`, "AUTH_REQUIRED"],
    [
      "Cookie",
      `${generationCookie}; __Host-koko_session=v1.${generation}.%61.b.c`,
      "AUTH_REQUIRED",
    ],
    [
      "Cookie",
      `${generationCookie}; __Host-koko_session="v1.${generation}.a.b.c"`,
      "AUTH_REQUIRED",
    ],
    [
      "Cookie",
      `${generationCookie}; __Host-koko_session=v1.${generation}.${"a".repeat(3500)}.b.c`,
      "AUTH_REQUIRED",
    ],
    [
      "Cookie",
      `${cookie}; unrelated=${"a".repeat(16 * 1024)}`,
      "AUTH_REQUIRED",
    ],
    ["Authorization", "Bearer synthetic", "AUTH_REQUIRED"],
    ["Authorization", "", "AUTH_REQUIRED"],
    ["Content-Encoding", "identity", "INVALID_INPUT"],
  ] as const)("入力header %s %sを拒否", async (name, value, code) => {
    const fetcher = vi.fn<typeof fetch>();
    await expectError(
      await handleAccountProxy(
        request("GET", "me", { [name]: value }),
        "me",
        config,
        fetcher,
      ),
      code,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    `${origin}/api/me?target=evil`,
    `${origin}/api/me#fragment`,
    `${origin}/api/other`,
    "https://evil.example.test/api/me",
  ])("要求URLを固定 %s", async (url) => {
    const fetcher = vi.fn<typeof fetch>();
    await expectError(
      await handleAccountProxy(
        request("GET", "me", {}, undefined, url),
        "me",
        config,
        fetcher,
      ),
      "FORBIDDEN",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([null, "none"])(
    "GETはOrigin欠落とmetadata %sを許す",
    async (site) => {
      const response = await handleAccountProxy(
        request("GET", "me", { Origin: null, "Sec-Fetch-Site": site }),
        "me",
        config,
        async () => success(),
      );
      expect(response.status).toBe(200);
    },
  );
  it.each([
    [{ Origin: null }, "FORBIDDEN"],
    [{ "Sec-Fetch-Site": "none" }, "FORBIDDEN"],
    [{ "Content-Type": null }, "INVALID_INPUT"],
    [{ "Content-Type": "text/plain" }, "INVALID_INPUT"],
    [{ "X-CSRF-Token": null }, "FORBIDDEN"],
    [{ "X-CSRF-Token": "short" }, "FORBIDDEN"],
  ] as const)("書込みheader拒否 %#", async (headers, code) => {
    const fetcher = vi.fn<typeof fetch>();
    await expectError(
      await handleAccountProxy(
        request("PATCH", "me", headers, '{"display_name":"名前"}'),
        "me",
        config,
        fetcher,
      ),
      code,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    "not json",
    "[]",
    "null",
    "{}",
    '{"display_name":" "}',
    '{"display_name":"a","role":"admin"}',
    JSON.stringify({ display_name: "a".repeat(51) }),
    JSON.stringify({ display_name: "a\u0000" }),
    JSON.stringify({ display_name: "あ".repeat(400) }),
  ])("書込み入力を通信前に検査 %#", async (body) => {
    const fetcher = vi.fn<typeof fetch>();
    await expectError(
      await handleAccountProxy(
        request("PATCH", "me", {}, body),
        "me",
        config,
        fetcher,
      ),
      "INVALID_INPUT",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { accepted: false, terms_version: "v1" },
    { accepted: true, terms_version: "" },
    { accepted: true, terms_version: "v1", user_id: requestId },
  ])("同意入力を検査 %#", async (input) => {
    const fetcher = vi.fn<typeof fetch>();
    await expectError(
      await handleAccountProxy(
        request("POST", "consents", {}, JSON.stringify(input)),
        "consents",
        config,
        fetcher,
      ),
      "INVALID_INPUT",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("不正UTF-8入力を拒否", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expectError(
      await handleAccountProxy(
        request("PATCH", "me", {}, new Uint8Array([0xff])),
        "me",
        config,
        fetcher,
      ),
      "INVALID_INPUT",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("欠落metadataでもOrigin/CSRF/JSON charset検査を維持", async () => {
    expect(
      (
        await handleAccountProxy(
          request(
            "PATCH",
            "me",
            {
              "Sec-Fetch-Site": null,
              "Content-Type": "application/json; charset=UTF-8",
            },
            '{"display_name":"名前"}',
          ),
          "me",
          config,
          async () => success("PATCH"),
        )
      ).status,
    ).toBe(200);
  });

  it.each([
    () => Response.redirect("https://evil.example.test", 302),
    () =>
      new Response("<html>Access login</html>", {
        headers: { "Content-Type": "text/html" },
      }),
    () =>
      new Response("not json", {
        headers: { "Content-Type": "application/json" },
      }),
    () => Response.json({ ...mockMe }),
    () =>
      Response.json({
        ...mockMe,
        csrf_token: csrf,
        event_id: "00000000-0000-4000-8000-000000000099",
      }),
    () =>
      Response.json({
        ...mockMe,
        csrf_token: csrf,
        extra: "a".repeat(16 * 1024),
      }),
    () =>
      new Response(new Uint8Array([0xff]), {
        headers: { "Content-Type": "application/json" },
      }),
    () =>
      Response.json(
        { code: "FORBIDDEN", request_id: requestId },
        { status: 500 },
      ),
    () =>
      Response.json(
        { code: "UNKNOWN", request_id: requestId },
        { status: 400 },
      ),
    () =>
      Response.json(
        { code: "AUTH_REQUIRED", request_id: "invalid" },
        { status: 401 },
      ),
    () => Response.json({ ...mockMe, csrf_token: csrf }, { status: 201 }),
    () => {
      throw new Error("secret network diagnostic");
    },
  ])("異常上流応答を非公開の固定エラーへ %#", async (reply) => {
    const fetcher = vi.fn<typeof fetch>(async () => reply());
    await expectError(
      await handleAccountProxy(request(), "me", config, fetcher),
      "INTERNAL_ERROR",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    "AUTH_REQUIRED",
    "FORBIDDEN",
    "CONSENT_REQUIRED",
    "ACCOUNT_BANNED",
    "INVALID_INPUT",
    "INTERNAL_ERROR",
  ] as const)("正しい契約エラー %s のみ返す", async (code) => {
    const response = await handleAccountProxy(
      request(),
      "me",
      config,
      async () =>
        Response.json(
          { code, request_id: requestId, secret: "must-not-return" },
          { status: errors[code].status },
        ),
    );
    expect(await response.json()).toEqual({ code, request_id: requestId });
  });
  it("応答喪失後の更新は再送しない", async () => {
    let saves = 0;
    const fetcher = vi.fn<typeof fetch>(async () => {
      saves++;
      throw new Error("response lost");
    });
    await expectError(
      await handleAccountProxy(
        request("PATCH", "me", {}, '{"display_name":"名前"}'),
        "me",
        config,
        fetcher,
      ),
      "INTERNAL_ERROR",
    );
    expect(saves).toBe(1);
  });
});

describe("サーバー専用Access資格情報", () => {
  it("呼出しごとに環境値を読み、欠落時は利用者headerでも補完しない", async () => {
    for (const [key, value] of Object.entries(config)) vi.stubEnv(key, value);
    const fetcher = vi.fn<typeof fetch>(async () => success());
    expect(
      (await handleAccountProxy(request(), "me", undefined, fetcher)).status,
    ).toBe(200);
    const rotated = "synthetic-rotated-secret-for-tests-only";
    vi.stubEnv("KOKO_API_ACCESS_CLIENT_SECRET", rotated);
    expect(
      (await handleAccountProxy(request(), "me", undefined, fetcher)).status,
    ).toBe(200);
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get(
        "cf-access-client-secret",
      ),
    ).toBe(accessSecret);
    expect(
      new Headers(fetcher.mock.calls[1]?.[1]?.headers).get(
        "cf-access-client-secret",
      ),
    ).toBe(rotated);
    vi.stubEnv("KOKO_API_ACCESS_CLIENT_SECRET", undefined);
    await expectError(
      await handleAccountProxy(
        request("GET", "me", {
          "CF-Access-Client-Id": accessId,
          "CF-Access-Client-Secret": rotated,
        }),
        "me",
        undefined,
        fetcher,
      ),
      "INTERNAL_ERROR",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["a".repeat(64), `cfast_${"a".repeat(48)}`, "a".repeat(512)])(
    "安全なopaque形式を上流へ委譲 %#",
    async (value) => {
      const fetcher = vi.fn<typeof fetch>(async () => success());
      expect(
        (
          await handleAccountProxy(
            request(),
            "me",
            {
              ...config,
              KOKO_API_ACCESS_CLIENT_SECRET: value,
            },
            fetcher,
          )
        ).status,
      ).toBe(200);
      expect(
        new Headers(fetcher.mock.calls[0]?.[1]?.headers).get(
          "cf-access-client-secret",
        ),
      ).toBe(value);
    },
  );

  it.each([401, 403, 302, 307, 503])(
    "Access拒否 %s は再送/redirect/生本文公開なし",
    async (status) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response(accessSecret, {
            status,
            headers: {
              "Content-Type": "text/html",
              Location: "https://evil.example.test",
              "Set-Cookie": accessSecret,
            },
          }),
      );
      await expectError(
        await handleAccountProxy(request(), "me", config, fetcher),
        "INTERNAL_ERROR",
      );
      expect(fetcher).toHaveBeenCalledOnce();
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    },
  );

  it.each([accessId, accessSecret])(
    "応答headerに反射された資格情報を除外 %#",
    async (value) => {
      const response = await handleAccountProxy(
        request(),
        "me",
        config,
        async () =>
          Response.json(
            { ...mockMe, csrf_token: csrf },
            {
              headers: {
                "CF-Access-Client-Id": value,
                "CF-Access-Client-Secret": value,
                "Set-Cookie": value,
              },
            },
          ),
      );
      expect(response.status).toBe(200);
      expect(JSON.stringify([...response.headers])).not.toContain(value);
      expect(await response.text()).not.toContain(value);
    },
  );

  it.each([
    JSON.stringify({ ...mockMe, csrf_token: csrf, display_name: accessId }),
    JSON.stringify({
      ...mockMe,
      csrf_token: csrf,
      display_name: `x${accessSecret}y`,
    }),
    JSON.stringify({ ...mockMe, csrf_token: csrf, [accessId]: "value" }),
    JSON.stringify({ ...mockMe, csrf_token: csrf, nested: [accessSecret] }),
    JSON.stringify({
      ...mockMe,
      csrf_token: csrf,
      display_name: accessSecret,
    }).replace(
      accessSecret,
      [...accessSecret]
        .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
        .join(""),
    ),
  ])("decoded JSONに反射された資格情報を拒否 %#", async (body) => {
    await expectError(
      await handleAccountProxy(
        request(),
        "me",
        config,
        async () =>
          new Response(body, {
            headers: { "Content-Type": "application/json" },
          }),
      ),
      "INTERNAL_ERROR",
    );
  });

  it("契約エラーのrequest UUIDへの反射も返さない", async () => {
    await expectError(
      await handleAccountProxy(
        request(),
        "me",
        {
          ...config,
          KOKO_API_ACCESS_CLIENT_ID: requestId,
        },
        async () =>
          Response.json(
            { code: "FORBIDDEN", request_id: requestId },
            { status: 403 },
          ),
      ),
      "INTERNAL_ERROR",
    );
  });
});

describe("ストリーム容量・時間・取消し", () => {
  it("入力が終端しない場合1秒で拒否しcancel", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>();
    const pending = handleAccountProxy(
      request("PATCH", "me", {}, new ReadableStream({ cancel })),
      "me",
      config,
      fetcher,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await expectError(await pending, "INVALID_INPUT");
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("Content-Lengthを信用せずchunk総量で入力拒否", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600).fill(32));
        controller.enqueue(new Uint8Array(600).fill(32));
      },
      cancel,
    });
    const fetcher = vi.fn<typeof fetch>();
    await expectError(
      await handleAccountProxy(
        request("PATCH", "me", { "Content-Length": "1" }, body),
        "me",
        config,
        fetcher,
      ),
      "INVALID_INPUT",
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["headers", "body"])("上流%s待ちを10秒で停止", async (phase) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async () =>
      phase === "headers"
        ? new Promise<Response>(() => {})
        : new Response(new ReadableStream({ cancel }), {
            headers: { "Content-Type": "application/json" },
          }),
    );
    const pending = handleAccountProxy(request(), "me", config, fetcher);
    await vi.advanceTimersByTimeAsync(10_000);
    await expectError(await pending, "INTERNAL_ERROR");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    if (phase === "body") expect(cancel).toHaveBeenCalledOnce();
  });
  it("上流容量超過は分割chunkでも停止", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(9000).fill(32));
          controller.enqueue(new Uint8Array(9000).fill(32));
        },
        cancel,
      }),
      {
        headers: { "Content-Type": "application/json", "Content-Length": "1" },
      },
    );
    await expectError(
      await handleAccountProxy(request(), "me", config, async () => response),
      "INTERNAL_ERROR",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("既に取消された要求は外部へ送らない", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expectError(
      await handleAccountProxy(
        request("GET", "me", {}, undefined, undefined, controller.signal),
        "me",
        config,
        fetcher,
      ),
      "INVALID_INPUT",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("接続中の取消しを上流へ伝播", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => {
      controller.abort();
      return success();
    });
    await expectError(
      await handleAccountProxy(
        request("GET", "me", {}, undefined, undefined, controller.signal),
        "me",
        config,
        fetcher,
      ),
      "INTERNAL_ERROR",
    );
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
