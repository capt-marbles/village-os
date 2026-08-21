import {
  browserSessionIdSchema,
  canonicalContinuityActivationRequestBytes,
  canonicalContinuityAcknowledgementBytes,
  canonicalContinuityFetchBytes,
  canonicalContinuityRecipientKeyEnrollmentBytes,
  continuityAcknowledgementEnvelopeSchema,
  continuityActivationRequestSchema,
  continuityActivationResponseSchema,
  continuityFetchEnvelopeSchema,
  continuityRecipientKeyEnrollmentSchema,
  encryptedContinuityRevisionSchema,
  deviceIdSchema,
  type ContinuityBinding,
  type ContinuityActivation,
  type ContinuityActivationIdentity,
  type EncryptedContinuityRevision,
} from "@village/contracts";
import { z } from "zod";
import { signDeviceBytes, type DeviceSigningKey } from "./device-identity.js";

interface ContinuitySequenceStore {
  reserveNext(
    deviceId: string,
    browserSessionId: string,
    scope:
      "CONTINUITY_ACTIVATION" | "CONTINUITY_ENROLLMENT" | "CONTINUITY_MAILBOX",
  ): Promise<number>;
}

interface ContinuityMailboxClientOptions {
  baseUrl: URL;
  signingKey: DeviceSigningKey;
  sequences: ContinuitySequenceStore;
  request?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

const publishResponseSchema = z.strictObject({
  ok: z.literal(true),
  stored: z.boolean(),
});
const fetchResponseSchema = z.strictObject({
  ok: z.literal(true),
  revision: encryptedContinuityRevisionSchema.nullable(),
});
const acknowledgementResponseSchema = z.strictObject({
  ok: z.literal(true),
  acknowledged: z.boolean(),
});
const recipientKeyEnrollmentResponseSchema = z.strictObject({
  ok: z.literal(true),
  enrolled: z.boolean(),
  deviceId: deviceIdSchema,
  browserSessionId: browserSessionIdSchema,
});

export class ContinuityMailboxClient {
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly options: ContinuityMailboxClientOptions) {
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(
      options.baseUrl.hostname,
    );
    if (
      options.baseUrl.protocol !== "https:" &&
      !(options.baseUrl.protocol === "http:" && loopback)
    ) {
      throw new Error("CONTINUITY_CONTROL_PLANE_URL_UNSAFE");
    }
    this.request = options.request ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async loadActivations(
    identity: ContinuityActivationIdentity,
  ): Promise<ContinuityActivation[]> {
    const sequence = await this.options.sequences.reserveNext(
      identity.deviceId,
      identity.browserSessionId,
      "CONTINUITY_ACTIVATION",
    );
    const issuedAt = this.now();
    const unsigned = {
      protocolVersion: 1 as const,
      ...identity,
      sequence,
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + 30_000).toISOString(),
    };
    const signature = await signDeviceBytes(
      this.options.signingKey,
      canonicalContinuityActivationRequestBytes(unsigned),
    );
    const activation = continuityActivationRequestSchema.parse({
      ...unsigned,
      signature: Buffer.from(signature).toString("base64url"),
    });
    const response = await this.postPath(
      "/api/site-session-continuity/activations",
      activation,
    );
    const body = continuityActivationResponseSchema.safeParse(response);
    if (!body.success) {
      throw responseError(response, "INVALID_CONTINUITY_ACTIVATION_RESPONSE");
    }
    return body.data.activations;
  }

  async enrollRecipientKey(
    identity: {
      principalId: string;
      deviceId: string;
      browserSessionId: string;
      site: "OWNED_FIXTURE";
    },
    encryptionPublicKey: { kty: "OKP"; crv: "X25519"; x: string },
  ): Promise<{ enrolled: boolean }> {
    const sequence = await this.options.sequences.reserveNext(
      identity.deviceId,
      identity.browserSessionId,
      "CONTINUITY_ENROLLMENT",
    );
    const issuedAt = this.now();
    const unsigned = {
      protocolVersion: 1 as const,
      ...identity,
      sequence,
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + 30_000).toISOString(),
      encryptionPublicKey,
    };
    const signature = await signDeviceBytes(
      this.options.signingKey,
      canonicalContinuityRecipientKeyEnrollmentBytes(unsigned),
    );
    const enrollment = continuityRecipientKeyEnrollmentSchema.parse({
      ...unsigned,
      signature: Buffer.from(signature).toString("base64url"),
    });
    const response = await this.postPath(
      "/api/site-session-continuity/recipient-keys",
      enrollment,
    );
    const body = recipientKeyEnrollmentResponseSchema.safeParse(response);
    if (
      !body.success ||
      body.data.deviceId !== identity.deviceId ||
      body.data.browserSessionId !== identity.browserSessionId
    ) {
      throw responseError(
        response,
        "INVALID_CONTINUITY_RECIPIENT_KEY_RESPONSE",
      );
    }
    return { enrolled: body.data.enrolled };
  }

  async publish(
    revision: EncryptedContinuityRevision,
  ): Promise<{ stored: boolean }> {
    const parsed = encryptedContinuityRevisionSchema.parse(revision);
    const response = await this.post(parsed.grantId, "revisions", parsed);
    const body = publishResponseSchema.safeParse(response);
    if (!body.success)
      throw responseError(response, "INVALID_CONTINUITY_PUBLISH_RESPONSE");
    return { stored: body.data.stored };
  }

  async fetchAfter(
    binding: ContinuityBinding,
    afterRevision: number,
  ): Promise<EncryptedContinuityRevision | null> {
    const sequence = await this.options.sequences.reserveNext(
      binding.destinationDeviceId,
      binding.destinationBrowserSessionId,
      "CONTINUITY_MAILBOX",
    );
    const issuedAt = this.now();
    const unsigned = {
      protocolVersion: 1 as const,
      ...binding,
      sequence,
      afterRevision,
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + 30_000).toISOString(),
    };
    const signature = await signDeviceBytes(
      this.options.signingKey,
      canonicalContinuityFetchBytes(unsigned),
    );
    const envelope = continuityFetchEnvelopeSchema.parse({
      ...unsigned,
      signature: Buffer.from(signature).toString("base64url"),
    });
    const response = await this.post(binding.grantId, "fetch", envelope);
    const body = fetchResponseSchema.safeParse(response);
    if (!body.success)
      throw responseError(response, "INVALID_CONTINUITY_FETCH_RESPONSE");
    return body.data.revision;
  }

  async acknowledge(
    binding: ContinuityBinding,
    acknowledgement: { revision: number; digest: string },
  ): Promise<{ acknowledged: boolean }> {
    const sequence = await this.options.sequences.reserveNext(
      binding.destinationDeviceId,
      binding.destinationBrowserSessionId,
      "CONTINUITY_MAILBOX",
    );
    const issuedAt = this.now();
    const unsigned = {
      protocolVersion: 1 as const,
      ...binding,
      sequence,
      revision: acknowledgement.revision,
      digest: acknowledgement.digest,
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + 30_000).toISOString(),
    };
    const signature = await signDeviceBytes(
      this.options.signingKey,
      canonicalContinuityAcknowledgementBytes(unsigned),
    );
    const envelope = continuityAcknowledgementEnvelopeSchema.parse({
      ...unsigned,
      signature: Buffer.from(signature).toString("base64url"),
    });
    const response = await this.post(
      binding.grantId,
      "acknowledgements",
      envelope,
    );
    const body = acknowledgementResponseSchema.safeParse(response);
    if (!body.success) {
      throw responseError(
        response,
        "INVALID_CONTINUITY_ACKNOWLEDGEMENT_RESPONSE",
      );
    }
    return { acknowledged: body.data.acknowledged };
  }

  private async post(
    grantId: string,
    operation: "revisions" | "fetch" | "acknowledgements",
    body: unknown,
  ): Promise<unknown> {
    return this.postPath(
      `/api/site-session-continuity/grants/${grantId}/${operation}`,
      body,
    );
  }

  private async postPath(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error("CONTINUITY_CONTROL_PLANE_TIMEOUT"));
        }, this.timeoutMs);
      });
      const response = await Promise.race([
        this.request(new URL(path, this.options.baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        deadline,
      ]);
      const text = await response.text();
      if (text.length > 196_608) {
        throw new Error("CONTINUITY_CONTROL_PLANE_RESPONSE_TOO_LARGE");
      }
      let candidate: unknown;
      try {
        candidate = JSON.parse(text);
      } catch {
        throw new Error("INVALID_CONTINUITY_CONTROL_PLANE_RESPONSE");
      }
      if (!response.ok)
        throw responseError(candidate, "CONTINUITY_CONTROL_PLANE_REJECTED");
      return candidate;
    } catch (error) {
      if (timedOut || (error instanceof Error && error.name === "AbortError")) {
        throw new Error("CONTINUITY_CONTROL_PLANE_TIMEOUT");
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function responseError(candidate: unknown, fallback: string): Error {
  if (
    candidate &&
    typeof candidate === "object" &&
    "code" in candidate &&
    typeof candidate.code === "string"
  ) {
    return new Error(candidate.code);
  }
  return new Error(fallback);
}
