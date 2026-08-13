import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@village/contracts": fileURLToPath(
        new URL("./packages/contracts/src/index.ts", import.meta.url),
      ),
      "@village/ui": fileURLToPath(
        new URL("./packages/ui/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: [
      "apps/**/*.{test,spec}.{ts,tsx}",
      "packages/**/*.{test,spec}.{ts,tsx}",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "apps/**/*.worker.test.ts"],
    passWithNoTests: true,
  },
});
