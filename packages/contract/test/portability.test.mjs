import assert from "node:assert/strict";
import { test } from "node:test";
import { ESLint } from "eslint";

test("共有契約のLintはUI・実行環境・クラウドSDK依存を拒否する", async () => {
  const eslint = new ESLint();
  for (const dependency of [
    "node:fs",
    "fs",
    "next/headers",
    "react",
    "react-native",
    "@supabase/supabase-js",
    "@cloudflare/workers-types",
    "@google-cloud/storage",
  ]) {
    const [result] = await eslint.lintText(`export * from "${dependency}";`, {
      filePath: "packages/contract/src/portability-probe.ts",
    });
    assert.ok(
      result.messages.some(
        (message) => message.ruleId === "no-restricted-imports",
      ),
      dependency,
    );
  }
  const [allowed] = await eslint.lintText('export * from "./policy.js";', {
    filePath: "packages/contract/src/portability-probe.ts",
  });
  assert.equal(allowed.errorCount, 0);
});
