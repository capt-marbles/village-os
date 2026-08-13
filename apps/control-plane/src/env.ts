import type { BrowserSessionCoordinator } from "./worker/browser-control/session-coordinator.js";

export interface Environment {
  BROWSER_SESSION_COORDINATOR: DurableObjectNamespace<BrowserSessionCoordinator>;
  VILLAGE_DB: D1Database;
  VILLAGE_DEPLOYMENT_NAME: string;
  VILLAGE_AUTH_MODE: "development-header" | "cloudflare-access";
  VILLAGE_ALLOWED_ORIGINS: string;
}
