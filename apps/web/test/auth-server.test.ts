import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cookieStore, createClient, cookies } = vi.hoisted(() => {
  const cookieStore = { getAll: vi.fn(), set: vi.fn() };
  return {
    cookieStore,
    createClient: vi.fn(),
    cookies: vi.fn().mockResolvedValue(cookieStore),
  };
});
vi.mock("@supabase/ssr", () => ({ createServerClient: createClient }));
vi.mock("next/headers", () => ({ cookies }));
import { createServerAuthClient } from "../src/auth/server";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  createClient.mockReset();
  cookieStore.set.mockReset();
  cookieStore.getAll.mockReturnValue([{ name: "ssr", value: "synthetic" }]);
});
afterEach(() => vi.unstubAllEnvs());

describe("サーバーCookie writerの明示的な厳密化", () => {
  it("全Cookieを読み、更新の属性を保って保存する", async () => {
    await createServerAuthClient({ requireCookieWrites: true });
    const adapter = createClient.mock.calls[0]![2].cookies;
    expect(adapter.getAll()).toEqual([{ name: "ssr", value: "synthetic" }]);
    const options = { secure: true, path: "/", maxAge: 120 };
    adapter.setAll([{ name: "ssr", value: "rotated", options }]);
    expect(cookieStore.set).toHaveBeenCalledWith("ssr", "rotated", options);
  });

  it("新しい書込みrouteは保存失敗を抑止せず固定エラーにする", async () => {
    cookieStore.set.mockImplementation(() => {
      throw new Error("private-canary");
    });
    await createServerAuthClient({ requireCookieWrites: true });
    const adapter = createClient.mock.calls[0]![2].cookies;
    expect(() =>
      adapter.setAll([{ name: "ssr", value: "rotated", options: {} }]),
    ).toThrow("Auth cookie update failed");
  });

  it("既存Server Componentの読取り経路は変更しない", async () => {
    cookieStore.set.mockImplementation(() => {
      throw new Error("Read-only cookies");
    });
    await createServerAuthClient();
    const adapter = createClient.mock.calls[0]![2].cookies;
    expect(() =>
      adapter.setAll([{ name: "ssr", value: "rotated", options: {} }]),
    ).not.toThrow();
  });

  it("公開設定がなければSDKやCookie APIへ接続しない", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    expect(
      await createServerAuthClient({ requireCookieWrites: true }),
    ).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
    expect(cookies).not.toHaveBeenCalled();
  });
});
