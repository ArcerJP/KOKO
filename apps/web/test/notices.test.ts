import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const normalizedLicense = (text: string) =>
  text
    .replaceAll("\r\n", "\n")
    .replace(/[\t ]+$/gm, "")
    .trim();

it("主要な配布ライブラリの原文ライセンスと固定版のソース入手先を保持する", async () => {
  const notice = await readFile(
    new URL("../public/third-party-notices.txt", import.meta.url),
    "utf8",
  );
  for (const path of [
    "mediabunny/LICENSE",
    "react/LICENSE",
    "react-dom/LICENSE",
    "next/license.md",
    "hls.js/LICENSE",
  ]) {
    const license = await readFile(
      new URL(`../../../node_modules/${path}`, import.meta.url),
      "utf8",
    );
    expect(normalizedLicense(notice)).toContain(normalizedLicense(license));
  }
  expect(notice).toContain(
    "https://registry.npmjs.org/mediabunny/-/mediabunny-1.58.1.tgz",
  );
  expect(notice).toContain(
    "https://registry.npmjs.org/hls.js/-/hls.js-1.7.3.tgz",
  );
  expect(notice).toContain("END OF TERMS AND CONDITIONS");
});
