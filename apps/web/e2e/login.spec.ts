import { expect, test } from "@playwright/test";

test("設定なしではGoogle認証を開始せず、撮影検証を維持する", async ({
  page,
}, info) => {
  await page.goto("/login");
  await expect(
    page.getByRole("heading", { name: "Googleでログイン" }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "認証先がまだ設定されていません",
  );
  await expect(
    page.getByRole("button", { name: "Googleでログイン" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("login-unconfigured.png"),
    fullPage: true,
  });

  await page
    .getByRole("link", { name: "端末内の撮影・トリム検証へ戻る" })
    .click();
  await expect(
    page.getByRole("heading", { name: "撮影・トリム検証" }),
  ).toBeVisible();
});

test("未認証の/accountはログインへ戻す", async ({ page }) => {
  await page.goto("/account");
  await expect(page).toHaveURL(/\/login$/);
});

test("API Cookie bridgeは既定無効でCookieを変更しない", async ({ request }) => {
  for (const method of ["POST", "DELETE"]) {
    const response = await request.fetch("/auth/api-session", { method });
    expect(response.status()).toBe(503);
    expect(await response.json()).toEqual({ code: "API_SESSION_UNAVAILABLE" });
    expect(response.headers()["set-cookie"]).toBeUndefined();
    expect(response.headers()["cache-control"]).toBe("private, no-store");
  }
});

test("本人情報中継は既定無効で、未対応methodも閉じる", async ({ request }) => {
  for (const [method, path] of [
    ["GET", "/api/me"],
    ["PATCH", "/api/me"],
    ["POST", "/api/consents"],
  ] as const) {
    const response = await request.fetch(path, { method });
    expect(response.status()).toBe(500);
    expect(await response.json()).toEqual({
      code: "INTERNAL_ERROR",
      request_id: expect.any(String),
    });
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    expect(response.headers()["set-cookie"]).toBeUndefined();
  }
  for (const path of ["/api/me", "/api/consents"]) {
    const response = await request.fetch(path, { method: "OPTIONS" });
    expect(response.status()).toBe(405);
    expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
  }
});
