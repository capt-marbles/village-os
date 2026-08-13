import type { BrowserSessionCoordinator } from "./worker/browser-control/session-coordinator.js";

export interface Environment {
  BROWSER_SESSION_COORDINATOR: DurableObjectNamespace<BrowserSessionCoordinator>;
  VILLAGE_DB: D1Database;
  VILLAGE_DEPLOYMENT_NAME: string;
  VILLAGE_AUTH_MODE: "development-header" | "cloudflare-access";
  VILLAGE_ENVIRONMENT: "development" | "production" | "test";
  VILLAGE_ALLOWED_ORIGINS: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  TEST_MIGRATIONS?: Array<{ name: string; queries: string[] }>;
}
