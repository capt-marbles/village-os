import type { Environment } from "./env.js";
import { routeRequest } from "./server/routes.js";
export { BrowserSessionCoordinator } from "./worker/browser-control/session-coordinator.js";

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    return routeRequest(request, environment);
  },
};
