import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir, access } from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !["dist", "node_modules"].includes(entry.name))
      files.push(...(await markdownFiles(path)));
    else if (entry.isFile() && path.endsWith(".md")) files.push(path);
  }
  return files;
}

test("正式文書・契約の相対ファイルリンクにリンク切れがない", async () => {
  const files = [join(root, "README.md")];
  for (const area of ["docs", "apps", "packages/contract"])
    files.push(...(await markdownFiles(join(root, area))));
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const link = match[1];
      if (/^[a-z]+:/i.test(link) || link.startsWith("#")) continue;
      const target = resolve(
        dirname(file),
        decodeURIComponent(link.split("#")[0]),
      );
      await assert.doesNotReject(access(target), `${file}: ${link}`);
    }
  }
});

test("SQLもUTF-8/LF、末尾改行、末尾空白なしを維持する", async () => {
  const sql = await readFile(
    join(
      root,
      "apps/api/supabase/migrations/20260921000000_initial_contract.sql",
    ),
    "utf8",
  );
  assert.equal(sql.includes("\r"), false);
  assert.ok(sql.endsWith("\n"));
  assert.equal(/[\t ]+$/m.test(sql), false);
});
