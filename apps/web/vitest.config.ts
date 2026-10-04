import { defineConfig } from "vitest/config";
import { createRequire } from "node:module";

export default defineConfig({
  // Node tests only: Next handles this marker itself in production builds.
  resolve: {
    alias: [
      {
        find: /^server-only$/,
        replacement: createRequire(import.meta.url).resolve(
          "next/dist/compiled/server-only/empty.js",
        ),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true,
  },
});
