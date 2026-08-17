import type { BrowserSessionCoordinator } from "./worker/browser-control/session-coordinator.js";
import type { SiteSessionMailbox } from "./worker/site-session-continuity/mailbox.js";

export interface Environment {
  BROWSER_SESSION_COORDINATOR: DurableObjectNamespace<BrowserSessionCoordinator>;
  SITE_SESSION_MAILBOX: DurableObjectNamespace<SiteSessionMailbox>;
  VILLAGE_DB: D1Database;
  VILLAGE_DEPLOYMENT_NAME: string;
  VILLAGE_AUTH_MODE: "development-header" | "cloudflare-access";
  VILLAGE_ENVIRONMENT: "development" | "production" | "test";
  VILLAGE_EXPERIMENTAL_CONTINUITY: "disabled" | "enabled";
  VILLAGE_ALLOWED_ORIGINS: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  TEST_MIGRATIONS?: Array<{ name: string; queries: string[] }>;
}
