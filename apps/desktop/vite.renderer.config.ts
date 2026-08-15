import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    __VILLAGE_INTERNAL_BUILD__: JSON.stringify(
      process.env.VILLAGE_BUILD_CHANNEL !== "release",
    ),
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(
        new URL("./src/renderer/index.tsx", import.meta.url),
      ),
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      output: {
        codeSplitting: false,
      },
    },
  },
});
