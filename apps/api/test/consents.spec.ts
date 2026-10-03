import { describe, expect, it, vi } from "vitest";
import { handleConsent } from "../src/account";

const eventId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const settings = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
};
const validBody = { terms_version: "fixture-v1", accepted: true };

function request(body: unknown = validBody, init?: RequestInit) {
  return new Request("https://api.example.test/consents", {
    method: "POST",
    body: JSON.stringify(body),
    ...init,
    headers: {
      "X-Event-ID": eventId,
      Authorization: "Bearer signed.jwt.placeholder",
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

function upstream(options?: {
  authStatus?: number;
  google?: boolean;
  member?: boolean;
  rpcStatus?: number;
  rpcResult?: unknown;
  rpcThrows?: boolean;
  malformedJson?: boolean;
}) {
  const calls: Request[] = [];
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      // Validate fetch options with workerd too, not just a plain JS mock.
      const outbound = new Request(input, init);
      calls.push(outbound);
      const path = new URL(outbound.url).pathname;
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
      if (path === "/rest/v1/event_members") {
        return Response.json(
          options?.member === false ? [] : [{ is_banned: true }],
        );
      }
      if (path === "/rest/v1/rpc/accept_current_terms") {
        if (options?.rpcThrows)
          throw new Error("sb_secret_canary upstream internals");
        if (options?.rpcStatus)
          return new Response("sb_secret_canary", {
            status: options.rpcStatus,
            headers: { location: "https://untrusted.example/sink" },
          });
        if (options?.malformedJson) return new Response("sb_secret_canary");
        return Response.json(
          options && "rpcResult" in options ? options.rpcResult : "accepted",
        );
      }
      throw new Error("Unexpected upstream");
    },
  ) as typeof fetch;
  return { fetcher, calls };
}

async function expectFailure(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const body = await response.json();
  expect(body).toEqual({ code, request_id: expect.any(String) });
  expect(JSON.stringify(body)).not.toMatch(/sb_|signed\.jwt|canary|untrusted/);
}

describe("POST /consents の認証・保存境界", () => {
  it("本人とイベントだけをRPCへ渡し、BANを解除せず明示同意を受け付ける", async () => {
    const mock = upstream();
    const response = await handleConsent(request(), settings, mock.fetcher);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ request_id: expect.any(String) });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mock.calls).toHaveLength(3);
    const auth = mock.calls[0]!;
    expect(auth.headers.get("apikey")).toBe(settings.SUPABASE_PUBLISHABLE_KEY);
    const member = new URL(mock.calls[1]!.url);
    expect(member.searchParams.get("user_id")).toBe(`eq.${userId}`);
    expect(member.searchParams.get("event_id")).toBe(`eq.${eventId}`);
    const rpc = mock.calls[2]!;
    expect(rpc.method).toBe("POST");
    expect(rpc.headers.get("apikey")).toBe(settings.SUPABASE_SECRET_KEY);
    expect(rpc.headers.get("Authorization")).toBeNull();
    expect(await rpc.json()).toEqual({
      p_event_id: eventId,
      p_user_id: userId,
      p_terms_version: "fixture-v1",
    });
    expect(mock.calls.every((call) => call.redirect === "manual")).toBe(true);
    expect(
      mock.calls.every(
        (call) => new URL(call.url).origin === settings.SUPABASE_URL,
      ),
    ).toBe(true);
  });

  it.each(["GET", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "%sでは上流に接続しない",
    async (method) => {
      const mock = upstream();
      const response = await handleConsent(
        request(validBody, { method, body: null }),
        settings,
        mock.fetcher,
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(mock.calls).toHaveLength(0);
    },
  );

  it.each([
    { Authorization: "" },
    { Authorization: "", Cookie: "session=untrusted" },
    { Authorization: "Basic untrusted" },
  ])("Cookieや不正な認証形式を受け付けない: %j", async (headers) => {
    const mock = upstream();
    await expectFailure(
      await handleConsent(
        request(validBody, { headers }),
        settings,
        mock.fetcher,
      ),
      401,
      "AUTH_REQUIRED",
    );
    expect(mock.calls).toHaveLength(0);
  });

  it("不正eventと欠けた設定をDB通信前に拒否する", async () => {
    const mock = upstream();
    await expectFailure(
      await handleConsent(
        request(validBody, { headers: { "X-Event-ID": "not-uuid" } }),
        settings,
        mock.fetcher,
      ),
      400,
      "INVALID_INPUT",
    );
    await expectFailure(
      await handleConsent(request(), {}, mock.fetcher),
      500,
      "INTERNAL_ERROR",
    );
    expect(mock.calls).toHaveLength(0);
  });

  it.each([
    {
      options: { authStatus: 401 },
      status: 401,
      code: "AUTH_REQUIRED",
      calls: 1,
    },
    { options: { google: false }, status: 403, code: "FORBIDDEN", calls: 1 },
    { options: { member: false }, status: 403, code: "FORBIDDEN", calls: 2 },
  ])(
    "本人認証・所属に失敗したら保存しない: $code",
    async ({ options, status, code, calls }) => {
      const mock = upstream(options);
      await expectFailure(
        await handleConsent(request(), settings, mock.fetcher),
        status,
        code,
      );
      expect(mock.calls).toHaveLength(calls);
    },
  );

  it.each([
    null,
    [],
    {},
    { terms_version: "fixture-v1" },
    { terms_version: "fixture-v1", accepted: false },
    { terms_version: "fixture-v1", accepted: "true" },
    { terms_version: "", accepted: true },
    { terms_version: " ", accepted: true },
    { terms_version: 1, accepted: true },
    { ...validBody, user_id: userId },
    { ...validBody, event_id: eventId },
    { ...validBody, accepted_at: "2000-01-01" },
    { ...validBody, role: "admin" },
  ])("不正・偽造入力を保存しない: %j", async (body) => {
    const mock = upstream();
    await expectFailure(
      await handleConsent(request(body), settings, mock.fetcher),
      400,
      "INVALID_INPUT",
    );
    expect(mock.calls).toHaveLength(2);
  });

  it.each([
    { body: "{" },
    { body: null },
    { body: new Uint8Array([0xc3, 0x28]) },
    { body: " ".repeat(1025) },
    { headers: { "Content-Type": "text/plain" } },
    { headers: { "Content-Length": "1025" } },
  ])("JSON・UTF-8・実サイズの境界を守る: %#", async (init) => {
    const mock = upstream();
    await expectFailure(
      await handleConsent(request(validBody, init), settings, mock.fetcher),
      400,
      "INVALID_INPUT",
    );
    expect(mock.calls).toHaveLength(2);
  });

  it.each([
    ["terms_mismatch", "CONSENT_REQUIRED"],
    ["forbidden", "FORBIDDEN"],
  ])("DBの再照合結果%sを拒否へ変換する", async (rpcResult, code) => {
    const mock = upstream({ rpcResult });
    await expectFailure(
      await handleConsent(request(), settings, mock.fetcher),
      403,
      code!,
    );
  });

  it.each([301, 302, 303, 307, 308, 404, 500])(
    "RPCの%sは追従・再試行せず失敗を隠さない",
    async (rpcStatus) => {
      const mock = upstream({ rpcStatus });
      const response = await handleConsent(request(), settings, mock.fetcher);
      await expectFailure(response, 500, "INTERNAL_ERROR");
      expect(response.headers.get("location")).toBeNull();
      expect(mock.calls).toHaveLength(3);
      expect(mock.calls[2]!.redirect).toBe("manual");
    },
  );

  it.each([null, [], {}, true, "unknown"])(
    "RPCの未知の成功本文を受理しない: %j",
    async (rpcResult) => {
      const mock = upstream({ rpcResult });
      await expectFailure(
        await handleConsent(request(), settings, mock.fetcher),
        500,
        "INTERNAL_ERROR",
      );
    },
  );

  it.each([{ rpcThrows: true }, { malformedJson: true }])(
    "上流例外・不正JSONを漏らさない: %j",
    async (options) => {
      const mock = upstream(options);
      await expectFailure(
        await handleConsent(request(), settings, mock.fetcher),
        500,
        "INTERNAL_ERROR",
      );
    },
  );
});
