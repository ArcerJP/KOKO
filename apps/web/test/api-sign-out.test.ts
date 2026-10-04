import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("../src/auth/server", () => ({ createServerAuthClient: createClient }));
import { GET as callback } from "../src/app/auth/callback/route";
import { POST as issue } from "../src/app/auth/api-session/route";
import * as logoutRoutes from "../src/app/auth/api-sign-out/route";
import {
  apiGeneration,
  apiTokenForProxy,
  generationCookieName,
  apiCookieName,
} from "../src/auth/api-session-cookies";
import { handleAccountProxy } from "../src/api/account-proxy";
import { mockEventId, mockMe } from "../src/mocks/handlers";

const origin = "https://web.example.test";
const sessionId = "33333333-3333-4333-8333-333333333333";
const userId = "11111111-1111-4111-8111-111111111111";
const generation = `22222222-2222-4222-8222-222222222222.${createHash("sha256").update(`${userId}:${sessionId}`).digest("hex")}`;
const token = "synthetic.access.signature";
const google = {
  role: "authenticated",
  is_anonymous: false,
  app_metadata: { provider: "google", providers: ["google"] },
};
const claims = {
  ...google,
  sub: userId,
  session_id: sessionId,
  exp: Math.floor(Date.now() / 1000) + 3600,
};
function auth() {
  const mock = {
    exchangeCodeForSession: vi.fn().mockResolvedValue({ error: null }),
    getSession: vi.fn().mockResolvedValue({
      data: { session: { access_token: token } },
      error: null,
    }),
    getUser: vi.fn().mockResolvedValue({
      data: { user: { ...google, id: claims.sub } },
      error: null,
    }),
    getClaims: vi.fn().mockResolvedValue({ data: { claims }, error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  };
  createClient.mockResolvedValue({ auth: mock });
  return mock;
}
function request(
  path = "/auth/api-sign-out",
  headers: Record<string, string | null> = {},
  method = "POST",
  body?: BodyInit,
) {
  const merged = new Headers({
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
    "X-KOKO-Session-Request": "1",
    Cookie: `${generationCookieName}=${generation}`,
  });
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) merged.delete(name);
    else merged.set(name, value);
  }
  return new Request(new URL(path, origin), {
    method,
    headers: merged,
    ...(body === undefined ? {} : { body }),
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  });
}
function jar(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    apply(response: Response) {
      for (const header of response.headers.getSetCookie()) {
        const first = header.split(";")[0]!;
        const equal = first.indexOf("=");
        const name = first.slice(0, equal),
          value = first.slice(equal + 1);
        if (header.includes("Max-Age=0")) values.delete(name);
        else values.set(name, value);
      }
    },
    header() {
      return Array.from(values, ([name, value]) => `${name}=${value}`).join(
        "; ",
      );
    },
  };
}
beforeEach(() => {
  vi.stubEnv("KOKO_API_COOKIE_ENABLED", "true");
  vi.stubEnv("KOKO_WEB_ORIGIN", origin);
  createClient.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("API終了route", () => {
  it("Authへ接続せず世代を終了・API Cookie消去、繰返し可能", async () => {
    for (let i = 0; i < 2; i++) {
      const response = await logoutRoutes.POST(request());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      const cookies = response.headers.getSetCookie();
      expect(cookies).toHaveLength(2);
      for (const value of cookies) {
        expect(value).toContain("Secure");
        expect(value).toContain("HttpOnly");
        expect(value).toContain("Path=/");
        expect(value).toContain("SameSite=lax");
        expect(value).not.toContain("Domain=");
      }
      expect(
        cookies.some(
          (value) =>
            value.startsWith(`${generationCookieName}=ended;`) &&
            value.includes("Max-Age=31536000"),
        ),
      ).toBe(true);
      expect(
        cookies.some(
          (value) =>
            value.startsWith(`${apiCookieName}=;`) &&
            value.includes("Max-Age=0"),
        ),
      ).toBe(true);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(createClient).not.toHaveBeenCalled();
  });
  it("既定無効はCookie非変更", async () => {
    vi.stubEnv("KOKO_API_COOKIE_ENABLED", "");
    const response = await logoutRoutes.POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.has("set-cookie")).toBe(false);
  });
  it.each(["GET", "DELETE", "PATCH", "PUT", "HEAD", "OPTIONS"] as const)(
    "%sは405",
    async (method) => {
      const response = await logoutRoutes[method](
        request(undefined, {}, method),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("POST");
      expect(response.headers.has("set-cookie")).toBe(false);
    },
  );
  it.each([
    { Origin: null },
    { Origin: "https://evil.example.test" },
    { "X-KOKO-Session-Request": null },
    { "Sec-Fetch-Site": "same-site" },
    { Authorization: "Bearer synthetic" },
  ])("送信元/資格情報不正はCookie非変更 %#", async (headers) => {
    const response = await logoutRoutes.POST(request(undefined, headers));
    expect([400, 403]).toContain(response.status);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(createClient).not.toHaveBeenCalled();
  });
  it.each([
    "/auth/api-sign-out?next=/account",
    "/auth/api-sign-out#token",
    "/auth/wrong",
  ])("余分なURL入力を拒否 %s", async (path) => {
    const response = await logoutRoutes.POST(request(path));
    expect(response.status).toBe(400);
    expect(response.headers.has("set-cookie")).toBe(false);
  });
  it("本文拒否", async () => {
    const response = await logoutRoutes.POST(
      request(undefined, {}, "POST", "{}"),
    );
    expect(response.status).toBe(400);
    expect(response.headers.has("set-cookie")).toBe(false);
  });
  it("本文停止を1秒で拒否", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const pending = logoutRoutes.POST(
      request(undefined, {}, "POST", new ReadableStream({ cancel })),
    );
    await vi.advanceTimersByTimeAsync(1000);
    const response = await pending;
    expect(response.status).toBe(400);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("世代の発行と検査", () => {
  it("成功Google callbackだけが新世代を作り古いAPI Cookieを消去", async () => {
    const mock = auth();
    const one = await callback(
      request("/auth/callback?code=synthetic", {}, "GET"),
    );
    const two = await callback(
      request("/auth/callback?code=synthetic", {}, "GET"),
    );
    const cookies = jar();
    cookies.apply(one);
    const first = apiGeneration(new Headers({ Cookie: cookies.header() }));
    cookies.apply(two);
    expect(first).toMatch(/^[a-f0-9-]{36}\.[a-f0-9]{64}$/);
    expect(first?.split(".")[1]).toBe(generation.split(".")[1]);
    expect(first).not.toContain(userId);
    expect(first).not.toContain(sessionId);
    expect(apiGeneration(new Headers({ Cookie: cookies.header() }))).not.toBe(
      first,
    );
    expect(one.headers.get("Location")).toBe(`${origin}/account`);
    expect(one.headers.get("Cache-Control")).toBe("private, no-store");
    expect(createClient).toHaveBeenCalledWith({ requireCookieWrites: true });
    expect(mock.exchangeCodeForSession).toHaveBeenCalledWith("synthetic");
    expect(cookies.header()).not.toContain(apiCookieName);
  });
  it.each([
    "missing-code",
    "exchange",
    "claims",
    "provider",
    "writer",
    "origin",
    "missing-session",
    "invalid-sub",
    "null-data",
  ])("callback失敗は世代を変えない %s", async (mode) => {
    const mock = auth();
    if (mode === "exchange")
      mock.exchangeCodeForSession.mockResolvedValue({ error: "synthetic" });
    if (mode === "claims")
      mock.getClaims.mockResolvedValue({
        data: { claims: null },
        error: "synthetic",
      });
    if (mode === "provider")
      mock.getClaims.mockResolvedValue({
        data: { claims: { ...claims, is_anonymous: true } },
        error: null,
      });
    if (mode === "missing-session" || mode === "invalid-sub")
      mock.getClaims.mockResolvedValue({
        data: {
          claims: {
            ...claims,
            ...(mode === "missing-session"
              ? { session_id: undefined }
              : { sub: "invalid" }),
          },
        },
        error: null,
      });
    if (mode === "null-data")
      mock.getClaims.mockResolvedValue({ data: null, error: null });
    if (mode === "writer")
      createClient.mockRejectedValue(new Error("private-cookie-canary"));
    if (mode === "origin")
      vi.stubEnv("KOKO_WEB_ORIGIN", "https://other.example.test");
    const response = await callback(
      request(
        mode === "missing-code"
          ? "/auth/callback"
          : "/auth/callback?code=synthetic",
        {},
        "GET",
      ),
    );
    expect(response.headers.get("Location")).toBe(`${origin}/login?error=auth`);
    expect(response.headers.has("set-cookie")).toBe(false);
  });
  it("flag無効の既存callbackは世代に依存しない", async () => {
    vi.stubEnv("KOKO_API_COOKIE_ENABLED", "");
    auth();
    const response = await callback(
      request("/auth/callback?code=synthetic", {}, "GET"),
    );
    expect(response.headers.get("Location")).toBe(`${origin}/account`);
    expect(response.headers.has("set-cookie")).toBe(false);
  });
  it.each([
    "",
    "ended",
    "not-uuid",
    `${generation}; ${generationCookieName}=${generation}`,
    `${generation}; ${generationCookieName}.0=chunk`,
  ])("無効世代はAuth前に拒否 %s", async (value) => {
    const response = await issue(
      request("/auth/api-session", {
        Cookie: `${generationCookieName}=${value}`,
      }),
    );
    expect(response.status).toBe(401);
    expect(createClient).not.toHaveBeenCalled();
  });
  it.each([
    "synthetic.access.signature",
    `v1.${generation}.a.b.c.extra`,
    `v1.${generation}.${"a".repeat(3500)}.b.c`,
    `v2.${generation}.a.b.c`,
    `v1.33333333-3333-4333-8333-333333333333.a.b.c`,
  ])("旧/不正envelopeへfallbackしない %#", (value) => {
    expect(
      apiTokenForProxy(
        new Headers({
          Cookie: `${generationCookieName}=${generation}; ${apiCookieName}=${value}`,
        }),
      ),
    ).toBeNull();
  });
});

describe("遅れた発行応答とlogout・別ログインの交差", () => {
  it.each(["different-user", "same-user-new-session"])(
    "新世代へ古いSSR認証を戻しても発行しない %s",
    async (mode) => {
      const mock = auth();
      const nextClaims = {
        ...claims,
        sub:
          mode === "different-user"
            ? "44444444-4444-4444-8444-444444444444"
            : userId,
        session_id: "55555555-5555-4555-8555-555555555555",
      };
      mock.getClaims.mockResolvedValueOnce({
        data: { claims: nextClaims },
        error: null,
      });
      const cookies = jar();
      cookies.apply(
        await callback(request("/auth/callback?code=new-login", {}, "GET")),
      );
      expect(
        apiGeneration(new Headers({ Cookie: cookies.header() })),
      ).not.toBeNull();
      // callback後、古いrefresh応答がSSR Cookieを戻した状況を旧claimsで再現。
      const response = await issue(
        request("/auth/api-session", { Cookie: cookies.header() }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.getSetCookie()).toHaveLength(1);
      expect(response.headers.getSetCookie()[0]).toContain("Max-Age=0");
    },
  );
  it.each(["logout", "new-login"])(
    "%s後に古い発行が完了してもAPIへ通さない",
    async (mode) => {
      const mock = auth();
      const cookies = jar({ [generationCookieName]: generation });
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      mock.getUser.mockImplementationOnce(async () => {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { data: { user: { ...google, id: claims.sub } }, error: null };
      });
      const oldIssue = issue(
        request("/auth/api-session", { Cookie: cookies.header() }),
      );
      await entered;
      cookies.apply(await logoutRoutes.POST(request()));
      if (mode === "new-login")
        cookies.apply(
          await callback(request("/auth/callback?code=new-login", {}, "GET")),
        );
      release();
      const lateResponse = await oldIssue;
      expect(lateResponse.status).toBe(200);
      // late responseはAPI Cookieだけを更新し、現在世代を戻さない。
      expect(lateResponse.headers.getSetCookie()).toHaveLength(1);
      cookies.apply(lateResponse);
      const fetcher = vi.fn<typeof fetch>(async () =>
        Response.json({
          ...mockMe,
          csrf_token: "synthetic-csrf-value-for-tests-only",
        }),
      );
      const config = {
        KOKO_API_COOKIE_ENABLED: "true",
        KOKO_API_PROXY_ENABLED: "true",
        KOKO_WEB_ORIGIN: origin,
        KOKO_API_UPSTREAM_ORIGIN: "https://koko-api-dev.arcer-jp.workers.dev",
      };
      const call = () =>
        handleAccountProxy(
          new Request(`${origin}/api/me`, {
            headers: { Cookie: cookies.header(), "X-Event-ID": mockEventId },
          }),
          "me",
          config,
          fetcher,
        );
      expect((await call()).status).toBe(401);
      expect(fetcher).not.toHaveBeenCalled();
      if (mode === "logout") {
        expect(
          (
            await issue(
              request("/auth/api-session", { Cookie: cookies.header() }),
            )
          ).status,
        ).toBe(401);
      } else {
        cookies.apply(
          await issue(
            request("/auth/api-session", { Cookie: cookies.header() }),
          ),
        );
        expect((await call()).status).toBe(200);
        expect(
          new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Cookie"),
        ).toBe(`${apiCookieName}=${token}`);
      }
    },
  );
});
