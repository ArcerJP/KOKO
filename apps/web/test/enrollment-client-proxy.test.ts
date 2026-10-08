import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client";
import { handleEnrollmentProxy } from "../src/api/enrollment-proxy";
const event = "22222222-2222-4222-8222-222222222222";
const user = "11111111-1111-4111-8111-111111111111";
const origin = "https://web.example.test";
const csrf = "synthetic-enrollment-csrf-value-only";
const state = {
  user_id: user,
  event_id: event,
  enrolled: false,
  registration_open: true,
  csrf_token: csrf,
};
const generation = `${event}.${"a".repeat(64)}`;
const cookie = `__Host-koko_generation=${generation}; __Host-koko_session=v1.${generation}.synthetic.access.signature`;
const config = {
  KOKO_ENROLLMENT_ENABLED: "true",
  KOKO_EVENT_ID: event,
  KOKO_API_COOKIE_ENABLED: "true",
  KOKO_API_PROXY_ENABLED: "true",
  KOKO_WEB_ORIGIN: origin,
  KOKO_API_UPSTREAM_ORIGIN: "https://koko-api-dev.arcer-jp.workers.dev",
  KOKO_API_ACCESS_CLIENT_ID: "synthetic-access-id-only",
  KOKO_API_ACCESS_CLIENT_SECRET: "synthetic-access-secret-only",
};
const request = (
  method = "GET",
  headers: Record<string, string> = {},
  input: unknown = { display_name: "試験名" },
) =>
  new Request(origin + "/api/me/enrollment", {
    method,
    headers: {
      cookie,
      origin,
      "x-event-id": event,
      "x-csrf-token": csrf,
      "content-type": "application/json",
      ...headers,
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(input) }),
  });
describe("初回参加HTTP client/proxy", () => {
  it("固定経路/生成header/最小応答", async () => {
    const f = vi.fn<typeof fetch>(async (_url, init) =>
      Response.json(
        init?.method === "GET"
          ? { ...state, role: "admin", secret: "never-return" }
          : { request_id: user, private: "never-return" },
      ),
    );
    const c = createApiClient(new URL(origin + "/api/"), event, f);
    expect(await c.getEnrollment()).toEqual(state);
    expect(await c.enrollEvent({ display_name: "試験名" }, csrf)).toEqual({
      request_id: user,
    });
    expect(String(f.mock.calls[1]![0])).toBe(origin + "/api/me/enrollment");
    expect(f.mock.calls[1]![1]).toMatchObject({
      mode: "same-origin",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      method: "POST",
      body: JSON.stringify({ display_name: "試験名" }),
    });
  });
  it.each([
    null,
    {},
    { ...state, event_id: user },
    { ...state, user_id: "bad" },
    { ...state, enrolled: "false" },
    { ...state, registration_open: 1 },
    { ...state, enrolled: true },
    { ...state, csrf_token: "bad" },
  ])("不正GET応答を拒否 %#", async (value) => {
    const c = createApiClient(new URL(origin + "/api/"), event, async () =>
      Response.json(value),
    );
    await expect(c.getEnrollment()).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });
  it.each([
    { display_name: " " },
    { display_name: "a".repeat(51) },
    { display_name: "a\nb" },
    { display_name: "試験名", role: "admin" },
  ])("不正POSTを転送しない %#", async (input) => {
    const f = vi.fn();
    const c = createApiClient(new URL(origin + "/api/"), event, f);
    await expect(c.enrollEvent(input, csrf)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(f).not.toHaveBeenCalled();
  });
  it.each(["GET", "POST"])(
    "中継は固定先で入力Cookie/秘密を透過しない %s",
    async (method) => {
      const f = vi.fn<typeof fetch>(async (_url, init) => {
        const h = new Headers(init?.headers);
        expect(h.get("cf-access-client-secret")).toBe(
          config.KOKO_API_ACCESS_CLIENT_SECRET,
        );
        expect(h.has("authorization")).toBe(false);
        expect(h.get("cookie")).toBe(
          "__Host-koko_session=synthetic.access.signature",
        );
        return Response.json(
          method === "GET"
            ? { ...state, private: "never-return" }
            : { request_id: user, private: "never-return" },
          { headers: { "set-cookie": "bad=never-return" } },
        );
      });
      const response = await handleEnrollmentProxy(request(method), config, f);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(await response.json()).toEqual(
        method === "GET" ? state : { request_id: user },
      );
      expect(String(f.mock.calls[0]![0])).toBe(
        config.KOKO_API_UPSTREAM_ORIGIN + "/me/enrollment",
      );
      expect(f).toHaveBeenCalledOnce();
    },
  );
  it.each([
    {},
    { ...config, KOKO_ENROLLMENT_ENABLED: "false" },
    { ...config, KOKO_EVENT_ID: user },
  ])("無効/別eventは無通信 %#", async (conf) => {
    const f = vi.fn();
    const response = await handleEnrollmentProxy(request(), conf, f);
    expect([403, 404]).toContain(response.status);
    expect(f).not.toHaveBeenCalled();
  });
  it.each([
    { origin: "https://evil.example" },
    { "sec-fetch-site": "cross-site" },
    { cookie: "" },
    { "x-event-id": user },
    { authorization: "Bearer must-not-forward" },
  ])("境界違反は無通信 %#", async (headers) => {
    const f = vi.fn();
    expect(
      (await handleEnrollmentProxy(request("POST", headers), config, f)).ok,
    ).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
  it("CSRFなし/redirect/反射秘密を拒否し自動再送しない", async () => {
    const f = vi.fn<typeof fetch>(async () =>
      Response.json({ ...state, csrf_token: undefined }),
    );
    expect((await handleEnrollmentProxy(request(), config, f)).status).toBe(
      500,
    );
    f.mockResolvedValue(Response.redirect("https://evil.example"));
    expect((await handleEnrollmentProxy(request(), config, f)).status).toBe(
      500,
    );
    f.mockResolvedValue(
      Response.json({
        ...state,
        private: config.KOKO_API_ACCESS_CLIENT_SECRET,
      }),
    );
    expect((await handleEnrollmentProxy(request(), config, f)).status).toBe(
      500,
    );
    expect(f).toHaveBeenCalledTimes(3);
  });
});
