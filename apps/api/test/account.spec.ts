import { describe, expect, it, vi } from "vitest";
import { handleAccount } from "../src/account";

const eventId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const settings = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
};

function request(method = "GET", body?: object, headers?: HeadersInit) {
  return new Request("https://api.example.test/me", {
    method,
    headers: {
      "X-Event-ID": eventId,
      Authorization: "Bearer signed.jwt.placeholder",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function fakeUpstream(options?: {
  member?: boolean;
  google?: boolean;
  consent?: boolean;
}) {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (url.pathname === "/auth/v1/user") {
        return Response.json({
          id: userId,
          app_metadata:
            options?.google === false
              ? { provider: "email", providers: ["email"] }
              : { provider: "google", providers: ["google"] },
        });
      }
      if (url.pathname === "/rest/v1/event_members") {
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
      }
      if (url.pathname === "/rest/v1/events") {
        return Response.json([{ terms_version: "test-v1" }]);
      }
      if (url.pathname === "/rest/v1/consents") {
        return Response.json(
          options?.consent ? [{ terms_version: "test-v1" }] : [],
        );
      }
      throw new Error("unexpected upstream");
    },
  ) as typeof fetch;
  return { fetcher, calls };
}

describe("/me のローカル認証・認可境界", () => {
  it("Bearerがなければ上流に接続しない", async () => {
    const upstream = fakeUpstream();
    const response = await handleAccount(
      request("GET", undefined, { Authorization: "" }),
      settings,
      upstream.fetcher,
    );
    expect(response.status).toBe(401);
    expect(upstream.calls).toHaveLength(0);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("Cookieだけでは認証せず、CSRF未実装の経路を開けない", async () => {
    const upstream = fakeUpstream();
    const response = await handleAccount(
      request(
        "PATCH",
        { display_name: "参加者" },
        {
          Authorization: "",
          Cookie: "session=untrusted",
        },
      ),
      settings,
      upstream.fetcher,
    );
    expect(response.status).toBe(401);
    expect(upstream.calls).toHaveLength(0);
  });

  it("設定がない状態では失敗し、秘密を応答へ含めない", async () => {
    const upstream = fakeUpstream();
    const response = await handleAccount(request(), {}, upstream.fetcher);
    expect(response.status).toBe(500);
    expect(upstream.calls).toHaveLength(0);
    expect(await response.text()).not.toContain("sb_secret_");
  });

  it("Google以外のログインを拒否してDBを読まない", async () => {
    const upstream = fakeUpstream({ google: false });
    const response = await handleAccount(request(), settings, upstream.fetcher);
    expect(response.status).toBe(403);
    expect(upstream.calls).toHaveLength(1);
  });

  it("イベントに所属しない利用者を拒否する", async () => {
    const upstream = fakeUpstream({ member: false });
    const response = await handleAccount(request(), settings, upstream.fetcher);
    expect(response.status).toBe(403);
    expect(upstream.calls).toHaveLength(2);
    expect(upstream.calls[1]?.url.searchParams.get("user_id")).toBe(
      `eq.${userId}`,
    );
    expect(upstream.calls[1]?.url.searchParams.get("event_id")).toBe(
      `eq.${eventId}`,
    );
  });

  it("本人情報と未同意状態を、メールを含めず返す", async () => {
    const upstream = fakeUpstream();
    const response = await handleAccount(request(), settings, upstream.fetcher);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user_id: userId,
      event_id: eventId,
      display_name: "参加者",
      role: "user",
      is_banned: false,
      terms_version: "test-v1",
      consent_required: true,
      crown: "none",
    });
    expect(upstream.calls[0]?.url.pathname).toBe("/auth/v1/user");
    expect(upstream.calls[3]?.url.pathname).toBe("/rest/v1/consents");
    expect(upstream.calls[3]?.url.searchParams.get("terms_version")).toBe(
      "eq.test-v1",
    );
  });

  it("表示名だけを対象の所属行へ更新し、同意は保存しない", async () => {
    const upstream = fakeUpstream();
    const response = await handleAccount(
      request("PATCH", { display_name: "新しい表示名" }),
      settings,
      upstream.fetcher,
    );
    expect(response.status).toBe(200);
    expect(upstream.calls).toHaveLength(3);
    expect(upstream.calls[2]?.url.pathname).toBe("/rest/v1/event_members");
    expect(upstream.calls[2]?.url.searchParams.get("user_id")).toBe(
      `eq.${userId}`,
    );
    expect(upstream.calls[2]?.url.searchParams.get("event_id")).toBe(
      `eq.${eventId}`,
    );
    expect(upstream.calls[2]?.init?.method).toBe("PATCH");
    expect(upstream.calls[2]?.init?.body).toBe(
      JSON.stringify({ display_name: "新しい表示名" }),
    );
  });

  it("roleやアバターを含む変更を拒否する", async () => {
    const upstream = fakeUpstream();
    const response = await handleAccount(
      request("PATCH", { display_name: "参加者", role: "admin" }),
      settings,
      upstream.fetcher,
    );
    expect(response.status).toBe(400);
    expect(upstream.calls).toHaveLength(2);
  });

  it("長すぎる表示名と本文を拒否し、DBを更新しない", async () => {
    const upstream = fakeUpstream();
    const tooLong = await handleAccount(
      request("PATCH", { display_name: "あ".repeat(51) }),
      settings,
      upstream.fetcher,
    );
    const tooLarge = await handleAccount(
      request("PATCH", { display_name: "あ".repeat(400) }),
      settings,
      upstream.fetcher,
    );
    expect(tooLong.status).toBe(400);
    expect(tooLarge.status).toBe(400);
    expect(upstream.calls.every((call) => call.init?.method !== "PATCH")).toBe(
      true,
    );
  });
});
