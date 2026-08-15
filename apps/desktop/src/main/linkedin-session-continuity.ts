import {
  browserSessionIdSchema,
  deviceIdSchema,
  principalIdSchema,
} from "@village/contracts";
import type { CookiesSetDetails } from "electron";
import { z } from "zod";
import type { SensitiveActionAuthorizer } from "./sensitive-action-authorizer.js";

const linkedInCookieDomainSchema = z.enum([
  ".linkedin.com",
  "linkedin.com",
  "www.linkedin.com",
]);

const linkedInContinuityCookieSchema = z
  .strictObject({
    name: z.string().regex(/^[^\s;=]{1,256}$/),
    value: z.string().max(8_192),
    domain: linkedInCookieDomainSchema,
    path: z.string().regex(/^\/.{0,1023}$/),
    secure: z.literal(true),
    httpOnly: z.boolean(),
    sameSite: z.enum(["unspecified", "no_restriction", "lax", "strict"]),
    expirationDate: z.number().positive().finite(),
    hostOnly: z.boolean(),
  })
  .superRefine((cookie, context) => {
    if (cookie.hostOnly && cookie.domain.startsWith(".")) {
      context.addIssue({
        code: "custom",
        message: "A host-only cookie cannot use a domain-cookie scope",
      });
    }
  });

const linkedInContinuityEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  transferId: z.string().regex(/^ctf_[0-9A-HJKMNP-TV-Z]{26}$/),
  principalId: principalIdSchema,
  sourceDeviceId: deviceIdSchema,
  destinationDeviceId: deviceIdSchema,
  browserSessionId: browserSessionIdSchema,
  site: z.literal("LINKEDIN"),
  issuedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  cookies: z.array(linkedInContinuityCookieSchema).min(1).max(64),
  signature: z.string().regex(/^[A-Za-z0-9_-]{12,512}$/),
});

export type LinkedInContinuityEnvelope = z.infer<
  typeof linkedInContinuityEnvelopeSchema
>;

interface DestinationCookieStore {
  set(details: CookiesSetDetails): Promise<void>;
  flushStore(): Promise<void>;
}

interface ContinuityDestination {
  cookies: DestinationCookieStore;
}

export interface ContinuityReplayStore {
  claim(transferId: string): Promise<boolean>;
}

export class InMemoryContinuityReplayStore implements ContinuityReplayStore {
  private readonly claimed = new Set<string>();

  async claim(transferId: string): Promise<boolean> {
    if (this.claimed.has(transferId)) return false;
    this.claimed.add(transferId);
    return true;
  }
}

interface LinkedInSessionContinuityImporterOptions {
  destination: ContinuityDestination;
  destinationBinding: {
    principalId: string;
    deviceId: string;
    browserSessionId: string;
  };
  authorizer: SensitiveActionAuthorizer;
  verifyEnvelope(envelope: LinkedInContinuityEnvelope): Promise<boolean>;
  replayStore: ContinuityReplayStore;
  now?: () => number;
}

export class LinkedInSessionContinuityImporter {
  private readonly now: () => number;

  constructor(
    private readonly options: LinkedInSessionContinuityImporterOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async import(
    candidate: unknown,
    ownerAuthorizationToken: string,
  ): Promise<{ transferId: string; importedCookieCount: number }> {
    const parsed = linkedInContinuityEnvelopeSchema.safeParse(candidate);
    if (!parsed.success) throw new Error("CONTINUITY_ENVELOPE_INVALID");
    const envelope = parsed.data;
    this.assertDestination(envelope);
    this.assertLifetime(envelope);
    this.assertCookiesUnexpired(envelope);

    if (!(await this.options.verifyEnvelope(envelope))) {
      throw new Error("CONTINUITY_ENVELOPE_UNAUTHENTICATED");
    }

    const authorized = this.options.authorizer.consume(
      ownerAuthorizationToken,
      {
        principalId: envelope.principalId,
        deviceId: envelope.destinationDeviceId,
        browserSessionId: envelope.browserSessionId,
        operation: "IMPORT_SITE_SESSION",
      },
    );
    if (!authorized.ok) {
      throw new Error("CONTINUITY_OWNER_AUTHORIZATION_DENIED");
    }
    if (!(await this.options.replayStore.claim(envelope.transferId))) {
      throw new Error("CONTINUITY_ENVELOPE_REPLAYED");
    }

    try {
      for (const cookie of envelope.cookies) {
        await this.options.destination.cookies.set(toCookieDetails(cookie));
      }
      await this.options.destination.cookies.flushStore();
    } catch {
      throw new Error("CONTINUITY_IMPORT_OUTCOME_UNKNOWN");
    }

    return {
      transferId: envelope.transferId,
      importedCookieCount: envelope.cookies.length,
    };
  }

  private assertDestination(envelope: LinkedInContinuityEnvelope): void {
    const destination = this.options.destinationBinding;
    if (
      envelope.principalId !== destination.principalId ||
      envelope.destinationDeviceId !== destination.deviceId ||
      envelope.browserSessionId !== destination.browserSessionId
    ) {
      throw new Error("CONTINUITY_DESTINATION_MISMATCH");
    }
    if (envelope.sourceDeviceId === envelope.destinationDeviceId) {
      throw new Error("CONTINUITY_SOURCE_DESTINATION_COLLISION");
    }
  }

  private assertLifetime(envelope: LinkedInContinuityEnvelope): void {
    const issuedAt = Date.parse(envelope.issuedAt);
    const expiresAt = Date.parse(envelope.expiresAt);
    const now = this.now();
    if (expiresAt <= now) throw new Error("CONTINUITY_ENVELOPE_EXPIRED");
    if (
      issuedAt > now + 5_000 ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > 60_000
    ) {
      throw new Error("CONTINUITY_ENVELOPE_LIFETIME_INVALID");
    }
  }

  private assertCookiesUnexpired(envelope: LinkedInContinuityEnvelope): void {
    const nowSeconds = this.now() / 1_000;
    if (
      envelope.cookies.some((cookie) => cookie.expirationDate <= nowSeconds)
    ) {
      throw new Error("CONTINUITY_COOKIE_EXPIRED");
    }
  }
}

function toCookieDetails(
  cookie: z.infer<typeof linkedInContinuityCookieSchema>,
): CookiesSetDetails {
  const host = cookie.domain.replace(/^\./, "");
  return {
    url: `https://${host}${cookie.path}`,
    name: cookie.name,
    value: cookie.value,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    path: cookie.path,
    secure: true,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate,
  };
}
