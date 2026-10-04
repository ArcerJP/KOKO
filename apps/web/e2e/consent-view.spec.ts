import { test, expect } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { ConsentForm } from "../src/app/account/consent-form";
import { consentState, syntheticTerms } from "../test/consent-fixture";

// 純粋表示だけ。実認証・React hydration・同意送信の通し受入とは区別する。
for (const width of [390, 1280]) {
  test(`規約本文・checkbox・折返し ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const html = renderToStaticMarkup(
      createElement(ConsentForm, {
        state: consentState,
        onCheck() {},
        onAccept() {},
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
      `<html lang="ja"><head><meta charset="utf-8"><style>${tokens}${css}</style></head><body><main class="shell auth-shell">${html}</main></body></html>`,
    );
    await expect(
      page.getByText(syntheticTerms.terms[0]!, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(syntheticTerms.privacy[0]!, { exact: true }),
    ).toBeVisible();
    const checkbox = page.getByRole("checkbox", {
      name: "上記の利用規約とプライバシーポリシーを確認し、この版に同意します",
    });
    await expect(checkbox).not.toBeChecked();
    await checkbox.focus();
    await expect(checkbox).toBeFocused();
    await expect(
      page.getByRole("button", { name: "この版への同意を保存" }),
    ).toBeDisabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`consent-${width}.png`),
      fullPage: true,
    });
  });
}
