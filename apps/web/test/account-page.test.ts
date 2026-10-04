import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const { createClient, redirect } = vi.hoisted(() => ({
  createClient: vi.fn(),
  redirect: vi.fn(() => {
    throw new Error("REDIRECT_LOGIN");
  }),
}));
vi.mock("../src/auth/server", () => ({ createServerAuthClient: createClient }));
vi.mock("next/navigation", () => ({ redirect }));
import AccountPage from "../src/app/account/page";
import { mockEventId } from "../src/mocks/handlers";

beforeEach(() => {
  vi.stubEnv("KOKO_ACCOUNT_UI_ENABLED", "");
  vi.stubEnv("KOKO_API_COOKIE_ENABLED", "");
  vi.stubEnv("KOKO_API_PROXY_ENABLED", "");
  vi.stubEnv("KOKO_EVENT_ID", mockEventId);
  createClient.mockResolvedValue({
    auth: {
      getClaims: vi.fn().mockResolvedValue({
        data: {
          claims: {
            role: "authenticated",
            is_anonymous: false,
            app_metadata: { provider: "google", providers: ["google"] },
          },
        },
        error: null,
      }),
    },
  });
  redirect.mockClear();
});
afterEach(() => vi.unstubAllEnvs());
describe("account画面の入口", () => {
  it("既定無効では従来logoutだけ", async () => {
    const html = renderToStaticMarkup(await AccountPage());
    expect(html).toContain("ログアウト");
    expect(html).toContain("現在は無効");
    expect(html).not.toContain("本人情報を読み込む");
  });
  it("有効時もSSRには本人情報・CSRFを取得/表示しない", async () => {
    vi.stubEnv("KOKO_ACCOUNT_UI_ENABLED", "true");
    vi.stubEnv("KOKO_API_COOKIE_ENABLED", "true");
    vi.stubEnv("KOKO_API_PROXY_ENABLED", "true");
    const html = renderToStaticMarkup(await AccountPage());
    expect(html).toContain("本人情報を読み込む");
    expect(html).not.toContain("csrf");
    expect(html).not.toContain("<input");
  });
  it("未認証は既存のlogin redirect", async () => {
    createClient.mockResolvedValue(null);
    await expect(AccountPage()).rejects.toThrow("REDIRECT_LOGIN");
    expect(redirect).toHaveBeenCalledWith("/login");
  });
});
