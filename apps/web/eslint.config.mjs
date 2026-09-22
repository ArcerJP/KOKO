import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTypescript,
  {
    ignores: [
      ".next/**",
      "next-env.d.ts",
      "test-results/**",
      "playwright-report/**",
    ],
  },
];

export default config;
