import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const { createClient, redirect } = vi.hoisted(() => ({
  createClient: vi.fn(),
  redirect: vi.fn(() => {
    throw new Error("REDIRECT_LOGIN");
  }),
}));
vi.mock("../src/auth/server", () => ({ createServerAuthClient: createClient }));
vi.mock("next/navigation", () => ({ redirect }));
import FeedPage from "../src/app/feed/page";
import { eventId, owner, theme } from "./feed-fixture";
beforeEach(() => {
  vi.clearAllMocks();
  for (const name of [
    "KOKO_PUBLIC_FEED_ENABLED",
    "KOKO_ACCOUNT_UI_ENABLED",
    "KOKO_API_COOKIE_ENABLED",
    "KOKO_API_PROXY_ENABLED",
  ])
    vi.stubEnv(name, "true");
  vi.stubEnv("KOKO_EVENT_ID", eventId);
  createClient.mockResolvedValue({
    auth: {
      getClaims: async () => ({
        data: {
          claims: {
            sub: owner,
            role: "authenticated",
            is_anonymous: false,
            app_metadata: { provider: "google", providers: ["google"] },
          },
        },
        error: null,
      }),
    },
  });
});
afterEach(() => vi.unstubAllEnvs());
it("feature defaults off before touching session", async () => {
  vi.stubEnv("KOKO_PUBLIC_FEED_ENABLED", "");
  const html = renderToStaticMarkup(
    await FeedPage({ searchParams: Promise.resolve({}) }),
  );
  expect(html).toContain("現在無効");
  expect(createClient).not.toHaveBeenCalled();
});
it("requires a Google authenticated server session", async () => {
  createClient.mockResolvedValue(null);
  await expect(FeedPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
    "REDIRECT_LOGIN",
  );
});
it.each(["bad", [theme, theme]])(
  "invalid filter never silently displays all posts",
  async (theme_id) => {
    const html = renderToStaticMarkup(
      await FeedPage({ searchParams: Promise.resolve({ theme_id }) }),
    );
    expect(html).toContain("お題の指定が正しくありません");
    expect(html).not.toContain("本人確認・投稿");
  },
);
it("only injects fixed event owner and validated theme", async () => {
  const html = renderToStaticMarkup(
    await FeedPage({ searchParams: Promise.resolve({ theme_id: theme }) }),
  );
  expect(html).toContain("お題で絞り込んでいます");
  expect(html).toContain("本人確認・投稿を読み込む");
  expect(html).not.toContain("SUPABASE");
});
