import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { NodeNextRequest } from "next/dist/server/base-http/node";
import { NextRequestAdapter } from "next/dist/server/web/spec-extension/adapters/next-request";

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("../src/auth/server", () => ({ createServerAuthClient: createClient }));
import {
  POST,
  DELETE,
  GET,
  HEAD,
  OPTIONS,
  PUT,
  PATCH,
} from "../src/app/auth/api-session/route";

const origin = "https://web.example.test";
const userId = "11111111-1111-4111-8111-111111111111";
const token = "synthetic.access.signature";
const epoch = 1791000000;
const google = {
  role: "authenticated",
  is_anonymous: false,
  app_metadata: { provider: "google", providers: ["google"] },
};
const claims = { ...google, sub: userId, exp: epoch + 600 };

function request(
  method = "POST",
  init?: RequestInit,
  url = `${origin}/auth/api-session`,
) {
  return new Request(url, {
    method,
    ...init,
    headers: {
      Origin: origin,
      "X-KOKO-Session-Request": "1",
      "Sec-Fetch-Site": "same-origin",
      Cookie: "sb-project-auth-token=synthetic-ssr-cookie",
      ...init?.headers,
    },
  });
}

function auth() {
  const mock = {
    getSession: vi.fn().mockResolvedValue({
      data: {
        session: {
          access_token: token,
          refresh_token: "refresh-canary",
          expires_at: epoch + 999999,
          user: { id: "untrusted-storage-user", role: "admin" },
        },
      },
      error: null,
    }),
    getUser: vi.fn().mockResolvedValue({
      data: {
        user: { ...google, id: userId, email: "private-canary@example.test" },
      },
      error: null,
    }),
    getClaims: vi.fn().mockResolvedValue({ data: { claims }, error: null }),
    signOut: vi.fn(),
  };
  createClient.mockResolvedValue({ auth: mock });
  return mock;
}

function cookie(response: Response) {
  const header = response.headers.get("Set-Cookie");
  expect(header).toContain("__Host-koko_session=");
  expect(header).toContain("Path=/");
  expect(header).toContain("Secure");
  expect(header).toContain("HttpOnly");
  expect(header).toContain("SameSite=lax");
  expect(header).not.toMatch(/Domain=|sb-project|refresh-canary/);
  return header!;
}

async function expectResponse(
  response: Response,
  status: number,
  code?: string,
) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  expect(response.headers.get("Location")).toBeNull();
  expect(await response.json()).toEqual(code ? { code } : { ok: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch * 1000);
  vi.stubEnv("KOKO_API_COOKIE_ENABLED", "true");
  vi.stubEnv("KOKO_WEB_ORIGIN", origin);
  createClient.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Web APIセッションCookie bridge", () => {
  it.each(["POST", "DELETE"])(
    "Next.js Node adapterの空ストリームを本文ありと誤判定しない: %s",
    async (method) => {
      auth();
      const incoming = new IncomingMessage(new Socket());
      incoming.method = method;
      incoming.url = `${origin}/auth/api-session`;
      incoming.headers = {
        origin,
        "x-koko-session-request": "1",
        "content-length": "0",
      };
      incoming.push(null);
      const req = NextRequestAdapter.fromNodeNextRequest(
        new NodeNextRequest(incoming),
        new AbortController().signal,
      );
      expect(req.body).not.toBeNull();
      await expectResponse(await POST(req), 200);
    },
  );

  it.each(["POST", "DELETE"])("0byteの本文は許可: %s", async (method) => {
    auth();
    await expectResponse(await POST(request(method, { body: "" })), 200);
  });

  it("本文の到着を1秒より長く待たずAuthへ進まない", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = POST(request("POST", { body, ...{ duplex: "half" } }));
    await vi.advanceTimersByTimeAsync(1000);
    const result = await response;
    await expectResponse(result, 400, "INVALID_INPUT");
    expect(result.headers.get("Set-Cookie")).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("最初のchunkで拒否し、本文全体をバッファーしない", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel,
    });
    const response = await POST(
      request("POST", { body, ...{ duplex: "half" } }),
    );
    await expectResponse(response, 400, "INVALID_INPUT");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("読取りエラーを固定の入力エラーに閉じる", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("private-body-canary"));
      },
    });
    const response = await POST(
      request("POST", { body, ...{ duplex: "half" } }),
    );
    await expectResponse(response, 400, "INVALID_INPUT");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each(["used", "locked", "aborted"])(
    "消費済み・使用中・取消済みリクエストを拒否: %s",
    async (state) => {
      const controller = new AbortController();
      const req = request("POST", { body: "", signal: controller.signal });
      if (state === "used") await req.text();
      const reader = state === "locked" ? req.body!.getReader() : null;
      if (state === "aborted") controller.abort();
      const response = await POST(req);
      await expectResponse(response, 400, "INVALID_INPUT");
      expect(response.headers.get("Set-Cookie")).toBeNull();
      expect(createClient).not.toHaveBeenCalled();
      reader?.releaseLock();
    },
  );

  it("検証した同じJWTだけをCookieにして、storageの本人と寿命を信用しない", async () => {
    const mock = auth();
    const response = await POST(request());
    await expectResponse(response, 200);
    expect(createClient).toHaveBeenCalledWith({ requireCookieWrites: true });
    expect(mock.getUser).toHaveBeenCalledExactlyOnceWith(token);
    expect(mock.getClaims).toHaveBeenCalledExactlyOnceWith(token);
    expect(cookie(response)).toContain(`__Host-koko_session=${token};`);
    expect(cookie(response)).toContain("Max-Age=300");
    expect(cookie(response)).toContain(
      `Expires=${new Date((epoch + 300) * 1000).toUTCString()}`,
    );
    expect(mock.signOut).not.toHaveBeenCalled();
  });

  it("refresh後のaccess JWTを同じCookieへ更新し、残り期限を超えない", async () => {
    const mock = auth();
    const first = await POST(request());
    expect(first.status).toBe(200);
    mock.getSession.mockResolvedValue({
      data: { session: { access_token: "fresh.access.signature" } },
      error: null,
    });
    mock.getClaims.mockResolvedValue({
      data: { claims: { ...claims, exp: epoch + 45 } },
      error: null,
    });
    const second = await POST(
      request("POST", {
        headers: {
          Cookie: `__Host-koko_session=${token}; sb-project-auth-token=refreshed`,
        },
      }),
    );
    await expectResponse(second, 200);
    expect(cookie(second)).toContain(
      "__Host-koko_session=fresh.access.signature;",
    );
    expect(cookie(second)).toContain("Max-Age=45");
    expect(mock.getUser).toHaveBeenLastCalledWith("fresh.access.signature");
    expect(mock.getClaims).toHaveBeenLastCalledWith("fresh.access.signature");
  });

  it("DELETEはCookieだけを期限切れにし、Supabaseへ接続・signOutしない", async () => {
    const mock = auth();
    for (let i = 0; i < 2; i++) {
      const response = await DELETE(request("DELETE"));
      await expectResponse(response, 200);
      expect(cookie(response)).toContain("__Host-koko_session=;");
      expect(cookie(response)).toContain("Max-Age=0");
      expect(cookie(response)).toContain(
        "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      );
    }
    expect(createClient).not.toHaveBeenCalled();
    expect(mock.signOut).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "false", "TRUE", "1", " true"])(
    "明示flag以外では無効: %s",
    async (flag) => {
      vi.stubEnv("KOKO_API_COOKIE_ENABLED", flag);
      for (const method of ["POST", "DELETE"]) {
        const response = await POST(request(method));
        await expectResponse(response, 503, "API_SESSION_UNAVAILABLE");
        expect(response.headers.get("Set-Cookie")).toBeNull();
      }
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    "",
    "http://web.example.test",
    `${origin}/`,
    `${origin}/path`,
    `${origin}?q=1`,
    `${origin}#hash`,
    "https://user@web.example.test",
  ])("不正origin設定では発行も削除もしない: %s", async (value) => {
    vi.stubEnv("KOKO_WEB_ORIGIN", value);
    const response = await POST(request());
    await expectResponse(response, 503, "API_SESSION_UNAVAILABLE");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each(["Origin", "X-KOKO-Session-Request"])(
    "%s欠落をHost/Refererで補完しない",
    async (name) => {
      const req = request("POST", {
        headers: {
          Host: "web.example.test",
          "X-Forwarded-Host": "web.example.test",
          Referer: `${origin}/account`,
        },
      });
      req.headers.delete(name);
      const response = await POST(req);
      await expectResponse(response, 403, "FORBIDDEN");
      expect(response.headers.get("Set-Cookie")).toBeNull();
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it.each([
    { Origin: "null" },
    { Origin: "https://evil.example" },
    { Origin: `${origin}.evil.test` },
    { Origin: `${origin}/` },
    { "X-KOKO-Session-Request": "true" },
    { "Sec-Fetch-Site": "same-site" },
    { "Sec-Fetch-Site": "cross-site" },
    { "Sec-Fetch-Site": "none" },
  ])("別サイト/偽装の発行・消去を拒否: %#", async (headers) => {
    for (const method of ["POST", "DELETE"]) {
      const response = await POST(request(method, { headers }));
      await expectResponse(response, 403, "FORBIDDEN");
      expect(response.headers.get("Set-Cookie")).toBeNull();
    }
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each(["http://web.example.test", "https://other.example.test"])(
    "request URLの%sを固定originと比較",
    async (url) => {
      const response = await POST(
        request("POST", undefined, `${url}/auth/api-session`),
      );
      await expectResponse(response, 403, "FORBIDDEN");
      expect(response.headers.get("Set-Cookie")).toBeNull();
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it("Fetch MetadataがなくてもOriginと意図headerは必要", async () => {
    auth();
    const req = request();
    req.headers.delete("Sec-Fetch-Site");
    await expectResponse(await POST(req), 200);
  });

  it.each([
    { body: JSON.stringify({ access_token: "attacker.access.token" }) },
    { body: " " },
    { headers: { Authorization: "Bearer attacker.access.token" } },
  ])("本文や別資格情報を受け付けない: %#", async (init) => {
    const response = await POST(request("POST", init));
    await expectResponse(response, 400, "INVALID_INPUT");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("queryのtoken/redirectを読まない", async () => {
    const response = await POST(
      request(
        "POST",
        undefined,
        `${origin}/auth/api-session?access_token=canary&next=https://evil.example`,
      ),
    );
    await expectResponse(response, 400, "INVALID_INPUT");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", GET],
    ["HEAD", HEAD],
    ["OPTIONS", OPTIONS],
    ["PUT", PUT],
    ["PATCH", PATCH],
  ] as const)("%sは発行せず、CORSも開けない", async (method, handler) => {
    const response = await handler(request(method));
    await expectResponse(response, 405, "METHOD_NOT_ALLOWED");
    expect(response.headers.get("Allow")).toBe("POST, DELETE");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { access_token: "" },
    { access_token: "one-part" },
    { access_token: "quoted.access.token%20" },
    { access_token: `x.${"a".repeat(3497)}.z` },
  ])("不正storage候補を照合前に拒否: %#", async (session) => {
    const mock = auth();
    mock.getSession.mockResolvedValue({ data: { session }, error: null });
    const response = await POST(request());
    await expectResponse(response, 401, "AUTH_REQUIRED");
    expect(cookie(response)).toContain("Max-Age=0");
    expect(mock.getUser).not.toHaveBeenCalled();
    expect(mock.getClaims).not.toHaveBeenCalled();
  });

  it.each(["getSession", "getUser", "getClaims"] as const)(
    "%sの認証失敗で古いAPI Cookieを残さない",
    async (method) => {
      const mock = auth();
      mock[method].mockResolvedValue({
        data: null,
        error: { message: "private-canary upstream token" },
      });
      const response = await POST(request());
      await expectResponse(response, 401, "AUTH_REQUIRED");
      expect(cookie(response)).toContain("Max-Age=0");
      expect(mock.signOut).not.toHaveBeenCalled();
    },
  );

  it.each([
    { sub: "22222222-2222-4222-8222-222222222222" },
    { sub: "not-uuid" },
    { exp: epoch },
    { exp: epoch - 1 },
    { exp: "1791000300" },
    { exp: NaN },
    { exp: Infinity },
    { exp: epoch + 1.5 },
    { exp: undefined },
  ])("検証結果の本人/期限異常で発行しない: %#", async (override) => {
    const mock = auth();
    mock.getClaims.mockResolvedValue({
      data: { claims: { ...claims, ...override } },
      error: null,
    });
    const response = await POST(request());
    await expectResponse(response, 401, "AUTH_REQUIRED");
    expect(cookie(response)).toContain("Max-Age=0");
  });

  it.each([
    { role: "anon" },
    { is_anonymous: true },
    { app_metadata: { provider: "email", providers: ["email"] } },
    { app_metadata: { provider: "google", providers: ["google", "email"] } },
  ])("Google単独以外をuser/claimsの両方で拒否: %#", async (override) => {
    for (const part of ["user", "claims"] as const) {
      const mock = auth();
      if (part === "user")
        mock.getUser.mockResolvedValue({
          data: { user: { ...google, id: userId, ...override } },
          error: null,
        });
      else
        mock.getClaims.mockResolvedValue({
          data: { claims: { ...claims, ...override } },
          error: null,
        });
      const response = await POST(request());
      await expectResponse(response, 403, "FORBIDDEN");
      expect(cookie(response)).toContain("Max-Age=0");
    }
  });

  it.each(["getSession", "getUser", "getClaims"] as const)(
    "%s例外の秘密をJSONへ出さずCookieを消す",
    async (method) => {
      const mock = auth();
      mock[method].mockRejectedValue(
        new Error("refresh-canary private-profile cookie-store"),
      );
      const response = await POST(request());
      await expectResponse(response, 500, "INTERNAL_ERROR");
      expect(cookie(response)).toContain("Max-Age=0");
    },
  );

  it("設定不足やCookie writer失敗を成功にしない", async () => {
    createClient.mockResolvedValue(null);
    const absent = await POST(request());
    await expectResponse(absent, 503, "API_SESSION_UNAVAILABLE");
    expect(cookie(absent)).toContain("Max-Age=0");
    createClient.mockRejectedValue(new Error("cookie secret-canary"));
    const failed = await POST(request());
    await expectResponse(failed, 500, "INTERNAL_ERROR");
    expect(cookie(failed)).toContain("Max-Age=0");
  });
});
