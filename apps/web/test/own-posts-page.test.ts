import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { postStates } from "@koko/contract";
import { PostsView } from "../src/app/account/posts/posts-view";
import { ownPostsEventId } from "../src/api/own-posts-config";
import { eventId, me, post } from "./own-posts-fixture";

const { createClient, redirect } = vi.hoisted(() => ({
  createClient: vi.fn(),
  redirect: vi.fn(() => {
    throw new Error("REDIRECT_LOGIN");
  }),
}));
vi.mock("../src/auth/server", () => ({ createServerAuthClient: createClient }));
vi.mock("next/navigation", () => ({ redirect }));
import OwnPostsPage from "../src/app/account/posts/page";

const flags = {
  KOKO_OWN_POSTS_UI_ENABLED: "true",
  KOKO_OWN_POSTS_PROXY_ENABLED: "true",
  KOKO_ACCOUNT_UI_ENABLED: "true",
  KOKO_API_COOKIE_ENABLED: "true",
  KOKO_API_PROXY_ENABLED: "true",
  KOKO_EVENT_ID: eventId,
};
beforeEach(() => {
  for (const [key, value] of Object.entries(flags)) vi.stubEnv(key, value);
  createClient.mockReset();
  createClient.mockResolvedValue({
    auth: {
      getClaims: vi.fn().mockResolvedValue({
        data: {
          claims: {
            sub: me.user_id,
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
it.each(Object.keys(flags))(
  "requires %s and stays closed without touching auth",
  async (key) => {
    expect(ownPostsEventId({ ...flags, [key]: "" })).toBeNull();
    vi.stubEnv(key, "");
    const html = renderToStaticMarkup(await OwnPostsPage());
    expect(html).toContain("現在無効");
    expect(html).not.toContain("本人確認・先頭から読み込む");
    expect(createClient).not.toHaveBeenCalled();
  },
);
it("has no history/credentials in server-rendered output and no initial data request", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  try {
    const html = renderToStaticMarkup(await OwnPostsPage());
    expect(html).toContain("本人確認・先頭から読み込む");
    expect(html).toContain("ログアウト");
    expect(html).not.toMatch(/<article|csrf|secret|Cookie|block_category/);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
it.each([
  null,
  { data: null, error: {} },
  {
    data: { claims: { sub: me.user_id, app_metadata: { provider: "email" } } },
    error: null,
  },
  {
    data: {
      claims: {
        sub: "bad",
        app_metadata: { provider: "google", providers: ["google"] },
      },
    },
    error: null,
  },
])("redirects unverifiable identity %j", async (claims) => {
  createClient.mockResolvedValue(
    claims === null
      ? null
      : { auth: { getClaims: vi.fn().mockResolvedValue(claims) } },
  );
  await expect(OwnPostsPage()).rejects.toThrow("REDIRECT_LOGIN");
});
it("renders all contract states with no fake appeal/delete/media controls or raw categories", () => {
  const html = renderToStaticMarkup(
    createElement(PostsView, {
      state: {
        phase: "ready",
        items: postStates.map((status, n) => ({
          ...post(n + 1, { status }),
          raw_block_category: "PRIVATE_RAW",
        })),
        nextCursor: null,
        message: "<script>unsafe</script>",
      },
      onReload() {},
      onMore() {},
      onRefresh() {},
    }),
  );
  for (const label of [
    "送信中",
    "送信未完了",
    "処理待ち",
    "処理中",
    "公開済み",
    "運営確認対象",
    "BLOCK",
    "保留",
    "非表示",
    "削除受付済み",
  ])
    expect(html).toContain(label);
  expect(html).toContain("異議申立て機能は準備中");
  expect(html).toContain("原本削除完了を示すものではありません");
  expect(html).not.toMatch(/PRIVATE_RAW|<script>|<img|<video|<form/);
  expect(html).toContain("&lt;script&gt;");
});
