import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
declare global {
  interface Window {
    enrollmentAuthEvent: (event: string) => void;
  }
}
const eventId = "22222222-2222-4222-8222-222222222222";
const userId = "11111111-1111-4111-8111-111111111111";
const csrf = "synthetic-csrf-value-for-enrollment-test";
let html: string, script: string;
test.beforeAll(async () => {
  const bundled = await build({
    entryPoints: [
      fileURLToPath(new URL("./enrollment-harness.tsx", import.meta.url)),
    ],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" },
    plugins: [
      {
        name: "synthetic-auth",
        setup(builder) {
          builder.onResolve({ filter: /auth\/browser$/ }, () => ({
            path: "auth",
            namespace: "synthetic-auth",
          }));
          builder.onLoad({ filter: /.*/, namespace: "synthetic-auth" }, () => ({
            loader: "js",
            contents: `
        const listeners = new Set();
        window.enrollmentAuthEvent = event => listeners.forEach(listener => listener(event));
        export const createBrowserAuthClient = () => ({ auth: {
          onAuthStateChange(listener) { listeners.add(listener); listener("INITIAL_SESSION"); return { data: { subscription: { unsubscribe() { listeners.delete(listener); } } } }; },
          signOut: async () => ({ error: null })
        } });`,
          }));
        },
      },
    ],
  });
  script = bundled.outputFiles[0]!.text;
  const css = await readFile(
    new URL("../src/app/globals.css", import.meta.url),
    "utf8",
  );
  const tokens = await readFile(
    new URL("../src/styles/tokens.css", import.meta.url),
    "utf8",
  );
  html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${tokens}${css}</style></head><body><div id="root"></div><script src="/__enrollment-harness.js"></script></body></html>`;
});
async function mount(page: Page) {
  let enrolled = false,
    name = "";
  const writes: unknown[] = [];
  await page.route("**/__enrollment-harness**", (route) =>
    route.fulfill({
      contentType: route.request().url().endsWith(".js")
        ? "application/javascript"
        : "text/html",
      body: route.request().url().endsWith(".js") ? script : html,
    }),
  );
  await page.route("**/auth/api-session", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/me/enrollment", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      writes.push(body);
      name = body.display_name;
      enrolled = true;
      return route.fulfill({ json: { request_id: userId } });
    }
    return route.fulfill({
      json: {
        user_id: userId,
        event_id: eventId,
        enrolled,
        registration_open: !enrolled,
        csrf_token: csrf,
      },
    });
  });
  await page.route("**/api/me", (route) =>
    route.fulfill({
      json: {
        user_id: userId,
        event_id: eventId,
        display_name: name,
        role: "user",
        is_banned: false,
        crown: "none",
        terms_version: "unadopted",
        consent_required: true,
        csrf_token: csrf,
      },
    }),
  );
  await page.goto("/__enrollment-harness");
  await expect(
    page.getByRole("button", { name: "参加状況を確認する" }),
  ).toBeEnabled();
  return writes;
}
for (const width of [390, 1280])
  test(`初回参加・表示名・規約準備中・終了 ${width}px`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width, height: 844 });
    const writes = await mount(page);
    await page.getByRole("button", { name: "参加状況を確認する" }).click();
    await expect(page.getByLabel("イベントで使う表示名")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "この表示名で参加する" }),
    ).toBeDisabled();
    await page.getByLabel("イベントで使う表示名").fill("合成試験の参加者");
    await page.getByRole("button", { name: "この表示名で参加する" }).click();
    await expect(
      page.getByText("合成試験の参加者", { exact: true }),
    ).toBeVisible();
    expect(writes).toEqual([{ display_name: "合成試験の参加者" }]);
    await expect(page.getByLabel("イベントで使う表示名")).toHaveCount(0);
    await expect(page.getByRole("checkbox")).toHaveCount(0); // unadopted policy cannot be consented to
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`enrollment-${width}.png`),
      fullPage: true,
    });
    await page.evaluate(() => window.enrollmentAuthEvent("SIGNED_OUT"));
    await expect(
      page.getByText("合成試験の参加者", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "参加状況を確認する" }),
    ).toBeDisabled();
    expect(errors).toEqual([]);
  });
test("実routeは既定OFFで秘密/設定変更なし", async ({ request }) => {
  for (const method of ["GET", "POST"]) {
    const r = await request.fetch("/api/me/enrollment", { method });
    expect(r.status()).toBe(404);
    expect(r.headers()["cache-control"]).toBe("private, no-store");
    expect(r.headers()["set-cookie"]).toBeUndefined();
    expect(await r.json()).toEqual({
      code: "NOT_FOUND",
      request_id: expect.any(String),
    });
  }
});
