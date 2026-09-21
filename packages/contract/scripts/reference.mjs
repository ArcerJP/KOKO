import { readFile, writeFile } from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";
import process from "node:process";
import prettier from "prettier";
import { errors } from "../dist/errors.js";

const output = new URL("../ERRORS.md", import.meta.url);
const lines = Object.entries(errors).map(
  ([code, value]) =>
    `| ${code} | ${value.status || "端末内のみ"} | ${value.message} | ${value.retryable ? "可（待機と回数上限あり）" : "自動再送しない"} |`,
);
const source = [
  "# エラーコードと画面文言（K-05）",
  "",
  "この表は[src/errors.ts](src/errors.ts)から生成します。直接編集せず、`npm run contract:generate`を実行してください。",
  "",
  "APIはcodeとrequest_idを返し、FEはこの文言を表示します。再試行可能でも投稿キューは最大3回、AI処理は最大2回で停止します。PROCESSING_HELDは再投稿を促さず状態確認・運営対応へ案内します。",
  "",
  "| コード | HTTP | 画面表示 | 再試行 |",
  "| --- | --- | --- | --- |",
  ...lines,
  "",
].join("\n");
const formatted = await prettier.format(source, {
  ...(await prettier.resolveConfig(fileURLToPath(output))),
  parser: "markdown",
});
if (process.argv.includes("--check")) {
  if ((await readFile(output, "utf8")) !== formatted)
    throw new Error(
      "エラー表が正本と不一致です。npm run contract:generate を実行してください。",
    );
} else {
  await writeFile(output, formatted);
}
