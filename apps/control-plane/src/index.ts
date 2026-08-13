import type { Environment } from "./env.js";
export { BrowserSessionCoordinator } from "./worker/browser-control/session-coordinator.js";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
} as const;

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json(
        {
          service: "village-control-plane",
          deployment: environment.VILLAGE_DEPLOYMENT_NAME ?? "self-hosted",
          status: "ok",
        },
        { headers: jsonHeaders },
      );
    }
    return Response.json(
      { error: "not_found" },
      { status: 404, headers: jsonHeaders },
    );
  },
};
