import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { page as postsPage, post, me } from "../test/own-posts-fixture";

declare global {
  interface Window {
    postsAuthEvent: (event: string) => void;
  }
}
let script: string, html: string;
test.beforeAll(async () => {
  const built = await build({
    entryPoints: [
      fileURLToPath(new URL("./own-posts-harness.tsx", import.meta.url)),
    ],
    bundle: true,
    write: false,
    outfile: "own-posts.js",
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" },
    plugins: [
      {
        name: "synthetic-auth-only",
        setup(builder) {
          builder.onResolve({ filter: /^next\/link$/ }, () => ({
            path: "link",
            namespace: "next-interop",
          }));
          builder.onLoad({ filter: /.*/, namespace: "next-interop" }, () => ({
            loader: "js",
            resolveDir: fileURLToPath(new URL("..", import.meta.url)),
            contents:
              'import Link from "next/dist/client/link"; export default Link.default ?? Link;',
          }));
          builder.onResolve({ filter: /auth\/browser$/ }, () => ({
            path: "auth",
            namespace: "synthetic-auth",
          }));
          builder.onLoad({ filter: /.*/, namespace: "synthetic-auth" }, () => ({
            loader: "js",
            contents: `
        const listeners = new Set();
        window.postsAuthEvent = event => listeners.forEach(listener => listener(event));
        export const createBrowserAuthClient = () => ({ auth: {
          onAuthStateChange(listener) { listeners.add(listener); listener("INITIAL_SESSION"); return { data: { subscription: { unsubscribe() { listeners.delete(listener); } } } }; },
          signOut: async () => ({ error: null })
        } });
      `,
          }));
        },
      },
    ],
  });
  script = built.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  const css = await readFile(
    new URL("../src/app/globals.css", import.meta.url),
    "utf8",
  );
  const tokens = await readFile(
    new URL("../src/styles/tokens.css", import.meta.url),
    "utf8",
  );
  const operationCss = built.outputFiles
    .filter((file) => file.path.endsWith(".css"))
    .map((file) => file.text)
    .join("");
  html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${tokens}${css}${operationCss}</style></head><body><div id="root"></div><script src="/__posts-harness.js"></script></body></html>`;
});
async function mount(page: Page, query = "") {
  await page.route("**/__posts-harness**", (route) =>
    route.fulfill({
      contentType: new URL(route.request().url()).pathname.endsWith(".js")
        ? "application/javascript"
        : "text/html",
      body: new URL(route.request().url()).pathname.endsWith(".js")
        ? script
        : html,
    }),
  );
  await page.route("**/auth/api-session", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/me", (route) => route.fulfill({ json: me }));
  await page.route("**/api/me/posts?**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).searchParams.has("cursor")
        ? postsPage(31, 1, null)
        : postsPage(),
    }),
  );
  await page.route("**/api/posts/*/status", (route) =>
    route.fulfill({
      json: post(1, {
        status: "held",
        version: 2,
        error_code: "PROCESSING_HELD",
      }),
    }),
  );
  await page.goto(`/__posts-harness${query}`);
  await expect(
    page.getByRole("button", { name: "本人確認・先頭から読み込む" }),
  ).toBeEnabled();
}
for (const width of [390, 1280])
  test(`投稿履歴の読込み・ページ送り・状態更新・破棄 ${width}px`, async ({
    page,
  }, info) => {
    const errors: string[] = [],
      external: string[] = [],
      reads: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (!r.url().startsWith("http://127.0.0.1:3100/")) external.push(r.url());
      if (r.url().includes("/api/")) reads.push(r.url());
    });
    await page.setViewportSize({ width, height: 844 });
    await mount(page);
    expect(reads).toEqual([]);
    const reload = page.getByRole("button", {
      name: "本人確認・先頭から読み込む",
    });
    await reload.focus();
    await expect(reload).toBeFocused();
    await reload.press("Enter");
    await expect(page.getByRole("article")).toHaveCount(30);
    await page.getByRole("button", { name: "続きを読み込む" }).click();
    await expect(page.getByRole("article")).toHaveCount(31);
    await page
      .getByRole("button", { name: "この投稿の状態を更新" })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: "保留", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("異議申立て機能は準備中", { exact: false }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`own-posts-${width}.png`),
      fullPage: false,
    });
    // Event from an expired/refreshed session cannot preserve old private data.
    await page.evaluate(() => window.postsAuthEvent("TOKEN_REFRESHED"));
    await expect(page.getByRole("article")).toHaveCount(0);
    await expect(reload).toBeEnabled();
    await reload.click();
    await expect(page.getByRole("article")).toHaveCount(30);
    // Actual other-tab pre-sign-out signal, not a direct controller call.
    await page.evaluate(() => {
      const channel = new BroadcastChannel("koko-upload-stop");
      channel.postMessage("stop");
      channel.close();
    });
    await expect(page.getByRole("article")).toHaveCount(0);
    await expect(reload).toBeDisabled();
    expect(
      await page.evaluate(() => ({
        local: localStorage.length,
        session: sessionStorage.length,
      })),
    ).toEqual({ local: 0, session: 0 });
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
test("期限切れ後は先頭から再読込でき、アカウント切替で破棄する", async ({
  page,
}) => {
  await mount(page);
  const reload = page.getByRole("button", {
    name: "本人確認・先頭から読み込む",
  });
  await reload.click();
  await expect(page.getByRole("article")).toHaveCount(30);
  await page.route("**/api/me/posts?**", (route) =>
    route.fulfill({
      status: 400,
      json: { code: "INVALID_CURSOR", request_id: post().id },
    }),
  );
  await page.getByRole("button", { name: "続きを読み込む" }).click();
  await expect(page.getByRole("alert")).toContainText("期限切れ");
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(reload).toBeEnabled();
  await page.route("**/api/me/posts?**", (route) =>
    route.fulfill({ json: postsPage(1, 1, null) }),
  );
  await reload.click();
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.evaluate(() => window.postsAuthEvent("SIGNED_IN"));
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(reload).toBeDisabled();
});
test("閉じる・非表示・ログアウト開始で履歴を即時破棄する", async ({ page }) => {
  for (const event of ["visibilitychange", "pagehide", "koko-upload-stop"]) {
    await mount(page);
    await page
      .getByRole("button", { name: "本人確認・先頭から読み込む" })
      .click();
    await expect(page.getByRole("article")).toHaveCount(30);
    await page.evaluate((event) => {
      if (event === "visibilitychange") {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "hidden",
        });
        document.dispatchEvent(new Event(event));
      } else window.dispatchEvent(new Event(event));
    }, event);
    await expect(page.getByRole("article")).toHaveCount(0);
  }
});
test("実装routeは既定OFFで外部接続・書込みを行わない", async ({ request }) => {
  for (const path of ["/api/me/posts", `/api/posts/${post().id}/status`]) {
    for (const method of ["GET", "POST", "OPTIONS"]) {
      const response = await request.fetch(path, { method });
      expect(response.status()).toBe(404);
      expect(response.headers()["cache-control"]).toBe("private, no-store");
      expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
    }
  }
  const response = await request.get("/account/posts");
  expect(await response.text()).toContain("投稿状況の確認は現在無効です");
});

test("ログアウトボタンは終了失敗時にも投稿画面を再開しない", async ({
  page,
}) => {
  await mount(page);
  const reload = page.getByRole("button", {
    name: "本人確認・先頭から読み込む",
  });
  await reload.click();
  await expect(page.getByRole("article")).toHaveCount(30);
  await page.route("**/auth/api-sign-out", (route) =>
    route.fulfill({ status: 500, json: { code: "INTERNAL_ERROR" } }),
  );
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(reload).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText(
    "ログアウトを完了できませんでした",
  );
});
test("本人はBAN中も明示削除でき、再読取り後は削除受付と申立て導線を区別", async ({
  page,
}) => {
  await mount(page, "?actions=1");
  let deleted = false;
  await page.route("**/api/me", (route) =>
    route.fulfill({
      json: {
        ...me,
        is_banned: true,
        csrf_token: "synthetic-csrf-abcdefghijklmnopqrstuvwxyz",
      },
    }),
  );
  await page.route("**/api/me/posts?**", (route) =>
    route.fulfill({
      json: {
        items: [
          post(1, { status: deleted ? "deleted" : "hidden" }),
          post(2, { status: "blocked" }),
        ],
        next_cursor: null,
      },
    }),
  );
  let writes = 0;
  await page.route(`**/api/posts/${post(1).id}`, (route) => {
    if (route.request().method() !== "DELETE") return route.abort();
    writes++;
    deleted = true;
    return route.fulfill({
      json: { request_id: "00000000-0000-4000-8000-000000000030" },
    });
  });
  await page
    .getByRole("button", { name: "本人確認・先頭から読み込む" })
    .click();
  const first = page.getByRole("article").first();
  await expect(
    first.getByRole("link", { name: "この投稿について異議を申し立てる" }),
  ).toHaveAttribute("href", `/appeal?post=${post(1).id}`);
  expect(writes).toBe(0);
  await first.getByText("自分の投稿を削除", { exact: true }).click();
  await first.getByRole("button", { name: "本人確認・操作を準備" }).click();
  await first.getByRole("checkbox").check();
  await first.getByRole("button", { name: "本人の投稿を削除する" }).click();
  await expect(
    first.getByRole("heading", { name: "削除受付済み" }),
  ).toBeVisible();
  expect(writes).toBe(1);
  await expect(
    first.getByText("自分の投稿を削除", { exact: true }),
  ).toHaveCount(0);
});
