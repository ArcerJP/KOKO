import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClientMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
}));
vi.mock("../src/auth/server", () => ({
  createServerAuthClient: createClientMock,
}));

import { GET } from "../src/app/auth/callback/route";

const callback = (query = "") =>
  new Request(`https://web.example/auth/callback${query}`);

beforeEach(() => createClientMock.mockReset());

describe("OAuth callback", () => {
  it("codeがない場合は交換せず固定の失敗画面へ戻す", async () => {
    const response = await GET(callback("?next=https://evil.example"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://web.example/login?error=auth",
    );
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("Google単独セッションだけを/accountへ通す", async () => {
    const exchangeCodeForSession = vi.fn().mockResolvedValue({ error: null });
    const getClaims = vi.fn().mockResolvedValue({
      data: {
        claims: {
          role: "authenticated",
          is_anonymous: false,
          app_metadata: { provider: "google", providers: ["google"] },
        },
      },
      error: null,
    });
    createClientMock.mockResolvedValue({
      auth: { exchangeCodeForSession, getClaims },
    });

    const response = await GET(callback("?code=one-time-code"));
    expect(exchangeCodeForSession).toHaveBeenCalledWith("one-time-code");
    expect(response.headers.get("location")).toBe(
      "https://web.example/account",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("Emailセッションは消去し、エラー詳細をURLへ出さない", async () => {
    const signOut = vi.fn().mockResolvedValue({ error: null });
    createClientMock.mockResolvedValue({
      auth: {
        exchangeCodeForSession: vi.fn().mockResolvedValue({ error: null }),
        getClaims: vi.fn().mockResolvedValue({
          data: {
            claims: {
              role: "authenticated",
              is_anonymous: false,
              app_metadata: { provider: "email", providers: ["email"] },
            },
          },
          error: null,
        }),
        signOut,
      },
    });

    const response = await GET(callback("?code=secret-code"));
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(response.headers.get("location")).toBe(
      "https://web.example/login?error=auth",
    );
    expect(response.headers.get("location")).not.toContain("secret-code");
  });
});
