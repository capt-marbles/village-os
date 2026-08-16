import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const controlPlane =
  process.env.VILLAGE_DEV_CONTROL_PLANE_URL ?? "http://127.0.0.1:8787";
const principalId =
  process.env.VILLAGE_DEV_PRINCIPAL_ID ?? "prn_01J00000000000000000000000";
const csrf =
  process.env.VILLAGE_DEV_CSRF ?? "village-local-e2e-csrf-token-00000001";

const controlPlaneUrl = new URL(controlPlane);
if (
  controlPlaneUrl.protocol !== "https:" &&
  !(
    controlPlaneUrl.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(controlPlaneUrl.hostname)
  )
) {
  throw new Error("VILLAGE_DEV_CONTROL_PLANE_URL_UNSAFE");
}
if (!/^prn_[0-9A-HJKMNP-TV-Z]{26}$/.test(principalId)) {
  throw new Error("VILLAGE_DEV_PRINCIPAL_ID_INVALID");
}
if (csrf.length < 32) throw new Error("VILLAGE_DEV_CSRF_INVALID");

export default defineConfig({
  plugins: [react()],
  server: {
    host: "localhost",
    port: 5174,
    strictPort: true,
    headers: {
      "set-cookie": `village_csrf=${csrf}; Path=/; SameSite=Strict`,
    },
    proxy: {
      "/api": {
        target: controlPlaneUrl.origin,
        changeOrigin: true,
        headers: {
          cookie: `village_csrf=${csrf}`,
          "x-village-development-principal": principalId,
        },
      },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
