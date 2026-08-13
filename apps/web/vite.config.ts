import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "localhost",
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
        headers: {
          cookie: "village_csrf=village-local-e2e-csrf-token-00000001",
          "x-village-development-principal": "prn_01J00000000000000000000000",
        },
      },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
