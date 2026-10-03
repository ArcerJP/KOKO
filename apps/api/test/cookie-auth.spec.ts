import { describe, expect, it, vi } from "vitest";
import { handleAccount, handleConsent, type AccountEnv } from "../src/account";

const eventId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const jwt = "signed.cookie.placeholder";
const origin = "https://web.example.test";
const cookie = `__Host-koko_session=${jwt}`;
const settings = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  KOKO_WEB_ORIGIN: origin,
  // Deliberately synthetic, never a runtime credential.
  KOKO_CSRF_SECRET: "10".repeat(32),
};
// Independently computed with Node createHmac, not the production helper.
// Message: JSON.stringify(["koko.csrf.v1", origin, eventId, jwt, "20".repeat(16)]).
const knownToken =
  "v1.20202020202020202020202020202020.Ea53R0nvi5RWb1YqEds4zIRDrdb8mFjdvXC6oebkPNk";

function environment(
  overrides: Partial<Record<keyof AccountEnv, string | undefined>>,
): AccountEnv {
  return Object.fromEntries(
    Object.entries({ ...settings, ...overrides }).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

function request(method = "GET", headers?: HeadersInit, body?: object) {
  return new Request(
    `https://api.example.test/${method === "POST" ? "consents" : "me"}`,
    {
      method,
      headers: {
        "X-Event-ID": eventId,
        Cookie: cookie,
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
        ...(method === "PATCH" || method === "POST"
          ? { "Content-Type": "application/json", "X-CSRF-Token": knownToken }
          : {}),
        ...headers,
      },
      ...(method === "PATCH" || method === "POST"
        ? {
            body: JSON.stringify(
              body ??
                (method === "PATCH"
                  ? { display_name: "新しい参加者名" }
                  : { terms_version: "test-v1", accepted: true }),
            ),
          }
        : {}),
    },
  );
}

function upstream(options?: {
  authStatus?: number;
  google?: boolean;
  member?: boolean;
  malformed?: string;
  redirect?: string;
}) {
  const calls: Request[] = [];
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      // Exercise workerd's Request parser and real Web Crypto, not a Node shim.
      const outbound = new Request(input, init);
      calls.push(outbound);
      const path = new URL(outbound.url).pathname;
      if (options?.redirect === path)
        return new Response(null, {
          status: 302,
          headers: { location: "https://untrusted.example/sink" },
        });
      if (options?.malformed === path) return new Response("sb_secret_canary");
      if (path === "/auth/v1/user") {
        if (options?.authStatus)
          return new Response(null, { status: options.authStatus });
        return Response.json({
          id: userId,
          app_metadata:
            options?.google === false
              ? { provider: "email", providers: ["email"] }
              : { provider: "google", providers: ["google"] },
        });
      }
      if (path === "/rest/v1/event_members")
        return Response.json(
          options?.member === false
            ? []
            : [
                {
                  display_name: "参加者",
                  role: "user",
                  is_banned: false,
                  crown: "none",
                },
              ],
        );
      if (path === "/rest/v1/events")
        return Response.json([{ terms_version: "test-v1" }]);
      if (path === "/rest/v1/consents") return Response.json([]);
      if (path === "/rest/v1/rpc/accept_current_terms")
        return Response.json("accepted");
      throw new Error("Unexpected upstream");
    },
  ) as typeof fetch;
  return { calls, fetcher };
}

function handle(req: Request, env: AccountEnv, fetcher: typeof fetch) {
  return req.method === "POST"
    ? handleConsent(req, env, fetcher)
    : handleAccount(req, env, fetcher);
}

async function failure(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(await response.json()).toEqual({
    code:
      status === 401
        ? "AUTH_REQUIRED"
        : status === 403
          ? "FORBIDDEN"
          : "INTERNAL_ERROR",
    request_id: expect.any(String),
  });
}

async function issue(env: AccountEnv = settings, headers?: HeadersInit) {
  const mock = upstream();
  const response = await handleAccount(
    request("GET", headers),
    env,
    mock.fetcher,
  );
  expect(response.status).toBe(200);
  expect(mock.calls).toHaveLength(4);
  const body = (await response.json()) as { csrf_token: string };
  expect(body.csrf_token).toMatch(/^v1\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(JSON.stringify(body)).not.toContain(jwt);
  expect(JSON.stringify(body)).not.toContain(settings.KOKO_CSRF_SECRET);
  return body.csrf_token;
}

describe("Cookie認証とセッション結合CSRF", () => {
  it.each(["PATCH", "POST"])(
    "GETで発行したtokenを%sで検証して本人だけを更新",
    async (method) => {
      const token = await issue();
      const mock = upstream();
      const response = await handle(
        request(method, { "X-CSRF-Token": token }),
        settings,
        mock.fetcher,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ request_id: expect.any(String) });
      expect(mock.calls).toHaveLength(3);
      const auth = mock.calls[0]!;
      expect(auth.headers.get("Authorization")).toBe(`Bearer ${jwt}`);
      expect(auth.headers.get("apikey")).toBe(
        settings.SUPABASE_PUBLISHABLE_KEY,
      );
      const write = mock.calls[2]!;
      expect(write.method).toBe(method);
      expect(write.headers.get("apikey")).toBe(settings.SUPABASE_SECRET_KEY);
      expect(write.headers.get("Authorization")).toBeNull();
      if (method === "POST") {
        expect(new URL(write.url).pathname).toBe(
          "/rest/v1/rpc/accept_current_terms",
        );
        expect(await write.json()).toEqual({
          p_event_id: eventId,
          p_user_id: userId,
          p_terms_version: "test-v1",
        });
      } else {
        expect(new URL(write.url).searchParams.get("user_id")).toBe(
          `eq.${userId}`,
        );
        expect(new URL(write.url).searchParams.get("event_id")).toBe(
          `eq.${eventId}`,
        );
        expect(await write.json()).toEqual({ display_name: "新しい参加者名" });
      }
      for (const call of mock.calls) {
        expect(call.headers.get("Cookie")).toBeNull();
        expect(call.headers.get("X-CSRF-Token")).toBeNull();
        expect(JSON.stringify([...call.headers])).not.toContain(
          settings.KOKO_CSRF_SECRET,
        );
        expect(call.redirect).toBe("manual");
        expect(new URL(call.url).origin).toBe(settings.SUPABASE_URL);
      }
    },
  );

  it("独立した既知HMACベクトルを受理する", async () => {
    const mock = upstream();
    expect(
      (await handleAccount(request("PATCH"), settings, mock.fetcher)).status,
    ).toBe(200);
  });

  it("複数タブのtokenを相互に無効化せず、再読取りで異なるnonceを生成する", async () => {
    const first = await issue();
    const second = await issue();
    expect(first).not.toBe(second);
    for (const token of [first, second, first]) {
      const mock = upstream();
      expect(
        (
          await handleAccount(
            request("PATCH", { "X-CSRF-Token": token }),
            settings,
            mock.fetcher,
          )
        ).status,
      ).toBe(200);
    }
  });

  it.each(["PATCH", "POST"])(
    "%sでCSRFが欠落するとAuth/DBへ接続しない",
    async (method) => {
      const mock = upstream();
      const req = request(method);
      req.headers.delete("X-CSRF-Token");
      await failure(await handle(req, settings, mock.fetcher), 403);
      expect(mock.calls).toHaveLength(0);
    },
  );

  it.each([
    "",
    "plain",
    knownToken.replace("v1.", "v2."),
    knownToken.replace("2020", "3020"),
    knownToken.replace(".Ea", ".Fa"),
    knownToken + "=",
    knownToken.slice(0, -1),
    knownToken + "a",
    "a".repeat(4096),
    // Same decoded bytes, but non-canonical unused base64 bits.
    knownToken.slice(0, -1) + "l",
  ])("不正・改竄tokenを拒否する: %#", async (token) => {
    const mock = upstream();
    await failure(
      await handleAccount(
        request("PATCH", { "X-CSRF-Token": token }),
        settings,
        mock.fetcher,
      ),
      403,
    );
    expect(mock.calls).toHaveLength(0);
  });

  it.each([
    { headers: { Cookie: "__Host-koko_session=refreshed.jwt.placeholder" } },
    { headers: { "X-Event-ID": userId } },
    {
      headers: { Origin: "https://other.example.test" },
      env: { KOKO_WEB_ORIGIN: "https://other.example.test" },
    },
    { env: { KOKO_CSRF_SECRET: "30".repeat(32) } },
  ])(
    "別session/event/origin/keyへtokenを持ち出せない: %#",
    async ({ headers, env }) => {
      const mock = upstream();
      await failure(
        await handleAccount(
          request("PATCH", headers),
          { ...settings, ...env },
          mock.fetcher,
        ),
        403,
      );
      expect(mock.calls).toHaveLength(0);
      const fresh = await issue({ ...settings, ...env }, headers);
      expect(
        (
          await handleAccount(
            request("PATCH", { ...headers, "X-CSRF-Token": fresh }),
            { ...settings, ...env },
            mock.fetcher,
          )
        ).status,
      ).toBe(200);
    },
  );

  it.each([
    "",
    "session=untrusted",
    "CF_Authorization=untrusted",
    "sb-project-auth-token=untrusted",
    "__Host-koko_session",
    "__Host-koko_session=",
    "__Host-koko_session.0=chunk",
    `${cookie}; __Host-koko_session.1=chunk`,
    `${cookie}; ${cookie}`,
    '__Host-koko_session="quoted"',
    "__Host-koko_session=percent%2Eencoded",
    "__Host-koko_session=bad token",
    `__Host-koko_session=${"a".repeat(8193)}`,
    `${cookie}; irrelevant=${"x".repeat(16384)}`,
  ])("曖昧・未対応Cookieを認証に使わない: %#", async (value) => {
    const mock = upstream();
    await failure(
      await handleAccount(
        request("PATCH", { Cookie: value }),
        settings,
        mock.fetcher,
      ),
      401,
    );
    expect(mock.calls).toHaveLength(0);
  });

  it.each(["Bearer signed.bearer.placeholder", "Basic untrusted", ""])(
    "BearerとCookieを選択・fallbackしない: %#",
    async (authorization) => {
      const mock = upstream();
      await failure(
        await handleAccount(
          request("GET", { Authorization: authorization }),
          settings,
          mock.fetcher,
        ),
        401,
      );
      expect(mock.calls).toHaveLength(0);
    },
  );

  it("Cookie設定なしは既定無効、CSRFだけでも認証しない", async () => {
    const mock = upstream();
    const disabled = environment({
      KOKO_WEB_ORIGIN: undefined,
      KOKO_CSRF_SECRET: undefined,
    });
    await failure(await handleAccount(request(), disabled, mock.fetcher), 401);
    const req = request("PATCH");
    req.headers.delete("Cookie");
    await failure(await handleAccount(req, settings, mock.fetcher), 401);
    expect(mock.calls).toHaveLength(0);
  });

  it.each([
    { KOKO_WEB_ORIGIN: undefined },
    { KOKO_CSRF_SECRET: undefined },
    { KOKO_WEB_ORIGIN: "" },
    { KOKO_WEB_ORIGIN: "http://web.example.test" },
    { KOKO_WEB_ORIGIN: `${origin}/` },
    { KOKO_WEB_ORIGIN: `${origin}/path` },
    { KOKO_WEB_ORIGIN: `${origin}?q=1` },
    { KOKO_WEB_ORIGIN: `${origin}#hash` },
    { KOKO_WEB_ORIGIN: "https://user@web.example.test" },
    { KOKO_CSRF_SECRET: "" },
    { KOKO_CSRF_SECRET: "a".repeat(63) },
    { KOKO_CSRF_SECRET: "z".repeat(64) },
  ])("部分・不正設定を閉じたまま失敗させる: %#", async (env) => {
    const mock = upstream();
    await failure(
      await handleAccount(request(), environment(env), mock.fetcher),
      500,
    );
    expect(mock.calls).toHaveLength(0);
  });

  it.each(["PATCH", "POST"])(
    "%sでOrigin欠落をHost/Refererで補完しない",
    async (method) => {
      const mock = upstream();
      const req = request(method, {
        Host: "web.example.test",
        "X-Forwarded-Host": "web.example.test",
        Referer: `${origin}/account`,
      });
      req.headers.delete("Origin");
      await failure(await handle(req, settings, mock.fetcher), 403);
      expect(mock.calls).toHaveLength(0);
    },
  );

  it.each([
    "null",
    "https://other.example.test",
    `${origin}.evil.test`,
    `${origin}/`,
    "",
  ])("不正Originを読取りでも拒否: %#", async (value) => {
    const mock = upstream();
    for (const method of ["GET", "PATCH", "POST"]) {
      await failure(
        await handle(
          request(method, { Origin: value }),
          settings,
          mock.fetcher,
        ),
        403,
      );
    }
    expect(mock.calls).toHaveLength(0);
  });

  it.each(["same-site", "cross-site", "unknown", "none"])(
    "書込みのFetch Metadata %sを拒否",
    async (site) => {
      const mock = upstream();
      await failure(
        await handleAccount(
          request("PATCH", { "Sec-Fetch-Site": site }),
          settings,
          mock.fetcher,
        ),
        403,
      );
      expect(mock.calls).toHaveLength(0);
    },
  );

  it("Origin/Fetch MetadataなしのGETと、Origin+MACありの旧ブラウザを許容", async () => {
    const mock = upstream();
    const read = request();
    read.headers.delete("Origin");
    read.headers.delete("Sec-Fetch-Site");
    expect((await handleAccount(read, settings, mock.fetcher)).status).toBe(
      200,
    );
    expect(
      (
        await handleAccount(
          request("GET", { "Sec-Fetch-Site": "none" }),
          settings,
          mock.fetcher,
        )
      ).status,
    ).toBe(200);
    const write = request("PATCH");
    write.headers.delete("Sec-Fetch-Site");
    expect((await handleAccount(write, settings, mock.fetcher)).status).toBe(
      200,
    );
  });

  it("HTTPとCORS preflightを受け付けない", async () => {
    const mock = upstream();
    const req = request();
    await failure(
      await handleAccount(
        new Request(req.url.replace("https:", "http:"), req),
        settings,
        mock.fetcher,
      ),
      403,
    );
    const preflight = await handleAccount(
      request("OPTIONS"),
      settings,
      mock.fetcher,
    );
    expect(preflight.status).toBe(405);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(mock.calls).toHaveLength(0);
  });

  it.each([
    { options: { authStatus: 401 }, status: 401, calls: 1 },
    { options: { google: false }, status: 403, calls: 1 },
    { options: { member: false }, status: 403, calls: 2 },
  ])(
    "正しいCookie/CSRFも本人・Google・所属の代わりにならない: %#",
    async ({ options, status, calls }) => {
      for (const method of ["GET", "PATCH", "POST"]) {
        const mock = upstream(options);
        await failure(
          await handle(request(method), settings, mock.fetcher),
          status,
        );
        expect(mock.calls).toHaveLength(calls);
      }
    },
  );

  it.each([
    "/auth/v1/user",
    "/rest/v1/event_members",
    "/rest/v1/events",
    "/rest/v1/consents",
  ])("%sの失敗前にCSRFを返さず例外を漏らさない", async (path) => {
    for (const options of [{ malformed: path }, { redirect: path }]) {
      const mock = upstream(options);
      await failure(
        await handleAccount(request(), settings, mock.fetcher),
        500,
      );
      expect(mock.calls.every((call) => call.redirect === "manual")).toBe(true);
    }
  });

  it("Bearerは追加設定・ブラウザ用Origin検査に依存せずCSRFを返さない", async () => {
    const mock = upstream();
    for (const method of ["GET", "PATCH", "POST"]) {
      const response = await handle(
        request(method, {
          Cookie: `CF_Authorization=untrusted; unrelated=${"x".repeat(16384)}`,
          Authorization: "Bearer signed.bearer.placeholder",
          Origin: "https://native.invalid",
          "Sec-Fetch-Site": "cross-site",
          "X-CSRF-Token": "",
        }),
        environment({
          KOKO_WEB_ORIGIN: "invalid",
          KOKO_CSRF_SECRET: undefined,
        }),
        mock.fetcher,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty("csrf_token");
    }
  });
});
