import {
  effectIdSchema,
  OWNED_FIXTURE_ORIGIN,
  setupLogicalStepSchema,
} from "@village/contracts";
import { contentSecurityPolicy, renderOwnedFixtureAccount } from "./account.js";
import {
  FixtureServiceError,
  type FixtureActionRequest,
  type FixtureCallBinding,
  type FixtureStepBinding,
  type LocalOwnedFixtureService,
} from "./local-service.js";

export interface OwnedFixtureRequestHandlerOptions {
  readonly service: LocalOwnedFixtureService;
  /** Captured by the dedicated Electron session's protocol registration. */
  readonly binding: FixtureCallBinding;
}

type JsonRecord = Record<string, unknown>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function errorResponse(error: unknown): Response {
  if (!(error instanceof FixtureServiceError)) {
    return json({ code: "INVALID_FIXTURE_REQUEST" }, 400);
  }
  if (error.code === "FIXTURE_BINDING_DENIED") {
    return json({ code: error.code }, 403);
  }
  if (
    error.code === "EFFECT_BINDING_CONFLICT" ||
    error.code === "AMBIGUOUS_EFFECT_REQUIRES_OWNER"
  ) {
    return json({ code: error.code }, 409);
  }
  if (error.code === "RESPONSE_LOST_AFTER_EFFECT") {
    return json({ code: error.code }, 503);
  }
  return json({ code: error.code }, 400);
}

function exactKeys(
  candidate: JsonRecord,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(candidate).sort();
  return (
    keys.length === expected.length &&
    [...expected].sort().every((key, index) => key === keys[index])
  );
}

async function strictJson(request: Request): Promise<JsonRecord> {
  if (request.headers.get("content-type") !== "application/json") {
    throw new Error("INVALID_FIXTURE_REQUEST");
  }
  const text = await request.text();
  if (text.length > 512) throw new Error("INVALID_FIXTURE_REQUEST");
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("INVALID_FIXTURE_REQUEST");
  }
  return parsed as JsonRecord;
}

/**
 * Produces a main-process-callable protocol callback. It opens no socket and
 * captures one principal/Job/dedicated-session binding for its whole lifetime.
 */
export function createOwnedFixtureRequestHandler(
  options: OwnedFixtureRequestHandlerOptions,
): (request: Request) => Promise<Response> {
  const { service, binding } = options;
  return async (request: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return json({ code: "FIXTURE_ORIGIN_DENIED" }, 403);
    }
    if (
      url.origin !== OWNED_FIXTURE_ORIGIN ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return json({ code: "FIXTURE_ORIGIN_DENIED" }, 403);
    }

    try {
      service.assertBoundSession(binding);
      if (
        request.method === "GET" &&
        (url.pathname === "/" || url.pathname === "/setup")
      ) {
        const effectId = url.searchParams.get("effectId");
        const logicalStep = url.searchParams.get("logicalStep");
        if (
          !effectId ||
          !logicalStep ||
          [...url.searchParams.keys()].some(
            (key) => key !== "effectId" && key !== "logicalStep",
          )
        ) {
          return json({ code: "INVALID_FIXTURE_REQUEST" }, 400);
        }
        return new Response(
          renderOwnedFixtureAccount(
            service.accountView({ ...binding, effectId }),
          ),
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "content-security-policy": contentSecurityPolicy,
            },
          },
        );
      }

      if (request.method === "POST" && url.pathname === "/api/owner-state") {
        const body = await strictJson(request);
        if (
          !exactKeys(body, [
            "logicalStep",
            "effectId",
            "displayName",
            "role",
            "preferredFocus",
          ]) ||
          typeof body.displayName !== "string" ||
          typeof body.role !== "string" ||
          typeof body.preferredFocus !== "string"
        ) {
          return json({ code: "INVALID_FIXTURE_REQUEST" }, 400);
        }
        const stepBinding: FixtureStepBinding = {
          ...binding,
          logicalStep: setupLogicalStepSchema.parse(body.logicalStep),
          effectId: effectIdSchema.parse(body.effectId),
        };
        return json(
          await service.applyOwnerState(stepBinding, {
            displayName: body.displayName,
            role: body.role,
            preferredFocus: body.preferredFocus,
          }),
        );
      }

      if (request.method === "GET" && url.pathname === "/api/observe") {
        const logicalStep = url.searchParams.get("logicalStep");
        const effectId = url.searchParams.get("effectId");
        if (!logicalStep || !effectId || url.searchParams.size !== 2) {
          return json({ code: "INVALID_FIXTURE_REQUEST" }, 400);
        }
        return json(
          await service.observe({ ...binding, logicalStep, effectId } as never),
        );
      }

      if (request.method === "GET" && url.pathname === "/api/attempts") {
        const effectId = url.searchParams.get("effectId");
        if (!effectId || url.searchParams.size !== 1) {
          return json({ code: "INVALID_FIXTURE_REQUEST" }, 400);
        }
        return json(await service.attempts({ ...binding, effectId }));
      }

      if (request.method === "POST" && url.pathname === "/api/action") {
        const body = await strictJson(request);
        if (!exactKeys(body, ["logicalStep", "effectId", "capability"])) {
          return json({ code: "INVALID_FIXTURE_REQUEST" }, 400);
        }
        return json(
          await service.execute({
            ...binding,
            ...body,
          } as FixtureActionRequest),
        );
      }

      if (request.method === "POST" && url.pathname === "/api/reset") {
        const body = await strictJson(request);
        if (
          !exactKeys(body, ["effectId"]) ||
          typeof body.effectId !== "string"
        ) {
          return json({ code: "INVALID_FIXTURE_REQUEST" }, 400);
        }
        return json(
          await service.reset({ ...binding, effectId: body.effectId }),
        );
      }
      return json({ code: "FIXTURE_ROUTE_NOT_FOUND" }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
