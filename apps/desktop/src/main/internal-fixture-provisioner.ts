import {
  browserSessionIdSchema,
  deviceIdSchema,
  hostIdSchema,
  jobIdSchema,
  principalIdSchema,
} from "@village/contracts";
import { randomBytes } from "node:crypto";

const idAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

type FixtureIdPrefix = "brs" | "hst";

interface InternalFixtureProvisioningOptions {
  controlPlaneUrl: URL;
  identity: {
    principalId: string;
    deviceId: string;
    browserSessionId: string;
  };
  request?: typeof fetch;
  createId?: (prefix: FixtureIdPrefix) => string;
  csrfToken?: () => string;
}

function createId(prefix: FixtureIdPrefix): string {
  let suffix = "";
  for (const byte of randomBytes(26)) suffix += idAlphabet[byte & 31];
  return `${prefix}_${suffix}`;
}

function exactKeys(candidate: unknown, expected: readonly string[]) {
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    Object.keys(candidate).sort().join(",") === [...expected].sort().join(",")
  );
}

function responseCode(candidate: unknown, fallback: string): string {
  return candidate &&
    typeof candidate === "object" &&
    "code" in candidate &&
    typeof candidate.code === "string" &&
    /^[A-Z0-9_]{1,80}$/.test(candidate.code)
    ? candidate.code
    : fallback;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function provisionInternalOwnedFixture(
  options: InternalFixtureProvisioningOptions,
): Promise<{
  jobId: string;
  browserSessionId: string;
  hostId: string;
}> {
  const loopback =
    options.controlPlaneUrl.hostname === "localhost" ||
    options.controlPlaneUrl.hostname === "127.0.0.1";
  if (
    !loopback ||
    !["http:", "https:"].includes(options.controlPlaneUrl.protocol)
  ) {
    throw new Error("INTERNAL_FIXTURE_PROVISIONING_REQUIRES_LOOPBACK");
  }
  const principalId = principalIdSchema.parse(options.identity.principalId);
  const deviceId = deviceIdSchema.parse(options.identity.deviceId);
  const personalBrowserSessionId = browserSessionIdSchema.parse(
    options.identity.browserSessionId,
  );
  const makeId = options.createId ?? createId;
  const browserSessionId = browserSessionIdSchema.parse(makeId("brs"));
  const hostId = hostIdSchema.parse(makeId("hst"));
  if (browserSessionId === personalBrowserSessionId) {
    throw new Error("INTERNAL_FIXTURE_SESSION_NOT_DISTINCT");
  }
  const csrf = options.csrfToken?.() ?? randomBytes(32).toString("base64url");
  if (csrf.length < 32 || !/^[A-Za-z0-9_-]+$/.test(csrf)) {
    throw new Error("INTERNAL_FIXTURE_CSRF_INVALID");
  }
  const request = options.request ?? fetch;
  const headers = {
    "content-type": "application/json",
    origin: options.controlPlaneUrl.origin,
    cookie: `village_csrf=${csrf}`,
    "x-village-csrf": csrf,
    "x-village-development-principal": principalId,
  };
  const jobResponse = await request(
    new URL("/api/jobs", options.controlPlaneUrl),
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        objective: {
          kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
          version: 1,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const jobCandidate = await readJson(jobResponse);
  const jobId =
    exactKeys(jobCandidate, ["ok", "jobId"]) &&
    (jobCandidate as { ok?: unknown }).ok === true
      ? jobIdSchema.safeParse((jobCandidate as { jobId?: unknown }).jobId)
      : undefined;
  if (!jobResponse.ok || !jobId?.success) {
    throw new Error(
      responseCode(jobCandidate, "INTERNAL_FIXTURE_JOB_RESPONSE_INVALID"),
    );
  }
  const sessionResponse = await request(
    new URL(
      `/api/jobs/${jobId.data}/browser-sessions`,
      options.controlPlaneUrl,
    ),
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        deviceId,
        browserSessionId,
        hostId,
        site: "OWNED_FIXTURE",
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const sessionCandidate = await readJson(sessionResponse);
  const returnedSessionId =
    exactKeys(sessionCandidate, ["ok", "browserSessionId"]) &&
    (sessionCandidate as { ok?: unknown }).ok === true
      ? browserSessionIdSchema.safeParse(
          (sessionCandidate as { browserSessionId?: unknown }).browserSessionId,
        )
      : undefined;
  if (
    !sessionResponse.ok ||
    !returnedSessionId?.success ||
    returnedSessionId.data !== browserSessionId
  ) {
    throw new Error(
      responseCode(
        sessionCandidate,
        "INTERNAL_FIXTURE_SESSION_RESPONSE_INVALID",
      ),
    );
  }
  return { jobId: jobId.data, browserSessionId, hostId };
}
