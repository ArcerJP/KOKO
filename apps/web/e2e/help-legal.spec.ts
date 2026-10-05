import { expect, test } from "@playwright/test";
test("legal routes remain pending and contain no adoption form", async ({
  page,
}) => {
  for (const path of ["/terms", "/privacy"]) {
    await page.goto(path);
    await expect(page.getByRole("status")).toContainText("本文は公開準備中");
    await expect(page.locator("form")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "お問い合わせ・ヘルプ" }),
    ).toHaveAttribute("href", "/help");
  }
});
for (const width of [390, 1280])
  test(`help navigation and contact remain readable ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/help");
    await expect(
      page.getByRole("heading", { name: "ヘルプ・お問い合わせ" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "arcer.jp@gmail.com" }),
    ).toHaveAttribute("href", "mailto:arcer.jp@gmail.com");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: `test-results/help-${width}.png` });
    await page.getByRole("link", { name: "利用規約", exact: true }).click();
    await expect(page).toHaveURL(/\/terms$/);
  });
