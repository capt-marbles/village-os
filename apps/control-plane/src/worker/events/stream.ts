import { browserSessionIdSchema, principalIdSchema } from "@village/contracts";
import type { Environment } from "../../env.js";

export async function openBrowserEventStream(
  environment: Environment,
  principalCandidate: unknown,
  sessionCandidate: unknown,
  cursor: number,
  request: Request,
): Promise<Response> {
  const principal = principalIdSchema.safeParse(principalCandidate);
  const session = browserSessionIdSchema.safeParse(sessionCandidate);
  if (!principal.success || !session.success) {
    return Response.json(
      { ok: false, code: "INVALID_STREAM_IDENTITY" },
      { status: 400 },
    );
  }
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return Response.json(
      { ok: false, code: "WEBSOCKET_UPGRADE_REQUIRED" },
      { status: 426 },
    );
  }
  return environment.BROWSER_SESSION_COORDINATOR.getByName(session.data).fetch(
    new Request(`https://coordinator.internal/stream?cursor=${cursor}`, {
      headers: {
        upgrade: "websocket",
        "x-village-principal": principal.data,
      },
    }),
  );
}
