import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockEventId, mockMe } from "../src/mocks/handlers";
import { post } from "../test/own-posts-fixture";

declare global {
  interface Window {
    operationsAuthEvent: (event: string) => void;
  }
}
let script: string, html: string;
const theme = {
  id: "00000000-0000-4000-8000-000000000011",
  event_id: mockEventId,
  title: "合成のお題",
  description: "展示を見つけよう",
  icon: "📷",
  color: "#5544cc",
  status: "published",
  starts_at: "2026-10-10T00:00:00Z",
  ends_at: "2026-10-11T09:00:00Z",
};
const settings = {
  version: 2,
  publication_stopped: true,
  uploads_enabled: false,
  moderation_concurrency: 1,
  thresholds_approved: true,
  thresholds: [
    {
      engine: "openai",
      category: "violence",
      flag: 0.4,
      block: 0.8,
      immediate_ban: false,
    },
  ],
};
const ack = { request_id: "00000000-0000-4000-8000-000000000012" };
test.beforeAll(async () => {
  const built = await build({
    entryPoints: [
      fileURLToPath(new URL("./operations-harness.tsx", import.meta.url)),
    ],
    bundle: true,
    write: false,
    outfile: "operations.js",
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" },
    plugins: [
      {
        name: "synthetic-auth-only",
        setup(builder) {
          builder.onResolve({ filter: /auth\/browser$/ }, () => ({
            path: "auth",
            namespace: "synthetic-auth",
          }));
          builder.onLoad({ filter: /.*/, namespace: "synthetic-auth" }, () => ({
            loader: "js",
            contents: `const listeners = new Set(); window.operationsAuthEvent = e => listeners.forEach(l => l(e)); export const createBrowserAuthClient = () => ({auth:{ onAuthStateChange(l) { listeners.add(l); l("INITIAL_SESSION"); return {data:{subscription:{unsubscribe(){listeners.delete(l)}}}}; } }});`,
          }));
        },
      },
    ],
  });
  script = built.outputFiles.find((f) => f.path.endsWith(".js"))!.text;
  const css =
    (
      await Promise.all(
        ["../src/app/globals.css", "../src/styles/tokens.css"].map((path) =>
          readFile(new URL(path, import.meta.url), "utf8"),
        ),
      )
    ).join("") +
    built.outputFiles
      .filter((f) => f.path.endsWith(".css"))
      .map((f) => f.text)
      .join("");
  html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script src="/__operations-harness.js"></script></body></html>`;
});

async function mount(page: Page, view = "manage", role = "admin") {
  await page.route("**/__operations-harness**", (route) =>
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
        ...mockMe,
        role,
        is_banned: view === "appeal" || view === "delete-own",
        csrf_token: "synthetic-csrf-value-abcdefghijklmnopqrstuvwxyz",
      },
    }),
  );
  await page.route("**/api/admin/feed?**", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            post: post(10, { status: "published_flagged", version: 4 }),
            user_id: mockMe.user_id,
            report_count: 2,
            is_banned: false,
          },
          {
            post: post(20, { status: "blocked" }),
            user_id: mockMe.user_id,
            report_count: 0,
            is_banned: true,
          },
        ],
        next_cursor: null,
      },
    }),
  );
  await page.route("**/api/admin/themes", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { items: [theme] } })
      : route.fulfill({ json: ack }),
  );
  await page.route("**/api/themes", (route) =>
    route.fulfill({ json: { items: [theme] } }),
  );
  await page.route("**/api/admin/settings", (route) =>
    route.fulfill({
      json: route.request().method() === "GET" ? settings : ack,
    }),
  );
  await page.route("**/api/admin/appeals?**", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: ack.request_id,
            user_id: mockMe.user_id,
            post_id: post(10).id,
            message: "合成申立て <script>alert(1)</script>",
            status: "open",
            created_at: "2026-10-06T10:00:00Z",
          },
        ],
        next_cursor: null,
      },
    }),
  );
  await page.goto(`/__operations-harness?view=${view}`);
}

for (const width of [390, 1280])
  test(`admin confirms reason/version; no credentials and responsive ${width}`, async ({
    page,
  }, info) => {
    const writes: { body: unknown; csrf: string | undefined }[] = [],
      errors: string[] = [],
      external: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (!r.url().startsWith("http://127.0.0.1:3100/")) external.push(r.url());
    });
    await page.setViewportSize({ width, height: 844 });
    await mount(page);
    await page.route("**/api/admin/posts/*/hide", async (route) => {
      writes.push({
        body: route.request().postDataJSON(),
        csrf: route.request().headers()["x-csrf-token"],
      });
      await route.fulfill({ json: ack });
    });
    await page
      .getByRole("button", { name: "本人確認・投稿を読み込む" })
      .click();
    const item = page.getByRole("article", {
      name: `投稿 ${post(10).id}`,
      exact: true,
    });
    await expect(page.getByRole("article")).toHaveCount(2);
    await expect(
      page
        .getByRole("article", { name: `投稿 ${post(20).id}`, exact: true })
        .getByRole("link"),
    ).toHaveCount(0);
    await item.getByText("投稿への操作", { exact: true }).click();
    await item
      .getByRole("textbox", { name: "操作理由" })
      .fill("通報内容を確認するため");
    const submit = item.getByRole("button", {
      name: "非表示にする",
      exact: true,
    });
    await expect(submit).toBeDisabled();
    await item
      .getByRole("checkbox", { name: "対象と影響を確認しました", exact: true })
      .check();
    await expect(submit).toBeEnabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`operations-${width}.png`),
      fullPage: false,
    });
    await submit.click();
    await expect(page.getByText("受付ID：", { exact: false })).toBeVisible();
    expect(writes).toEqual([
      {
        body: { expected_version: 4, reason: "通報内容を確認するため" },
        csrf: "synthetic-csrf-value-abcdefghijklmnopqrstuvwxyz",
      },
    ]);
    await expect(page.locator("body")).not.toContainText("synthetic-csrf");
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

test("moderator has no admin controls, unsafe original links or BLOCK restore", async ({
  page,
}) => {
  await mount(page, "manage", "moderator");
  await page.getByRole("button", { name: "本人確認・投稿を読み込む" }).click();
  await expect(
    page.getByRole("button", { name: "停止・AI設定", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("この利用者をBAN", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("この投稿の保存原本を個別取得", { exact: true }),
  ).toHaveCount(1);
  const blocked = page.getByRole("article", {
    name: `投稿 ${post(20).id}`,
    exact: true,
  });
  await blocked.getByText("投稿への操作", { exact: true }).click();
  await expect(
    blocked.getByRole("option", { name: "確認済みの判定へ復帰" }),
  ).toHaveCount(0);
});
test("ordinary user cannot expose returned administrative rows", async ({
  page,
}) => {
  await mount(page, "manage", "user");
  await page.getByRole("button", { name: "本人確認・投稿を読み込む" }).click();
  await expect(page.getByRole("alert")).toContainText("運営権限がありません");
  await expect(page.getByRole("article")).toHaveCount(0);
});
test("ambiguous mutation is not retried and hides stale forms", async ({
  page,
}) => {
  await mount(page);
  let writes = 0;
  await page.route("**/api/admin/posts/*/hide", (route) => {
    writes++;
    return route.abort();
  });
  await page.getByRole("button", { name: "本人確認・投稿を読み込む" }).click();
  const item = page.getByRole("article").first();
  await item.getByText("投稿への操作", { exact: true }).click();
  await item.getByRole("textbox", { name: "操作理由" }).fill("合成試験");
  await item
    .getByRole("checkbox", { name: "対象と影響を確認しました", exact: true })
    .check();
  await item.getByRole("button", { name: "非表示にする", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("自動再送はしません");
  await expect(page.getByRole("article")).toHaveCount(0);
  expect(writes).toBe(1);
});
test("BAN user appeal needs only fresh me and explicit text confirmation", async ({
  page,
}) => {
  await mount(page, "appeal", "user");
  const writes: unknown[] = [];
  let themeReads = 0;
  await page.route("**/api/themes", (route) => {
    themeReads++;
    return route.abort();
  });
  await page.route("**/api/appeals", (route) => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: ack });
  });
  await page.getByRole("button", { name: "本人確認・申立てを準備" }).click();
  await page
    .getByLabel("申立ての内容", { exact: false })
    .fill("確認をお願いします");
  await expect(
    page.getByRole("button", { name: "異議申立てを送信する" }),
  ).toBeDisabled();
  await page.getByLabel("内容を確認し、運営へ送信します").check();
  await page.getByRole("button", { name: "異議申立てを送信する" }).click();
  await expect(
    page.getByText("申立てを受け付けました", { exact: false }),
  ).toBeVisible();
  expect(writes).toEqual([{ message: "確認をお願いします" }]);
  expect(themeReads).toBe(0);
});
test("report and BAN owner deletion are explicit single requests", async ({
  page,
}) => {
  for (const mode of ["report", "delete-own"] as const) {
    await mount(page, mode, "user");
    let writes = 0;
    await page.route(
      mode === "report" ? "**/api/posts/*/reports" : "**/api/posts/*",
      (route) => {
        writes++;
        expect(route.request().method()).toBe(
          mode === "report" ? "POST" : "DELETE",
        );
        return route.fulfill({ json: ack });
      },
    );
    await page
      .getByText(mode === "report" ? "この投稿を通報" : "自分の投稿を削除", {
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "本人確認・操作を準備" }).click();
    await page.getByLabel("対象と影響を確認しました", { exact: true }).check();
    await page
      .getByRole("button", {
        name: mode === "report" ? "通報を送信する" : "本人の投稿を削除する",
      })
      .click();
    await expect(
      page.getByText(
        mode === "report"
          ? "通報を受け付けました。運営が確認します。"
          : "削除を受け付けました。新規配信を停止します。原本の物理削除完了とは別です。",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "本人確認・操作を準備" }),
    ).toBeDisabled();
    expect(writes).toBe(1);
  }
});
test("settings preserves generation and cannot submit approval", async ({
  page,
}) => {
  await mount(page);
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/admin/settings", (route) => {
    if (route.request().method() === "PUT")
      writes.push(route.request().postDataJSON());
    return route.fulfill({
      json: route.request().method() === "GET" ? settings : ack,
    });
  });
  await page.getByRole("button", { name: "本人確認・投稿を読み込む" }).click();
  await page.getByRole("button", { name: "停止・AI設定", exact: true }).click();
  await expect(
    page.getByLabel("閾値の承認状態", { exact: false }),
  ).toBeDisabled();
  await page.getByLabel("FLAG（0〜1）", { exact: true }).fill("0.5");
  await page
    .getByLabel("停止・受付・閾値の変更内容と影響を確認しました")
    .check();
  await page.getByRole("button", { name: "設定を保存する" }).click();
  await expect(page.getByText("受付ID：", { exact: false })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.version).toBe(2);
  expect(writes[0]).not.toHaveProperty("thresholds_approved");
});
test("theme form sends fixed JST ISO and literal text only", async ({
  page,
}) => {
  await mount(page);
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/admin/themes", (route) => {
    if (route.request().method() === "POST")
      writes.push(route.request().postDataJSON());
    return route.fulfill({
      json: route.request().method() === "GET" ? { items: [] } : ack,
    });
  });
  await page.getByRole("button", { name: "本人確認・投稿を読み込む" }).click();
  await page.getByRole("button", { name: "お題の管理", exact: true }).click();
  await page.getByText("新しいお題を作成", { exact: true }).click();
  await page.getByLabel("お題の名称", { exact: true }).fill("新しい合成お題");
  await page.getByLabel("アイコン（文字・絵文字）", { exact: true }).fill("📷");
  await page
    .getByLabel("開始（日本時間）", { exact: true })
    .fill("2026-10-10T10:00");
  await page
    .getByLabel("終了（日本時間）", { exact: true })
    .fill("2026-10-11T18:00");
  await page.getByLabel("対象と影響を確認しました", { exact: true }).check();
  await page.getByRole("button", { name: "お題を保存する" }).click();
  await expect(page.getByText("受付ID：", { exact: false })).toBeVisible();
  expect(writes[0]).toMatchObject({
    title: "新しい合成お題",
    icon: "📷",
    status: "draft",
    starts_at: "2026-10-10T01:00:00.000Z",
    ends_at: "2026-10-11T09:00:00.000Z",
  });
});
test("appeal resolution records outcome, never unbans automatically", async ({
  page,
}) => {
  await mount(page);
  const calls: string[] = [];
  await page.route("**/api/admin/appeals/*", (route) => {
    calls.push(route.request().url());
    expect(route.request().postDataJSON()).toEqual({
      status: "resolved",
      reason: "内容を確認しました",
    });
    return route.fulfill({ json: ack });
  });
  await page.getByRole("button", { name: "本人確認・投稿を読み込む" }).click();
  await page
    .getByRole("button", { name: "異議申立て対応", exact: true })
    .click();
  await expect(
    page.getByText("合成申立て <script>alert(1)</script>", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("操作理由").fill("内容を確認しました");
  await page.getByLabel("対象と影響を確認しました", { exact: true }).check();
  await page.getByRole("button", { name: "対応結果を記録" }).click();
  await expect(page.getByText("受付ID：", { exact: false })).toBeVisible();
  expect(calls).toHaveLength(1);
});
test("auth and hidden-page events discard private rows and forms", async ({
  page,
}) => {
  for (const event of [
    "TOKEN_REFRESHED",
    "SIGNED_IN",
    "SIGNED_OUT",
    "visibilitychange",
    "koko-upload-stop",
  ]) {
    await mount(page);
    await page
      .getByRole("button", { name: "本人確認・投稿を読み込む" })
      .click();
    await expect(page.getByRole("article")).toHaveCount(2);
    await page.evaluate((event) => {
      if (event === "visibilitychange") {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "hidden",
        });
        document.dispatchEvent(new Event(event));
      } else if (event === "koko-upload-stop")
        window.dispatchEvent(new Event(event));
      else window.operationsAuthEvent(event);
    }, event);
    await expect(page.getByRole("article")).toHaveCount(0);
    expect(
      await page.evaluate(() => [localStorage.length, sessionStorage.length]),
    ).toEqual([0, 0]);
  }
});
