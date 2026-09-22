import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url));

test("初期表示・写真の無変換プレビュー・クリア・同じファイルの再選択", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const notices = await page.request.get("/third-party-notices.txt");
  expect(notices.ok()).toBe(true);
  expect(await notices.text()).toContain("Mozilla Public License Version 2.0");
  await expect(
    page.getByRole("heading", { name: "撮影・トリム検証", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("この画面から投稿・外部送信は行いません。"),
  ).toBeVisible();
  const input = page.getByLabel("写真を撮る／選ぶ");
  await expect(input).toHaveAttribute("accept", "image/*");
  await expect(input).toHaveAttribute("capture", "environment");
  await input.setInputFiles(fixture("photo.png"));
  await expect(page.getByRole("img")).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByRole("img")
        .evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBe(160);
  expect(await page.getByRole("img").getAttribute("src")).toMatch(/^blob:/);
  await page.screenshot({
    path: info.outputPath("desktop-photo.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "画面のデータをクリア" }).click();
  await expect(page.getByRole("img")).toHaveCount(0);
  await input.setInputFiles(fixture("photo.png"));
  await expect(page.getByRole("img")).toBeVisible();
  expect(errors).toEqual([]);
});

for (const filename of ["motion-vp8.webm", "motion-vp9.webm"]) {
  test(`${filename}: Worker→3候補→実再生→測定JSON、外部送信なし`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    const forbidden: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (
        !request.url().startsWith("blob:") &&
        (!request.url().startsWith("http://127.0.0.1:3100/") ||
          request.method() !== "GET")
      )
        forbidden.push(`${request.method()} ${request.url()}`);
    });
    await page.goto("/");
    const input = page.getByLabel("動画を撮る／選ぶ");
    await expect(input).toHaveAttribute("capture", "environment");
    await input.setInputFiles(fixture(filename));
    await page.getByRole("button", { name: "3つの長さを比較する" }).click();
    await expect(
      page.getByText("再エンコードなし・トリム候補", { exact: true }),
    ).toHaveCount(3);
    const videos = page.locator(".results video");
    await expect(videos).toHaveCount(3);
    for (const video of await videos.all()) {
      await expect
        .poll(() =>
          video.evaluate((element) => (element as HTMLVideoElement).readyState),
        )
        .toBeGreaterThanOrEqual(2);
      const duration = await video.evaluate(
        (element) => (element as HTMLVideoElement).duration,
      );
      expect(duration).toBeGreaterThan(0);
      expect(duration).toBeLessThanOrEqual(4);
      await video.evaluate(async (element) => {
        const media = element as HTMLVideoElement;
        media.muted = true;
        await media.play();
      });
      await expect
        .poll(() =>
          video.evaluate(
            (element) => (element as HTMLVideoElement).currentTime,
          ),
        )
        .toBeGreaterThan(0.15);
      await video.evaluate((element) => (element as HTMLVideoElement).pause());
    }
    await page.getByLabel("映像の欠け・停止がない").check();
    const downloadEvent = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "測定結果だけを保存（JSON）" })
      .click();
    const download = await downloadEvent;
    const reportText = await readFile((await download.path())!, "utf8");
    const report = JSON.parse(reportText);
    expect(
      report.attempts.map(
        (item: { targetSeconds: number }) => item.targetSeconds,
      ),
    ).toEqual([3.8, 3.5, 3]);
    expect(report.manualChecks).toEqual({
      sound: false,
      orientation: false,
      playback: true,
    });
    expect(reportText).not.toContain(filename);
    expect(reportText).not.toContain("base64");
    expect(forbidden).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: info.outputPath("desktop-results.png"),
      fullPage: true,
    });
  });
}

test("モバイル幅でも横にはみ出さず、未対応動画は原本fallbackを表示する", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByLabel("動画を撮る／選ぶ").setInputFiles({
    name: "broken.webm",
    mimeType: "video/webm",
    buffer: Buffer.from("not a video"),
  });
  await page
    .getByRole("button", { name: "3.8秒（標準）", exact: true })
    .click();
  await expect(page.locator(".results .warning")).toContainText("原本を保持");
  await expect(
    page.getByText("再エンコードなし・トリム候補", { exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("mobile-fallback.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "画面のデータをクリア" }).click();
  await page.getByLabel("写真を撮る／選ぶ").setInputFiles(fixture("photo.png"));
  await expect(page.getByRole("img")).toBeVisible();
  await page.screenshot({
    path: info.outputPath("mobile-photo.png"),
    fullPage: true,
  });
});

test("空ファイルを拒否して画面を継続利用できる", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("動画を撮る／選ぶ").setInputFiles({
    name: "empty.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.alloc(0),
  });
  await expect(page.getByRole("status")).toContainText("空のファイルです");
  await expect(
    page.getByRole("button", { name: "3.8秒（標準）", exact: true }),
  ).toHaveCount(0);
});
