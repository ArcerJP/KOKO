import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

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
  ]) {
    const license = await readFile(
      new URL(`../../../node_modules/${path}`, import.meta.url),
      "utf8",
    );
    expect(notice.replaceAll("\r\n", "\n")).toContain(
      license.replaceAll("\r\n", "\n").trim(),
    );
  }
  expect(notice).toContain(
    "https://registry.npmjs.org/mediabunny/-/mediabunny-1.58.1.tgz",
  );
});
