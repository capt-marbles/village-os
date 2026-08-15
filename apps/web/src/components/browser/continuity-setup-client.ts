import {
  continuityGrantIdSchema,
  continuityGrantCreationResponseSchema,
  continuityGrantRevocationResponseSchema,
  continuitySetupResponseSchema,
  continuitySetupSessionSchema,
  type ContinuitySetupResponse,
} from "@village/contracts";
import {
  createVillageId,
  readVillageCsrfCookie,
} from "./pairing-setup-client.js";

export type ContinuitySetupSession =
  ContinuitySetupResponse["sessions"][number];
export type ContinuitySetupGrant = ContinuitySetupResponse["grants"][number];

export class ContinuitySetupClient {
  private readonly baseUrl: URL;

  constructor(
    baseUrl: string | URL,
    private readonly request: typeof fetch = fetch.bind(globalThis),
    private readonly csrfToken: () =>
      string | undefined = readVillageCsrfCookie,
    private readonly now: () => number = Date.now,
    private readonly createGrantId: () => string = () => createVillageId("cgr"),
  ) {
    this.baseUrl = new URL(baseUrl);
  }

  async load(signal?: AbortSignal): Promise<ContinuitySetupResponse> {
    const response = await this.request(
      new URL("/api/site-session-continuity/setup", this.baseUrl),
      {
        credentials: "include",
        headers: { accept: "application/json" },
        ...(signal ? { signal } : {}),
      },
    );
    const candidate: unknown = await response.json();
    const parsed = continuitySetupResponseSchema.safeParse(candidate);
    if (!response.ok || !parsed.success) {
      throw new Error("CONTINUITY_SETUP_RESPONSE_INVALID");
    }
    return parsed.data;
  }

  async createGrant(
    sourceCandidate: unknown,
    destinationCandidate: unknown,
  ): Promise<ContinuitySetupGrant> {
    const source = continuitySetupSessionSchema.parse(sourceCandidate);
    const destination =
      continuitySetupSessionSchema.parse(destinationCandidate);
    if (
      source.deviceId === destination.deviceId ||
      source.browserSessionId === destination.browserSessionId ||
      destination.recipientKeyState !== "READY"
    ) {
      throw new Error("CONTINUITY_SETUP_SELECTION_INVALID");
    }
    const issuedAt = this.now();
    const body = {
      grantId: continuityGrantIdSchema.parse(this.createGrantId()),
      sourceDeviceId: source.deviceId,
      destinationDeviceId: destination.deviceId,
      sourceBrowserSessionId: source.browserSessionId,
      destinationBrowserSessionId: destination.browserSessionId,
      site: "OWNED_FIXTURE" as const,
      expiresAt: new Date(issuedAt + 7 * 24 * 60 * 60_000).toISOString(),
    };
    const candidate = await this.ownerMutation(
      "/api/site-session-continuity/grants",
      body,
    );
    const parsed = continuityGrantCreationResponseSchema.safeParse(candidate);
    if (!parsed.success) throw new Error("CONTINUITY_GRANT_RESPONSE_INVALID");
    return parsed.data.grant;
  }

  async revokeGrant(grantIdCandidate: unknown): Promise<void> {
    const grantId = continuityGrantIdSchema.parse(grantIdCandidate);
    const candidate = await this.ownerMutation(
      `/api/site-session-continuity/grants/${grantId}/revoke`,
    );
    if (!continuityGrantRevocationResponseSchema.safeParse(candidate).success) {
      throw new Error("CONTINUITY_REVOCATION_RESPONSE_INVALID");
    }
  }

  private async ownerMutation(path: string, body?: unknown): Promise<unknown> {
    const csrf = this.csrfToken();
    if (!csrf || csrf.length < 32)
      throw new Error("CONTINUITY_CSRF_UNAVAILABLE");
    const response = await this.request(new URL(path, this.baseUrl), {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-village-csrf": csrf,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const candidate = await response.json();
    if (!response.ok) {
      const code =
        candidate &&
        typeof candidate === "object" &&
        "code" in candidate &&
        typeof candidate.code === "string"
          ? candidate.code
          : "CONTINUITY_REQUEST_FAILED";
      throw new Error(code);
    }
    return candidate;
  }
}
