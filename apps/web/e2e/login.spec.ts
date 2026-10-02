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
