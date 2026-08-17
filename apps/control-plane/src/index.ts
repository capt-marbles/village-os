import type { Environment } from "./env.js";
import { routeRequest } from "./server/routes.js";
import { executeCloudRetentionBatch } from "./worker/retention/policy.js";
export { BrowserSessionCoordinator } from "./worker/browser-control/session-coordinator.js";
export { SiteSessionMailbox } from "./worker/site-session-continuity/mailbox.js";

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    return routeRequest(request, environment);
  },
  async scheduled(
    controller: ScheduledController,
    environment: Environment,
  ): Promise<void> {
    void controller;
    let hasMore = true;
    for (let batch = 0; batch < 20 && hasMore; batch += 1) {
      ({ hasMore } = await executeCloudRetentionBatch(
        environment,
        new Date().toISOString(),
      ));
    }
  },
};
