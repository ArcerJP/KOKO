import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { harness } from "./upload-harness";
// Type import only: the harness is not executed in Node.
declare global {
  interface Window {
    queueHarness: typeof harness;
  }
}
let script: string;
let html: string;
test.beforeAll(async () => {
  const built = await build({
    entryPoints: [
      fileURLToPath(new URL("./upload-harness.tsx", import.meta.url)),
    ],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    // Trimming already has real Worker E2E. This harness tests photo persistence/UI only.
    plugins: [
      {
        name: "no-worker-in-photo-harness",
        setup(builder) {
          // Match Next's CJS interop without replacing its real Image implementation.
          builder.onResolve({ filter: /^next\/image$/ }, () => ({
            path: "image",
            namespace: "next-image",
          }));
          builder.onLoad({ filter: /.*/, namespace: "next-image" }, () => ({
            contents:
              'export { Image as default } from "next/dist/client/image-component";',
            loader: "js",
            resolveDir: fileURLToPath(new URL("../", import.meta.url)),
          }));
          builder.onResolve({ filter: /worker-client$/ }, () => ({
            path: "worker-client",
            namespace: "synthetic",
          }));
          builder.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({
            contents:
              'export const runTrim = async () => { throw new Error("not used in photo test"); };',
            loader: "js",
          }));
        },
      },
    ],
  });
  script = built.outputFiles[0]!.text;
  const css = await readFile(
    new URL("../src/app/globals.css", import.meta.url),
    "utf8",
  );
  const tokens = await readFile(
    new URL("../src/styles/tokens.css", import.meta.url),
    "utf8",
  );
  html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${tokens}${css}</style></head><body><div id="root"></div><script src="/__queue-harness.js"></script></body></html>`;
});
async function mount(context: BrowserContext, page: Page, query = "") {
  await context.route("**/__queue-harness**", (route) =>
    route.fulfill({
      contentType: route.request().url().endsWith(".js")
        ? "application/javascript"
        : "text/html",
      body: route.request().url().endsWith(".js") ? script : html,
    }),
  );
  await page.goto(`/__queue-harness${query}`);
  await page.getByRole("button", { name: "本人確認・読み込み" }).click();
  await expect(page.getByLabel("投稿する写真を撮る／選ぶ")).toBeEnabled();
}
const photo = fileURLToPath(
  new URL("../test/fixtures/photo.png", import.meta.url),
);

for (const width of [390, 1280])
  test(`永続保存→UI遷移→送信完了、秘密/Blobの掃除 ${width}px`, async ({
    page,
    context,
  }, info) => {
    const errors: string[] = [],
      external: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (
        !request.url().startsWith("http://127.0.0.1:3100/") &&
        !request.url().startsWith("blob:")
      )
        external.push(request.url());
    });
    await page.setViewportSize({ width, height: 844 });
    await mount(context, page);
    await page.getByLabel("投稿する写真を撮る／選ぶ").setInputFiles(photo);
    await expect(page.getByRole("img")).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`upload-preview-${width}.png`),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "端末に保存して送信", exact: true })
      .click();
    await expect(
      page.getByText("原本を送信中／再開待ち", { exact: true }),
    ).toBeVisible();
    const serialized = await page.evaluate(async () =>
      JSON.stringify(await window.queueHarness.metadata()),
    );
    expect(serialized).not.toMatch(
      /X-Amz|put_url|csrf|photo\.png|Bearer|Cookie/,
    );
    await page.getByRole("button", { name: "画面切替" }).click();
    await expect(
      page.getByText("別の画面（実行中の送信は保持）"),
    ).toBeVisible();
    await page.evaluate(() => window.queueHarness.release());
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.queueHarness.metadata())[0]?.phase,
        ),
      )
      .toBe("done");
    await page.getByRole("button", { name: "画面切替" }).click();
    await expect(
      page.getByText("サーバー受付済み（公開待ち）", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(async () => {
        const item = (await window.queueHarness.metadata())[0]!;
        try {
          await window.queueHarness.store.blob(item.id);
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

test("reloadでBlobを復元し、別本人には表示せず、同一IDで再開", async ({
  page,
  context,
}) => {
  await mount(context, page);
  await page.evaluate(() => window.queueHarness.offline(true));
  await page.getByLabel("投稿する写真を撮る／選ぶ").setInputFiles(photo);
  await page
    .getByRole("button", { name: "端末に保存して送信", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.queueHarness.metadata()).length),
    )
    .toBe(1);
  const id = await page.evaluate(
    async () => (await window.queueHarness.metadata())[0]!.id,
  );
  await page.reload();
  await page.getByRole("button", { name: "本人確認・読み込み" }).click();
  await expect(
    page.getByRole("button", { name: "この送信を再開" }),
  ).toBeEnabled();
  expect(await page.evaluate(() => window.queueHarness.puts)).toEqual([]);
  const other = await context.newPage();
  await other.goto("/__queue-harness?other=1");
  await other.getByRole("button", { name: "本人確認・読み込み" }).click();
  await expect(
    other.getByText("送信待ちはありません。", { exact: true }),
  ).toBeVisible();
  expect(
    await other.evaluate(async (id) => {
      try {
        await window.queueHarness.store.blob(id);
        return false;
      } catch {
        return true;
      }
    }, id),
  ).toBe(true);
  await page.getByRole("button", { name: "この送信を再開" }).click();
  await expect
    .poll(() => page.evaluate(() => window.queueHarness.puts.length))
    .toBe(1);
  await page.evaluate(() => window.queueHarness.release());
  await expect(
    page.getByText("サーバー受付済み（公開待ち）", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      async () => (await window.queueHarness.metadata())[0]!.id,
    ),
  ).toBe(id);
});

test("複数タブの排他と端末内削除はサーバー操作を増やさない", async ({
  page,
  context,
}) => {
  await mount(context, page);
  await page.getByLabel("投稿する写真を撮る／選ぶ").setInputFiles(photo);
  await page
    .getByRole("button", { name: "端末に保存して送信", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.queueHarness.puts.length))
    .toBe(1);
  const second = await context.newPage();
  await second.goto("/__queue-harness");
  await second.getByRole("button", { name: "本人確認・読み込み" }).click();
  await expect(
    second.getByText("別のタブで送信中です。完了後に本人確認してください。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    second.getByRole("button", { name: "この送信を再開" }),
  ).toHaveCount(0);
  expect(await second.evaluate(() => window.queueHarness.puts.length)).toBe(0);
  await page.evaluate(() => window.queueHarness.release());
  await expect(
    page.getByText("サーバー受付済み（公開待ち）", { exact: true }),
  ).toBeVisible();
  await second.getByRole("button", { name: "本人確認・読み込み" }).click();
  await expect(
    second.getByText("サーバー受付済み（公開待ち）", { exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "端末の保存分を削除" }).click();
  await expect(
    page.getByText("送信待ちはありません。", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.queueHarness.puts.length)).toBe(1);
});

test("Blob保存のquota例外はmetadataもrollbackし、受付/通信をしない", async ({
  page,
  context,
}) => {
  await mount(context, page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === "blobs")
        throw new DOMException("synthetic quota", "QuotaExceededError");
      return key === undefined
        ? original.call(this, value)
        : original.call(this, value, key);
    };
  });
  await page.getByLabel("投稿する写真を撮る／選ぶ").setInputFiles(photo);
  await page
    .getByRole("button", { name: "端末に保存して送信", exact: true })
    .click();
  await expect(
    page.getByText(/この端末に送信待ちデータを保存できません/),
  ).toBeVisible();
  expect(await page.evaluate(() => window.queueHarness.metadata())).toEqual([]);
  expect(await page.evaluate(() => window.queueHarness.puts)).toEqual([]);
  await expect(page.getByRole("img")).toBeVisible();
});

test("productionの送信画面は既定無効", async ({ page }) => {
  await page.goto("/upload");
  await expect(page.getByRole("status")).toContainText("送信機能は現在無効");
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
});
