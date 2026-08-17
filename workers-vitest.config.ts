import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const d1Migrations = await readD1Migrations("./apps/control-plane/migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./apps/control-plane/wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: d1Migrations,
          VILLAGE_EXPERIMENTAL_CONTINUITY: "enabled",
        },
      },
    }),
  ],
  resolve: {
    alias: {
      "@village/contracts": fileURLToPath(
        new URL("./packages/contracts/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["apps/**/*.worker.test.ts"],
  },
});
