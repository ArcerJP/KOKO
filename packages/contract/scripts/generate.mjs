import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";
import prettier from "prettier";

const output = new URL("../src/generated/api.ts", import.meta.url);
const ast = await openapiTS(new URL("../openapi.yaml", import.meta.url));
const source =
  "// 自動生成。変更はopenapi.yamlへ反映し npm run contract:generate を実行。\n" +
  astToString(ast);
const config = await prettier.resolveConfig(fileURLToPath(output));
const formatted = await prettier.format(source, {
  ...config,
  parser: "typescript",
});
if (process.argv.includes("--check")) {
  if ((await readFile(output, "utf8")) !== formatted) {
    throw new Error(
      "生成型がOpenAPIと不一致です。npm run contract:generate を実行してください。",
    );
  }
} else {
  await writeFile(output, formatted);
}
