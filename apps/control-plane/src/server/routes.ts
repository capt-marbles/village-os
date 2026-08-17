import {
  browserSessionIdSchema,
  deviceIdSchema,
  hostIdSchema,
  jobIdSchema,
  pairingIdSchema,
  principalIdSchema,
  setupObjectiveSchema,
  continuityGrantIdSchema,
} from "@village/contracts";
import { z } from "zod";
import type { Environment } from "../env.js";
import {
  dispatchAuthenticatedAutomationSync,
  dispatchAuthenticatedCommand,
  dispatchAuthenticatedResult,
  dispatchAuthenticatedSessionOpen,
  dispatchAuthenticatedWorkflowOperation,
  createOwnedBrowserSession,
} from "../worker/handlers/browser-control.js";
import {
  getObserverWorkflowProjection,
  projectSessionEvents,
  rebuildSessionProjection,
} from "../worker/browser-control/projection-outbox.js";
import { createJob, getJob, listJobs } from "../worker/handlers/jobs.js";
import { openBrowserEventStream } from "../worker/events/stream.js";
import {
  beginPairing,
  confirmPairing,
  consumePairing,
  getPairingStatus,
  rejectPairing,
  revokeDevice,
  rotateDeviceCredential,
} from "../worker/browser-control/pairing.js";
import { authenticateRequest } from "./auth.js";
import {
  acknowledgeContinuityRevision,
  createContinuityGrant,
  deleteContinuityGrant,
  fetchContinuityRevision,
  getContinuityGrant,
  getContinuityActivations,
  getContinuitySetup,
  enrollContinuityRecipientKey,
  publishContinuityRevision,
  revokeContinuityGrant,
  revokeContinuityRecipientKey,
} from "../worker/site-session-continuity/grants.js";
import {
  authorizeBrowserMutation,
  authorizeNonBrowserClient,
  corsHeaders,
  issueBrowserCsrfCookie,
} from "./security.js";
import {
  executePrincipalDeletion,
  exportPrincipalCloudData,
  planPrincipalDeletion,
} from "../worker/retention/deletion.js";
import { consumeAuthenticatedQuota } from "../worker/limits/quotas.js";

const deletionConfirmation = "DELETE_CLOUD_DATA";
const deletionIdAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function createDeletionRequestId(): string {
  const random = crypto.getRandomValues(new Uint8Array(26));
  return `del_${Array.from(random, (byte) => deletionIdAlphabet[byte & 31]).join("")}`;
}

function json(
  request: Request,
  environment: Environment,
  body: unknown,
  status = 200,
): Response {
  return Response.json(body, {
    status,
    headers: corsHeaders(request, environment),
  });
}

async function boundedJson(
  request: Request,
  maximumBytes = 8_192,
): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maximumBytes) throw new Error("BODY_TOO_LARGE");
  const text = await request.text();
  if (text.length > maximumBytes) throw new Error("BODY_TOO_LARGE");
  return JSON.parse(text);
}

async function boundedOptionalJson(request: Request): Promise<unknown | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > 8_192) throw new Error("BODY_TOO_LARGE");
  const text = await request.text();
  if (text.length > 8_192) throw new Error("BODY_TOO_LARGE");
  return text.length === 0 ? null : JSON.parse(text);
}

async function ownedSessionDevice(
  environment: Environment,
  principalId: string,
  browserSessionId: string,
): Promise<string | null> {
  const row = await environment.VILLAGE_DB.prepare(
    `SELECT device_id AS deviceId FROM browser_sessions
     WHERE principal_id = ? AND browser_session_id = ?`,
  )
    .bind(principalId, browserSessionId)
    .first<{ deviceId: string }>();
  return row?.deviceId ?? null;
}

function authenticatedMutationStatus(
  result: { ok: boolean; code?: string },
  success = 202,
) {
  return result.ok
    ? success
    : result.code === "AUTHENTICATED_QUOTA_EXCEEDED"
      ? 429
      : 409;
}

export async function routeRequest(
  request: Request,
  environment: Environment,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    const headers = corsHeaders(request, environment);
    return new Response(null, {
      status: headers.has("access-control-allow-origin") ? 204 : 403,
      headers,
    });
  }
  if (request.method === "GET" && url.pathname === "/health") {
    return json(request, environment, {
      service: "village-control-plane",
      deployment: environment.VILLAGE_DEPLOYMENT_NAME ?? "self-hosted",
      status: "ok",
    });
  }
  if (
    url.pathname.startsWith("/api/site-session-continuity/") &&
    environment.VILLAGE_EXPERIMENTAL_CONTINUITY !== "enabled"
  ) {
    return json(
      request,
      environment,
      { ok: false, code: "ROUTE_NOT_FOUND" },
      404,
    );
  }

  try {
    if (request.method === "GET" && url.pathname === "/api/identity") {
      const auth = await authenticateRequest(request, environment);
      if (!auth.ok)
        return json(
          request,
          environment,
          auth,
          auth.code === "ACCOUNT_DELETED" ? 410 : 401,
        );
      const headers = corsHeaders(request, environment);
      const csrfCookie = issueBrowserCsrfCookie(request);
      if (csrfCookie) headers.set("set-cookie", csrfCookie);
      return Response.json(auth.identity, { headers });
    }

    if (request.method === "GET" && url.pathname === "/api/owner/data-export") {
      const auth = await authenticateRequest(request, environment);
      if (!auth.ok) return json(request, environment, auth, 401);
      const body = await exportPrincipalCloudData(
        environment,
        auth.principalId,
        new Date().toISOString(),
      );
      const headers = corsHeaders(request, environment);
      headers.set("cache-control", "no-store");
      return Response.json(body, { headers });
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/owner/deletion-requests"
    ) {
      const csrf = authorizeBrowserMutation(request, environment);
      if (!csrf.ok) return json(request, environment, csrf, 403);
      const auth = await authenticateRequest(request, environment);
      if (!auth.ok) return json(request, environment, auth, 401);
      const body = z
        .strictObject({ confirmation: z.literal(deletionConfirmation) })
        .safeParse(await boundedJson(request));
      if (!body.success) {
        return json(
          request,
          environment,
          { ok: false, code: "INVALID_DELETION_CONFIRMATION" },
          400,
        );
      }
      const requestedAt = new Date().toISOString();
      const deletionRequestId = createDeletionRequestId();
      const planned = await planPrincipalDeletion(environment.VILLAGE_DB, {
        principalId: auth.principalId,
        deletionRequestId,
        requestedAt,
      });
      return json(
        request,
        environment,
        planned.ok ? { ...planned, deletionRequestId, requestedAt } : planned,
        planned.ok ? 201 : 409,
      );
    }

    const deletionConfirmationRoute = url.pathname.match(
      /^\/api\/owner\/deletion-requests\/(del_[A-Za-z0-9]{26})\/confirm$/,
    );
    if (request.method === "POST" && deletionConfirmationRoute) {
      const csrf = authorizeBrowserMutation(request, environment);
      if (!csrf.ok) return json(request, environment, csrf, 403);
      const auth = await authenticateRequest(
        request,
        environment,
        new Date().toISOString(),
        { allowDeleted: true },
      );
      if (!auth.ok) return json(request, environment, auth, 401);
      const body = z
        .strictObject({ confirmation: z.literal(deletionConfirmation) })
        .safeParse(await boundedJson(request));
      if (!body.success) {
        return json(
          request,
          environment,
          { ok: false, code: "INVALID_DELETION_CONFIRMATION" },
          400,
        );
      }
      const plan = await environment.VILLAGE_DB.prepare(
        `SELECT requested_at AS requestedAt FROM principal_deletion_plans
         WHERE principal_id = ? AND deletion_request_id = ?`,
      )
        .bind(auth.principalId, deletionConfirmationRoute[1])
        .first<{ requestedAt: string }>();
      if (!plan) {
        return json(
          request,
          environment,
          { ok: false, code: "DELETION_REQUEST_NOT_FOUND" },
          404,
        );
      }
      const result = await executePrincipalDeletion(
        environment,
        {
          principalId: auth.principalId,
          deletionRequestId: deletionConfirmationRoute[1],
          requestedAt: plan.requestedAt,
        },
        new Date().toISOString(),
      );
      return json(request, environment, result, result.ok ? 200 : 503);
    }

    if (
      request.method === "GET" &&
      url.pathname === "/api/site-session-continuity/setup"
    ) {
      const auth = await authenticateRequest(request, environment);
      if (!auth.ok) return json(request, environment, auth, 401);
      const result = await getContinuitySetup(
        environment,
        auth.principalId,
        new Date().toISOString(),
      );
      return json(request, environment, result, result.ok ? 200 : 400);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/site-session-continuity/recipient-keys"
    ) {
      const origin = authorizeNonBrowserClient(request, environment);
      if (!origin.ok) return json(request, environment, origin, 403);
      const result = await enrollContinuityRecipientKey(
        environment,
        await boundedJson(request),
        new Date().toISOString(),
      );
      return json(request, environment, result, result.ok ? 201 : 409);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/site-session-continuity/recipient-keys/revoke"
    ) {
      const csrf = authorizeBrowserMutation(request, environment);
      if (!csrf.ok) return json(request, environment, csrf, 403);
      const auth = await authenticateRequest(request, environment);
      if (!auth.ok) return json(request, environment, auth, 401);
      const result = await revokeContinuityRecipientKey(
        environment,
        auth.principalId,
        await boundedJson(request),
      );
      return json(request, environment, result, result.ok ? 200 : 409);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/site-session-continuity/activations"
    ) {
      const origin = authorizeNonBrowserClient(request, environment);
      if (!origin.ok) return json(request, environment, origin, 403);
      const result = await getContinuityActivations(
        environment,
        await boundedJson(request),
        new Date().toISOString(),
      );
      return json(request, environment, result, result.ok ? 200 : 409);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/site-session-continuity/grants"
    ) {
      const csrf = authorizeBrowserMutation(request, environment);
      if (!csrf.ok) return json(request, environment, csrf, 403);
      const auth = await authenticateRequest(request, environment);
      if (!auth.ok) return json(request, environment, auth, 401);
      const result = await createContinuityGrant(
        environment,
        auth.principalId,
        await boundedJson(request),
        new Date().toISOString(),
      );
      return json(request, environment, result, result.ok ? 201 : 409);
    }

    const continuityGrant = url.pathname.match(
      /^\/api\/site-session-continuity\/grants\/([^/]+)$/,
    );
    if (continuityGrant) {
      const grantId = continuityGrantIdSchema.safeParse(continuityGrant[1]);
      if (!grantId.success) {
        return json(
          request,
          environment,
          { ok: false, code: "CONTINUITY_GRANT_NOT_FOUND" },
          404,
        );
      }
      const auth = await authenticateRequest(request, environment);
      if (!auth.ok) return json(request, environment, auth, 401);
      if (request.method === "GET") {
        const result = await getContinuityGrant(
          environment,
          auth.principalId,
          grantId.data,
        );
        return json(request, environment, result, result.ok ? 200 : 404);
      }
      if (request.method === "DELETE") {
        const csrf = authorizeBrowserMutation(request, environment);
        if (!csrf.ok) return json(request, environment, csrf, 403);
        const result = await deleteContinuityGrant(
          environment,
          auth.principalId,
          grantId.data,
          new Date().toISOString(),
        );
        return json(request, environment, result, result.ok ? 200 : 404);
      }
    }

    const continuityRevocation = url.pathname.match(
      /^\/api\/site-session-continuity\/grants\/([^/]+)\/revoke$/,
    );
    if (request.method === "POST" && continuityRevocation) {
      const csrf = authorizeBrowserMutation(request, environment);
      if (!csrf.ok) return json(request, environment, csrf, 403);
      const auth = await authenticateRequest(request, environment);
      if (!auth.ok) return json(request, environment, auth, 401);
      const result = await revokeContinuityGrant(
        environment,
        auth.principalId,
        continuityRevocation[1],
        new Date().toISOString(),
      );
      return json(request, environment, result, result.ok ? 200 : 404);
    }

    const continuityOperation = url.pathname.match(
      /^\/api\/site-session-continuity\/grants\/([^/]+)\/(revisions|fetch|acknowledgements)$/,
    );
    if (request.method === "POST" && continuityOperation) {
      const origin = authorizeNonBrowserClient(request, environment);
      if (!origin.ok) return json(request, environment, origin, 403);
      const body = await boundedJson(request, 196_608);
      const now = new Date().toISOString();
      const routeGrantId = continuityOperation[1]!;
      const result =
        continuityOperation[2] === "revisions"
          ? await publishContinuityRevision(
              environment,
              routeGrantId,
              body,
              now,
            )
          : continuityOperation[2] === "fetch"
            ? await fetchContinuityRevision(
                environment,
                routeGrantId,
                body,
                now,
              )
            : await acknowledgeContinuityRevision(
                environment,
                routeGrantId,
                body,
                now,
              );
      const successStatus = continuityOperation[2] === "revisions" ? 201 : 200;
      const failureStatus =
        "code" in result && result.code === "CONTINUITY_GRANT_NOT_FOUND"
          ? 404
          : 409;
      return json(
        request,
        environment,
        result,
        result.ok ? successStatus : failureStatus,
      );
    }

    if (url.pathname === "/api/jobs") {
      const auth = await authenticateRequest(request, environment);
      if (!auth.ok) return json(request, environment, auth, 401);
      if (request.method === "GET") {
        return json(
          request,
          environment,
          await listJobs(environment.VILLAGE_DB, auth.principalId),
        );
      }
      if (request.method === "POST") {
        const csrf = authorizeBrowserMutation(request, environment);
        if (!csrf.ok) return json(request, environment, csrf, 403);
        const parsedBody = z
          .strictObject({ objective: setupObjectiveSchema })
          .nullable()
          .safeParse(await boundedOptionalJson(request));
        if (!parsedBody.success)
          return json(
            request,
            environment,
            { ok: false, code: "INVALID_OBJECTIVE" },
            400,
          );
        const result = await createJob(
          environment.VILLAGE_DB,
          auth.principalId,
          new Date().toISOString(),
          parsedBody.data?.objective,
        );
        return json(request, environment, result, result.ok ? 201 : 400);
      }
    }

    const job = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (request.method === "GET" && job) {
      const auth = await authenticateRequest(request, environment);
      if (!auth.ok) return json(request, environment, auth, 401);
      const result = await getJob(
        environment.VILLAGE_DB,
        auth.principalId,
        job[1],
      );
      return json(request, environment, result, result.ok ? 200 : 404);
    }

    const jobSession = url.pathname.match(
      /^\/api\/jobs\/([^/]+)\/browser-sessions$/,
    );
    if (request.method === "POST" && jobSession) {
      const csrf = authorizeBrowserMutation(request, environment);
      if (!csrf.ok) return json(request, environment, csrf, 403);
      const auth = await authenticateRequest(request, environment);
      if (!auth.ok) return json(request, environment, auth, 401);
      const jobId = jobIdSchema.safeParse(jobSession[1]);
      const body = z
        .strictObject({
          deviceId: deviceIdSchema,
          browserSessionId: browserSessionIdSchema,
          hostId: hostIdSchema,
          site: z.enum(["OWNED_FIXTURE", "LINKEDIN"]),
        })
        .safeParse(await boundedJson(request));
      if (!jobId.success || !body.success)
        return json(
          request,
          environment,
          { ok: false, code: "INVALID_SESSION_REQUEST" },
          400,
        );
      const result = await createOwnedBrowserSession(environment, {
        principalId: auth.principalId,
        jobId: jobId.data,
        ...body.data,
        now: new Date().toISOString(),
      });
      return json(
        request,
        environment,
        result,
        result.ok
          ? 201
          : result.code === "AUTHENTICATED_QUOTA_EXCEEDED"
            ? 429
            : 409,
      );
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/pairing/challenges"
    ) {
      const csrf = authorizeBrowserMutation(request, environment);
      if (!csrf.ok) return json(request, environment, csrf, 403);
      const auth = await authenticateRequest(request, environment);
      if (!auth.ok) return json(request, environment, auth, 401);
      const body = await boundedJson(request);
      const result = await beginPairing(environment.VILLAGE_DB, {
        ...(typeof body === "object" && body !== null ? body : {}),
        principalId: auth.principalId,
        now: new Date().toISOString(),
      });
      return json(request, environment, result, result.ok ? 201 : 400);
    }

    const confirmation = url.pathname.match(
      /^\/api\/pairing\/([^/]+)\/confirm$/,
    );
    const pairingStatus = url.pathname.match(/^\/api\/pairing\/([^/]+)$/);
    if (request.method === "GET" && pairingStatus) {
      const auth = await authenticateRequest(request, environment);
      if (!auth.ok) return json(request, environment, auth, 401);
      const pairingId = pairingIdSchema.safeParse(pairingStatus[1]);
      if (!pairingId.success) {
        return json(
          request,
          environment,
          { ok: false, code: "INVALID_PAIRING_ID" },
          400,
        );
      }
      const result = await getPairingStatus(environment.VILLAGE_DB, {
        principalId: auth.principalId,
        pairingId: pairingId.data,
        now: new Date().toISOString(),
      });
      return json(request, environment, result, result.ok ? 200 : 404);
    }
    if (request.method === "POST" && confirmation) {
      const csrf = authorizeBrowserMutation(request, environment);
      if (!csrf.ok) return json(request, environment, csrf, 403);
      const auth = await authenticateRequest(request, environment);
      if (!auth.ok) return json(request, environment, auth, 401);
      const pairingId = pairingIdSchema.safeParse(confirmation[1]);
      if (!pairingId.success)
        return json(
          request,
          environment,
          { ok: false, code: "INVALID_PAIRING_ID" },
          400,
        );
      const result = await confirmPairing(environment.VILLAGE_DB, {
        principalId: auth.principalId,
        pairingId: pairingId.data,
        now: new Date().toISOString(),
      });
      return json(request, environment, result, result.ok ? 200 : 409);
    }

    const rejection = url.pathname.match(/^\/api\/pairing\/([^/]+)\/reject$/);
    if (request.method === "POST" && rejection) {
      const csrf = authorizeBrowserMutation(request, environment);
      if (!csrf.ok) return json(request, environment, csrf, 403);
      const auth = await authenticateRequest(request, environment);
      if (!auth.ok) return json(request, environment, auth, 401);
      const pairingId = pairingIdSchema.safeParse(rejection[1]);
      if (!pairingId.success)
        return json(
          request,
          environment,
          { ok: false, code: "INVALID_PAIRING_ID" },
          400,
        );
      const result = await rejectPairing(environment.VILLAGE_DB, {
        principalId: auth.principalId,
        pairingId: pairingId.data,
        now: new Date().toISOString(),
      });
      return json(request, environment, result, result.ok ? 200 : 409);
    }

    const consumption = url.pathname.match(
      /^\/api\/pairing\/([^/]+)\/consume$/,
    );
    if (request.method === "POST" && consumption) {
      const origin = authorizeNonBrowserClient(request, environment);
      if (!origin.ok) return json(request, environment, origin, 403);
      const pairingId = pairingIdSchema.safeParse(consumption[1]);
      const body = z
        .strictObject({
          principalId: principalIdSchema,
          secret: z.string().max(128),
        })
        .safeParse(await boundedJson(request));
      if (!pairingId.success || !body.success)
        return json(
          request,
          environment,
          { ok: false, code: "INVALID_PAIRING_CONSUMPTION" },
          400,
        );
      const result = await consumePairing(environment.VILLAGE_DB, {
        ...body.data,
        pairingId: pairingId.data,
        now: new Date().toISOString(),
      });
      return json(request, environment, result, result.ok ? 200 : 409);
    }

    const device = url.pathname.match(/^\/api\/devices\/([^/]+)$/);
    const credential = url.pathname.match(
      /^\/api\/devices\/([^/]+)\/credential$/,
    );
    if (request.method === "PUT" && credential) {
      const csrf = authorizeBrowserMutation(request, environment);
      if (!csrf.ok) return json(request, environment, csrf, 403);
      const auth = await authenticateRequest(request, environment);
      if (!auth.ok) return json(request, environment, auth, 401);
      const deviceId = deviceIdSchema.safeParse(credential[1]);
      const body = z
        .strictObject({
          publicKey: z.strictObject({
            kty: z.literal("OKP"),
            crv: z.literal("Ed25519"),
            x: z.string().min(1).max(128),
          }),
        })
        .safeParse(await boundedJson(request));
      if (!deviceId.success || !body.success)
        return json(
          request,
          environment,
          { ok: false, code: "INVALID_CREDENTIAL_ROTATION" },
          400,
        );
      const result = await rotateDeviceCredential(environment.VILLAGE_DB, {
        principalId: auth.principalId,
        deviceId: deviceId.data,
        publicKey: body.data.publicKey,
        now: new Date().toISOString(),
      });
      return json(request, environment, result, result.ok ? 200 : 404);
    }
    if (request.method === "DELETE" && device) {
      const csrf = authorizeBrowserMutation(request, environment);
      if (!csrf.ok) return json(request, environment, csrf, 403);
      const auth = await authenticateRequest(request, environment);
      if (!auth.ok) return json(request, environment, auth, 401);
      const deviceId = deviceIdSchema.safeParse(device[1]);
      if (!deviceId.success)
        return json(
          request,
          environment,
          { ok: false, code: "INVALID_DEVICE_ID" },
          400,
        );
      const result = await revokeDevice(
        environment.VILLAGE_DB,
        auth.principalId,
        deviceId.data,
        new Date().toISOString(),
      );
      return json(request, environment, result, result.ok ? 200 : 404);
    }

    const session = url.pathname.match(/^\/api\/browser-sessions\/([^/]+)$/);
    if (request.method === "GET" && session) {
      const auth = await authenticateRequest(request, environment);
      if (!auth.ok) return json(request, environment, auth, 401);
      const sessionId = browserSessionIdSchema.safeParse(session[1]);
      if (!sessionId.success)
        return json(
          request,
          environment,
          { ok: false, code: "INVALID_SESSION_ID" },
          400,
        );
      const snapshot = await environment.BROWSER_SESSION_COORDINATOR.getByName(
        sessionId.data,
      ).snapshot(auth.principalId);
      return json(request, environment, snapshot, snapshot.ok ? 200 : 404);
    }

    const sessionOperation = url.pathname.match(
      /^\/api\/browser-sessions\/([^/]+)\/(connect|commands|results|events|stream|observer|cancel|project|rebuild-projection|automation-sync|workflow-operations|notifications)$/,
    );
    if (sessionOperation) {
      const sessionId = browserSessionIdSchema.safeParse(sessionOperation[1]);
      if (!sessionId.success)
        return json(
          request,
          environment,
          { ok: false, code: "INVALID_SESSION_ID" },
          400,
        );
      const operation = sessionOperation[2];
      if (request.method === "POST" && operation === "connect") {
        const origin = authorizeNonBrowserClient(request, environment);
        if (!origin.ok) return json(request, environment, origin, 403);
        const connectionId = request.headers.get("x-village-connection-id");
        if (!connectionId)
          return json(
            request,
            environment,
            { ok: false, code: "CONNECTION_ID_REQUIRED" },
            400,
          );
        const body = await boundedJson(request);
        const result = await dispatchAuthenticatedSessionOpen(
          environment,
          body,
          connectionId,
          new Date().toISOString(),
          sessionId.data,
        );
        return json(
          request,
          environment,
          result,
          authenticatedMutationStatus(result, 200),
        );
      }
      if (request.method === "POST" && operation === "commands") {
        const origin = authorizeNonBrowserClient(request, environment);
        if (!origin.ok) return json(request, environment, origin, 403);
        const connectionId = request.headers.get("x-village-connection-id");
        if (!connectionId)
          return json(
            request,
            environment,
            { ok: false, code: "CONNECTION_ID_REQUIRED" },
            400,
          );
        const body = await boundedJson(request);
        const result = await dispatchAuthenticatedCommand(
          environment,
          body,
          connectionId,
          new Date().toISOString(),
          sessionId.data,
        );
        return json(
          request,
          environment,
          result,
          authenticatedMutationStatus(result),
        );
      }
      if (request.method === "POST" && operation === "results") {
        const origin = authorizeNonBrowserClient(request, environment);
        if (!origin.ok) return json(request, environment, origin, 403);
        const connectionId = request.headers.get("x-village-connection-id");
        if (!connectionId)
          return json(
            request,
            environment,
            { ok: false, code: "CONNECTION_ID_REQUIRED" },
            400,
          );
        const body = await boundedJson(request);
        const result = await dispatchAuthenticatedResult(
          environment,
          body,
          connectionId,
          new Date().toISOString(),
          sessionId.data,
        );
        return json(
          request,
          environment,
          result,
          authenticatedMutationStatus(result),
        );
      }
      if (request.method === "POST" && operation === "automation-sync") {
        const origin = authorizeNonBrowserClient(request, environment);
        if (!origin.ok) return json(request, environment, origin, 403);
        const connectionId = request.headers.get("x-village-connection-id");
        if (!connectionId) {
          return json(
            request,
            environment,
            { ok: false, code: "CONNECTION_ID_REQUIRED" },
            400,
          );
        }
        const result = await dispatchAuthenticatedAutomationSync(
          environment,
          await boundedJson(request),
          connectionId,
          new Date().toISOString(),
          sessionId.data,
        );
        return json(
          request,
          environment,
          result,
          authenticatedMutationStatus(result, 200),
        );
      }
      if (request.method === "POST" && operation === "workflow-operations") {
        const origin = authorizeNonBrowserClient(request, environment);
        if (!origin.ok) return json(request, environment, origin, 403);
        const connectionId = request.headers.get("x-village-connection-id");
        if (!connectionId) {
          return json(
            request,
            environment,
            { ok: false, code: "CONNECTION_ID_REQUIRED" },
            400,
          );
        }
        const result = await dispatchAuthenticatedWorkflowOperation(
          environment,
          await boundedJson(request),
          connectionId,
          new Date().toISOString(),
          sessionId.data,
        );
        return json(
          request,
          environment,
          result,
          authenticatedMutationStatus(result, 200),
        );
      }

      const auth = await authenticateRequest(request, environment);
      if (!auth.ok) return json(request, environment, auth, 401);
      const coordinator = environment.BROWSER_SESSION_COORDINATOR.getByName(
        sessionId.data,
      );
      const quotaDeviceId = await ownedSessionDevice(
        environment,
        auth.principalId,
        sessionId.data,
      );
      if (!quotaDeviceId) {
        return json(
          request,
          environment,
          { ok: false, code: "SESSION_NOT_FOUND" },
          404,
        );
      }
      if (request.method === "POST" && operation === "notifications") {
        const csrf = authorizeBrowserMutation(request, environment);
        if (!csrf.ok) return json(request, environment, csrf, 403);
        const body = z
          .strictObject({ reason: z.literal("ATTENTION_REQUIRED") })
          .safeParse(await boundedJson(request));
        if (!body.success)
          return json(
            request,
            environment,
            { ok: false, code: "INVALID_NOTIFICATION_REQUEST" },
            400,
          );
        const now = new Date().toISOString();
        const quota = await consumeAuthenticatedQuota(
          environment.VILLAGE_DB,
          auth.principalId,
          quotaDeviceId,
          "notifications",
          now,
        );
        if (!quota.ok) return json(request, environment, quota, 429);
        const retainedQuota = await consumeAuthenticatedQuota(
          environment.VILLAGE_DB,
          auth.principalId,
          quotaDeviceId,
          "retainedRecords",
          now,
        );
        if (!retainedQuota.ok)
          return json(request, environment, retainedQuota, 429);
        const result = await coordinator.requestDesktopNotification({
          principalId: auth.principalId,
          reason: body.data.reason,
          now,
        });
        return json(
          request,
          environment,
          result,
          authenticatedMutationStatus(result),
        );
      }
      if (request.method === "GET" && operation === "observer") {
        const quota = await consumeAuthenticatedQuota(
          environment.VILLAGE_DB,
          auth.principalId,
          quotaDeviceId,
          "replays",
          new Date().toISOString(),
        );
        if (!quota.ok) return json(request, environment, quota, 429);
        const cursor = Number(url.searchParams.get("cursor") ?? "0");
        const result = await getObserverWorkflowProjection(
          environment,
          auth.principalId,
          sessionId.data,
          cursor,
        );
        return json(request, environment, result, result.ok ? 200 : 409);
      }
      if (request.method === "GET" && operation === "stream") {
        const origin = authorizeNonBrowserClient(request, environment);
        if (!origin.ok) return json(request, environment, origin, 403);
        const cursor = Number(url.searchParams.get("cursor") ?? "0");
        if (!Number.isInteger(cursor) || cursor < 0)
          return json(
            request,
            environment,
            { ok: false, code: "INVALID_CURSOR" },
            400,
          );
        const connectionQuota = await consumeAuthenticatedQuota(
          environment.VILLAGE_DB,
          auth.principalId,
          quotaDeviceId,
          "connections",
          new Date().toISOString(),
        );
        if (!connectionQuota.ok)
          return json(request, environment, connectionQuota, 429);
        const quota = await consumeAuthenticatedQuota(
          environment.VILLAGE_DB,
          auth.principalId,
          quotaDeviceId,
          "replays",
          new Date().toISOString(),
        );
        if (!quota.ok) return json(request, environment, quota, 429);
        return openBrowserEventStream(
          environment,
          auth.principalId,
          sessionId.data,
          cursor,
          request,
        );
      }
      if (request.method === "GET" && operation === "events") {
        const quota = await consumeAuthenticatedQuota(
          environment.VILLAGE_DB,
          auth.principalId,
          quotaDeviceId,
          "replays",
          new Date().toISOString(),
        );
        if (!quota.ok) return json(request, environment, quota, 429);
        const cursor = Number(url.searchParams.get("cursor") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const result = await coordinator.eventsAfter(
          auth.principalId,
          cursor,
          limit,
        );
        return json(request, environment, result, result.ok ? 200 : 400);
      }
      if (request.method === "POST" && operation === "cancel") {
        const csrf = authorizeBrowserMutation(request, environment);
        if (!csrf.ok) return json(request, environment, csrf, 403);
        const supplied = await boundedOptionalJson(request);
        const parsed = z
          .strictObject({
            jobId: jobIdSchema,
            expectedJobRevision: z.number().int().positive(),
            cancellationId: z.string().regex(/^cnl_[0-9A-HJKMNP-TV-Z]{26}$/),
          })
          .nullable()
          .safeParse(supplied);
        if (!parsed.success)
          return json(
            request,
            environment,
            { ok: false, code: "INVALID_CANCEL" },
            400,
          );
        const now = new Date().toISOString();
        const commandQuota = await consumeAuthenticatedQuota(
          environment.VILLAGE_DB,
          auth.principalId,
          quotaDeviceId,
          "commands",
          now,
        );
        if (!commandQuota.ok)
          return json(request, environment, commandQuota, 429);
        const retainedQuota = await consumeAuthenticatedQuota(
          environment.VILLAGE_DB,
          auth.principalId,
          quotaDeviceId,
          "retainedRecords",
          now,
        );
        if (!retainedQuota.ok)
          return json(request, environment, retainedQuota, 429);
        let cancellation = parsed.data;
        if (cancellation === null) {
          // Rollback-compatible legacy clients sent an empty body. They retain
          // the existing principal-bound cancel semantics during rollout.
          const result = await coordinator.cancel(auth.principalId, now);
          return json(request, environment, result, result.ok ? 200 : 409);
        }
        const workflow = await environment.VILLAGE_DB.prepare(
          `SELECT jobs.version, jobs.objective_kind AS objectiveKind,
                  jobs.objective_version AS objectiveVersion
           FROM browser_sessions JOIN jobs
             ON jobs.principal_id = browser_sessions.principal_id
            AND jobs.job_id = browser_sessions.job_id
           WHERE browser_sessions.principal_id = ?
             AND browser_sessions.browser_session_id = ?
             AND jobs.job_id = ?`,
        )
          .bind(auth.principalId, sessionId.data, cancellation.jobId)
          .first<{
            version: number;
            objectiveKind: string | null;
            objectiveVersion: number | null;
          }>();
        if (!workflow)
          return json(
            request,
            environment,
            { ok: false, code: "JOB_IDENTITY_MISMATCH" },
            409,
          );
        if (
          workflow.objectiveKind !== "OWNED_FIXTURE_ACCOUNT_SETUP_V1" ||
          workflow.objectiveVersion !== 1
        )
          return json(
            request,
            environment,
            { ok: false, code: "WORKFLOW_MISMATCH" },
            409,
          );
        if (workflow.version !== cancellation.expectedJobRevision)
          return json(
            request,
            environment,
            { ok: false, code: "STALE_JOB_REVISION" },
            409,
          );
        const result = await coordinator.cancel({
          principalId: auth.principalId,
          ...cancellation,
          now,
        });
        return json(request, environment, result, result.ok ? 200 : 409);
      }
      if (request.method === "POST" && operation === "project") {
        const csrf = authorizeBrowserMutation(request, environment);
        if (!csrf.ok) return json(request, environment, csrf, 403);
        const retainedQuota = await consumeAuthenticatedQuota(
          environment.VILLAGE_DB,
          auth.principalId,
          quotaDeviceId,
          "retainedRecords",
          new Date().toISOString(),
        );
        if (!retainedQuota.ok)
          return json(request, environment, retainedQuota, 429);
        const result = await projectSessionEvents(
          environment,
          auth.principalId,
          sessionId.data,
          new Date().toISOString(),
        );
        return json(request, environment, result, result.ok ? 200 : 409);
      }
      if (request.method === "POST" && operation === "rebuild-projection") {
        const csrf = authorizeBrowserMutation(request, environment);
        if (!csrf.ok) return json(request, environment, csrf, 403);
        const quota = await consumeAuthenticatedQuota(
          environment.VILLAGE_DB,
          auth.principalId,
          quotaDeviceId,
          "replays",
          new Date().toISOString(),
        );
        if (!quota.ok) return json(request, environment, quota, 429);
        const retainedQuota = await consumeAuthenticatedQuota(
          environment.VILLAGE_DB,
          auth.principalId,
          quotaDeviceId,
          "retainedRecords",
          new Date().toISOString(),
        );
        if (!retainedQuota.ok)
          return json(request, environment, retainedQuota, 429);
        const result = await rebuildSessionProjection(
          environment,
          auth.principalId,
          sessionId.data,
          new Date().toISOString(),
        );
        return json(request, environment, result, result.ok ? 200 : 409);
      }
    }
  } catch (error) {
    const code =
      error instanceof Error && error.message === "BODY_TOO_LARGE"
        ? "BODY_TOO_LARGE"
        : "INVALID_REQUEST";
    return json(request, environment, { ok: false, code }, 400);
  }

  return json(request, environment, { error: "not_found" }, 404);
}
