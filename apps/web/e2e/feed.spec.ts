import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  cursor,
  feedPage,
  id,
  me,
  publicPost,
  theme,
} from "../test/feed-fixture";
let script: string, html: string;
test.beforeAll(async () => {
  const output = await build({
    entryPoints: [
      fileURLToPath(new URL("./feed-harness.tsx", import.meta.url)),
    ],
    bundle: true,
    write: false,
    outfile: "feed.js",
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" },
    plugins: [
      {
        name: "synthetic-session-and-codec",
        setup(builder) {
          builder.onResolve({ filter: /auth\/browser$/ }, () => ({
            path: "auth",
            namespace: "feed-mock",
          }));
          builder.onResolve({ filter: /^hls\.js$/ }, () => ({
            path: "hls",
            namespace: "feed-mock",
          }));
          // The standalone esbuild harness lacks Next's CommonJS default interop.
          // Re-export the actual Next component; do not replace its image behavior.
          builder.onResolve({ filter: /^next\/(?:image|link)$/ }, (args) => ({
            path: args.path,
            namespace: "next-interop",
          }));
          builder.onLoad(
            { filter: /.*/, namespace: "next-interop" },
            (args) => ({
              loader: "js",
              resolveDir: fileURLToPath(new URL("..", import.meta.url)),
              contents:
                args.path === "next/image"
                  ? 'export { Image as default } from "next/dist/client/image-component";'
                  : 'import Link from "next/dist/client/link"; export default Link.default ?? Link;',
            }),
          );
          builder.onLoad({ filter: /.*/, namespace: "feed-mock" }, (args) => ({
            loader: "js",
            contents:
              args.path === "auth"
                ? `const listeners = new Set(); window.feedAuthEvent = e => listeners.forEach(l => l(e)); export const createBrowserAuthClient = () => ({auth:{ onAuthStateChange(l) { listeners.add(l); l("INITIAL_SESSION"); return {data:{subscription:{unsubscribe(){listeners.delete(l)}}}}; } }});`
                : `export default class Hls { static isSupported(){return true} static Events={ERROR:"error",MANIFEST_PARSED:"manifest"}; constructor(config){this.config=config} on(){} attachMedia(v){this.v=v;v.dataset.syntheticHls="true"} loadSource(url){this.v.dataset.source=url} destroy(){if(this.v)delete this.v.dataset.syntheticHls} }`,
          }));
        },
      },
    ],
  });
  script = output.outputFiles.find((f) => f.path.endsWith(".js"))!.text;
  const css =
    (
      await Promise.all(
        ["../src/app/globals.css", "../src/styles/tokens.css"].map((p) =>
          readFile(new URL(p, import.meta.url), "utf8"),
        ),
      )
    ).join("") +
    output.outputFiles
      .filter((f) => f.path.endsWith(".css"))
      .map((f) => f.text)
      .join("");
  html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/__feed-harness.js"></script></body></html>`;
});
async function mount(
  page: Page,
  options: { video?: boolean; theme?: string } = {},
) {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  let head = 100,
    listCalls = 0;
  await page.route("**/__feed-harness**", (route) =>
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
  await page.route("**/api/me", (route) =>
    route.fulfill({
      json: {
        ...me,
        csrf_token: "synthetic-csrf-value-abcdefghijklmnopqrstuvwxyz",
      },
    }),
  );
  await page.route("**/api/feed?**", (route) => {
    listCalls++;
    const q = new URL(route.request().url()).searchParams;
    const rows = feedPage(
      q.has("cursor") ? 70 : head,
      30,
      q.has("cursor") ? null : cursor,
    );
    rows.items = rows.items.map((p) => ({
      ...publicPost(Number(p.id.slice(-12)), options.video),
      theme_id: options.theme ?? null,
    }));
    return route.fulfill({ json: rows });
  });
  await page.route("**/api/posts/*", (route) =>
    route.fulfill({
      json: publicPost(
        Number(new URL(route.request().url()).pathname.split("/").at(-1)),
        options.video,
      ),
    }),
  );
  await page.route("**/api/posts/*/reports", (route) =>
    route.fulfill({ json: { request_id: id(900) } }),
  );
  await page.route("**/media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><rect width="600" height="600" fill="#cde3e3"/><circle cx="300" cy="260" r="120" fill="#718c9e"/></svg>',
    }),
  );
  await page.goto(
    `/__feed-harness${options.theme ? `?theme_id=${options.theme}` : ""}`,
  );
  await page.getByRole("button", { name: "本人確認・投稿を読み込む" }).click();
  await expect(
    page.getByRole("button", { name: "投稿者100さんの投稿を全画面で開く" }),
  ).toBeVisible();
  expect(runtimeErrors).toEqual([]);
  return {
    newHead: () => {
      head = 102;
    },
    calls: () => listCalls,
  };
}
test("feature gate remains closed in the actual default server route", async ({
  page,
}) => {
  await page.goto("/feed");
  await expect(page.getByText(/公開投稿の閲覧は現在無効/)).toBeVisible();
});
test("three columns, explicit pagination, fullscreen ±1 resources and restored anchor", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page);
  const cards = page.locator("[data-feed-id]");
  await expect(cards).toHaveCount(30);
  const bounds = await cards.evaluateAll((nodes) =>
    nodes.slice(0, 4).map((n) => ({
      x: n.getBoundingClientRect().x,
      y: n.getBoundingClientRect().y,
    })),
  );
  expect(bounds[0]?.y).toBe(bounds[1]?.y);
  expect(bounds[1]?.y).toBe(bounds[2]?.y);
  expect(bounds[3]!.y).toBeGreaterThan(bounds[0]!.y);
  await page.getByRole("button", { name: "続きを読み込む" }).click();
  await expect(cards).toHaveCount(60);
  const open = page.getByRole("button", {
    name: "投稿者90さんの投稿を全画面で開く",
  });
  await open.scrollIntoViewIfNeeded();
  const y = await page.evaluate(() => scrollY);
  await open.click();
  const modal = page.getByRole("dialog");
  await expect(modal).toBeVisible();
  await expect(modal.locator("img")).toHaveCount(3);
  await page.screenshot({ path: "test-results/feed-mobile-fullscreen.png" });
  await page.getByRole("button", { name: "一覧に戻る" }).click();
  await expect(modal).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(y);
  await expect(open).toBeFocused();
  await page.screenshot({ path: "test-results/feed-mobile-grid.png" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("poll announces new posts without moving the existing anchor", async ({
  page,
}) => {
  await page.clock.install();
  const data = await mount(page);
  const first = page.locator("[data-feed-id]").first();
  data.newHead();
  await page.clock.fastForward(10010);
  await expect(page.getByRole("button", { name: /新着 2 件/ })).toBeVisible();
  await expect(first).toHaveAttribute("data-feed-id", id(100));
  await page.getByRole("button", { name: /新着 2 件/ }).click();
  await expect(first).toHaveAttribute("data-feed-id", id(102));
});
test("at most six visible grid videos; fullscreen starts muted and sound needs a click", async ({
  page,
}) => {
  // Force only the synthetic MSE adapter path; this is not a codec acceptance test.
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) {
      return /mpegurl/i.test(type) ? "" : original.call(this, type);
    };
  });
  await page.setViewportSize({ width: 1280, height: 1600 });
  await mount(page, { video: true });
  await expect.poll(() => page.locator("video").count()).toBe(6);
  expect(
    await page
      .locator("video")
      .evaluateAll((v) =>
        v.every(
          (el) =>
            (el as HTMLVideoElement).muted &&
            (el as HTMLVideoElement).loop &&
            (el as HTMLVideoElement).playsInline,
        ),
      ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "投稿者99さんの投稿を全画面で開く" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("video")).toHaveCount(3);
  await page.getByRole("button", { name: "タップして音を出す" }).click();
  await expect(page.getByRole("button", { name: "音を消す" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
test("browser back and left swipe close fullscreen without loading public video URLs", async ({
  page,
}) => {
  await mount(page);
  const open = page.getByRole("button", {
    name: "投稿者100さんの投稿を全画面で開く",
  });
  await open.click();
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await open.click();
  const media = page.getByRole("dialog").locator("img").first();
  await media.dispatchEvent("pointerdown", { clientX: 250, clientY: 150 });
  await media.dispatchEvent("pointerup", { clientX: 100, clientY: 155 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("authentication switch immediately discards every displayed resource", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    (window as unknown as { feedAuthEvent: (e: string) => void }).feedAuthEvent(
      "SIGNED_OUT",
    );
  });
  await expect(page.locator("[data-feed-id]")).toHaveCount(0);
  await expect(page.getByText(/ログイン状態が変わったため/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "本人確認・投稿を読み込む" }),
  ).toBeDisabled();
});
test("filters page theme_id into API theme only", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/feed?")) requests.push(r.url());
  });
  await mount(page, { theme });
  expect(requests[0]).toContain(`theme=${theme}`);
  expect(requests[0]).not.toContain("theme_id");
});
test("wide layout remains bounded and shows readable synthetic media", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page);
  await expect(page.locator("[data-feed-id] img").first()).toBeVisible();
  await page.screenshot({ path: "test-results/feed-desktop-grid.png" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("a confirmed report clears the shown post and returns to the list", async ({
  page,
}) => {
  await mount(page);
  await page
    .getByRole("button", { name: "投稿者100さんの投稿を全画面で開く" })
    .click();
  await page.getByText("この投稿を通報", { exact: true }).click();
  await page.getByRole("button", { name: "本人確認・操作を準備" }).click();
  await page.getByRole("checkbox").check();
  const submitted = page.waitForRequest(
    (r) =>
      r.url().endsWith(`/api/posts/${id(100)}/reports`) &&
      r.method() === "POST",
  );
  await page.getByRole("button", { name: "通報を送信する" }).click();
  expect((await submitted).postDataJSON()).toEqual({
    reason: "privacy",
    detail: "",
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(`[data-feed-id="${id(100)}"]`)).toHaveCount(0);
});
