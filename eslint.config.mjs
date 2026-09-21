import js from "@eslint/js";
import { builtinModules } from "node:module";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/generated/**",
      "work/**",
      "knowledge/raw/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/contract/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: builtinModules.filter((name) => !name.startsWith("node:")),
          patterns: [
            {
              group: [
                "node:*",
                "next",
                "next/**",
                "react",
                "react/**",
                "react-native",
                "react-native/**",
                "@supabase/**",
                "@cloudflare/**",
                "@google-cloud/**",
              ],
              message:
                "共有契約へ実行環境・UI・クラウドSDKを持ち込まず、各アプリの境界へ分離してください。",
            },
          ],
        },
      ],
    },
  },
);
