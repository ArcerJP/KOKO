import { test, expect } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { ProfileForm } from "../src/app/account/profile-form";
import type { ProfileState } from "../src/api/account-profile";

// 実認証を偽装するrouteは追加しない。純粋表示のHTML/CSSだけをChromiumで確認。
for (const width of [390, 1280]) {
  test(`表示名フォームの表示・ラベル・改行 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const state: ProfileState = {
      phase: "ready",
      displayName: "試験用表示名".repeat(8),
      draft: "変更する名前",
      blocked: false,
      message: null,
      error: false,
    };
    const form = renderToStaticMarkup(
      createElement(ProfileForm, {
        state,
        onLoad() {},
        onSave() {},
        onEdit() {},
      }),
    );
    const css = await readFile(
      new URL("../src/app/globals.css", import.meta.url),
      "utf8",
    );
    const tokens = await readFile(
      new URL("../src/styles/tokens.css", import.meta.url),
      "utf8",
    );
    await page.setContent(
      `<html lang="ja"><head><meta charset="utf-8"><style>${tokens}${css}</style></head><body><main class="shell auth-shell">${form}</main></body></html>`,
    );
    await expect(
      page.getByRole("heading", { name: "表示名", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("新しい表示名")).toHaveValue("変更する名前");
    await expect(
      page.getByRole("button", { name: "表示名を保存" }),
    ).toBeEnabled();
    await page.getByLabel("新しい表示名").focus();
    await expect(page.getByLabel("新しい表示名")).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`profile-${width}.png`),
      fullPage: true,
    });
  });
}
