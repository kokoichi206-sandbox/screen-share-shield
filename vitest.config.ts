import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// WXT の `@/` エイリアス(プロジェクトルート)をテストでも解決させる。
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@": resolve(root) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
