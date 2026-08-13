import {
  browserSessionIdSchema,
  deviceIdSchema,
  hostIdSchema,
  jobIdSchema,
  pairingIdSchema,
  principalIdSchema,
} from "@village/contracts";

export interface PublicPairingRequest {
  deviceId: string;
  deviceDisplayName: string;
  publicKey: { kty: "OKP"; crv: "Ed25519"; x: string };
  protection: "OS_PROTECTED_FALLBACK";
  secretHash: string;
}

export interface PairingChallenge {
  principalId: string;
  pairingId: string;
  deviceId: string;
  fingerprint: string;
  expiresAt: string;
}

export interface PairedBrowserSession {
  jobId: string;
  browserSessionId: string;
  hostId: string;
}

export type PairingStatus =
  "PENDING_CONFIRMATION" | "CONFIRMED" | "EXPIRED" | "REJECTED" | "CONSUMED";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readCsrfCookie(): string | undefined {
  if (typeof document === "undefined") return undefined;
  for (const pair of document.cookie.split(";")) {
    const [name, ...value] = pair.trim().split("=");
    if (name === "village_csrf") return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value).toSorted();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function parsePublicPairingRequest(text: string): PublicPairingRequest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("PAIRING_REQUEST_INVALID");
  }
  const request = record(value);
  const publicKey = record(request?.publicKey);
  if (
    !request ||
    !publicKey ||
    !exactKeys(request, [
      "deviceDisplayName",
      "deviceId",
      "protection",
      "publicKey",
      "secretHash",
    ]) ||
    !exactKeys(publicKey, ["crv", "kty", "x"]) ||
    !deviceIdSchema.safeParse(request.deviceId).success ||
    typeof request.deviceDisplayName !== "string" ||
    request.deviceDisplayName.trim().length === 0 ||
    request.deviceDisplayName.length > 80 ||
    publicKey.kty !== "OKP" ||
    publicKey.crv !== "Ed25519" ||
    typeof publicKey.x !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(publicKey.x) ||
    request.protection !== "OS_PROTECTED_FALLBACK" ||
    typeof request.secretHash !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(request.secretHash)
  ) {
    throw new Error("PAIRING_REQUEST_INVALID");
  }
  return {
    deviceId: deviceIdSchema.parse(request.deviceId),
    deviceDisplayName: String(request.deviceDisplayName),
    publicKey: {
      kty: "OKP",
      crv: "Ed25519",
      x: String(publicKey.x),
    },
    protection: "OS_PROTECTED_FALLBACK",
    secretHash: String(request.secretHash),
  };
}

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function villageId(prefix: "brs" | "hst", now = Date.now()): string {
  let time = now;
  let suffix = "";
  for (let index = 0; index < 10; index += 1) {
    suffix = alphabet[time % 32] + suffix;
    time = Math.floor(time / 32);
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  for (const byte of random) suffix += alphabet[byte & 31];
  return `${prefix}_${suffix}`;
}

export class PairingSetupClient {
  private readonly baseUrl: URL;

  constructor(
    baseUrl: string | URL,
    private readonly request: typeof fetch = fetch,
    private readonly csrfToken: () => string | undefined = readCsrfCookie,
  ) {
    this.baseUrl = new URL(baseUrl);
  }

  private async json(
    path: string,
    options: RequestInit = {},
    mutation = false,
  ): Promise<Record<string, unknown>> {
    const headers = new Headers(options.headers);
    headers.set("accept", "application/json");
    if (options.body) headers.set("content-type", "application/json");
    if (mutation) {
      const csrf = this.csrfToken();
      if (!csrf || csrf.length < 32)
        throw new Error("PAIRING_CSRF_UNAVAILABLE");
      headers.set("x-village-csrf", csrf);
    }
    const response = await this.request(new URL(path, this.baseUrl), {
      ...options,
      credentials: "include",
      headers,
    });
    const body = record(await response.json());
    if (!response.ok || body?.ok !== true) {
      throw new Error(
        typeof body?.code === "string" ? body.code : "PAIRING_REQUEST_FAILED",
      );
    }
    return body;
  }

  async begin(request: PublicPairingRequest): Promise<PairingChallenge> {
    const body = await this.json(
      "/api/pairing/challenges",
      { method: "POST", body: JSON.stringify(request) },
      true,
    );
    const principalId = principalIdSchema.safeParse(body.principalId);
    const pairingId = pairingIdSchema.safeParse(body.pairingId);
    if (
      !principalId.success ||
      !pairingId.success ||
      typeof body.fingerprint !== "string" ||
      typeof body.expiresAt !== "string"
    )
      throw new Error("PAIRING_RESPONSE_INVALID");
    return {
      principalId: principalId.data,
      pairingId: pairingId.data,
      deviceId: request.deviceId,
      fingerprint: body.fingerprint,
      expiresAt: body.expiresAt,
    };
  }

  async confirm(pairingId: string): Promise<void> {
    const parsed = pairingIdSchema.parse(pairingId);
    await this.json(`/api/pairing/${parsed}/confirm`, { method: "POST" }, true);
  }

  async status(pairingId: string): Promise<PairingStatus> {
    const parsed = pairingIdSchema.parse(pairingId);
    const body = await this.json(`/api/pairing/${parsed}`);
    const pairing = record(body.pairing);
    const state = pairing?.state;
    if (
      ![
        "PENDING_CONFIRMATION",
        "CONFIRMED",
        "EXPIRED",
        "REJECTED",
        "CONSUMED",
      ].includes(String(state))
    )
      throw new Error("PAIRING_STATUS_INVALID");
    return state as PairingStatus;
  }

  async createSession(deviceId: string): Promise<PairedBrowserSession> {
    const parsedDeviceId = deviceIdSchema.parse(deviceId);
    const jobBody = await this.json("/api/jobs", { method: "POST" }, true);
    const jobId = jobIdSchema.parse(jobBody.jobId);
    const browserSessionId = browserSessionIdSchema.parse(villageId("brs"));
    const hostId = hostIdSchema.parse(villageId("hst"));
    await this.json(
      `/api/jobs/${jobId}/browser-sessions`,
      {
        method: "POST",
        body: JSON.stringify({
          deviceId: parsedDeviceId,
          browserSessionId,
          hostId,
          site: "LINKEDIN",
        }),
      },
      true,
    );
    return { jobId, browserSessionId, hostId };
  }
}

export function pairingCompletionUrl(challenge: PairingChallenge): string {
  const url = new URL("village-pair://complete");
  url.searchParams.set(
    "principalId",
    principalIdSchema.parse(challenge.principalId),
  );
  url.searchParams.set("pairingId", pairingIdSchema.parse(challenge.pairingId));
  return url.toString();
}

export function pairingSessionUrl(
  challenge: PairingChallenge,
  session: PairedBrowserSession,
): string {
  const url = new URL("village-pair://session");
  url.searchParams.set(
    "principalId",
    principalIdSchema.parse(challenge.principalId),
  );
  url.searchParams.set("deviceId", deviceIdSchema.parse(challenge.deviceId));
  url.searchParams.set(
    "browserSessionId",
    browserSessionIdSchema.parse(session.browserSessionId),
  );
  return url.toString();
}
