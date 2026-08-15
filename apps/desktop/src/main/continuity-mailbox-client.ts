import {
  canonicalContinuityAcknowledgementBytes,
  canonicalContinuityFetchBytes,
  continuityAcknowledgementEnvelopeSchema,
  continuityFetchEnvelopeSchema,
  encryptedContinuityRevisionSchema,
  type ContinuityBinding,
  type EncryptedContinuityRevision,
} from "@village/contracts";
import { z } from "zod";

interface ContinuitySequenceStore {
  reserveNext(deviceId: string, browserSessionId: string): Promise<number>;
}

interface ContinuityMailboxClientOptions {
  baseUrl: URL;
  privateKey: CryptoKey;
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

  async publish(
    revision: EncryptedContinuityRevision,
  ): Promise<{ stored: boolean }> {
    const parsed = encryptedContinuityRevisionSchema.parse(revision);
    const response = await this.post(parsed.grantId, "revisions", parsed);
    const body = publishResponseSchema.safeParse(response);
    if (!body.success) throw responseError(response, "INVALID_CONTINUITY_PUBLISH_RESPONSE");
    return { stored: body.data.stored };
  }

  async fetchAfter(
    binding: ContinuityBinding,
    afterRevision: number,
  ): Promise<EncryptedContinuityRevision | null> {
    const sequence = await this.options.sequences.reserveNext(
      binding.destinationDeviceId,
      binding.destinationBrowserSessionId,
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
    const signature = await crypto.subtle.sign(
      "Ed25519",
      this.options.privateKey,
      canonicalContinuityFetchBytes(unsigned),
    );
    const envelope = continuityFetchEnvelopeSchema.parse({
      ...unsigned,
      signature: Buffer.from(signature).toString("base64url"),
    });
    const response = await this.post(binding.grantId, "fetch", envelope);
    const body = fetchResponseSchema.safeParse(response);
    if (!body.success) throw responseError(response, "INVALID_CONTINUITY_FETCH_RESPONSE");
    return body.data.revision;
  }

  async acknowledge(
    binding: ContinuityBinding,
    acknowledgement: { revision: number; digest: string },
  ): Promise<{ acknowledged: boolean }> {
    const sequence = await this.options.sequences.reserveNext(
      binding.destinationDeviceId,
      binding.destinationBrowserSessionId,
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
    const signature = await crypto.subtle.sign(
      "Ed25519",
      this.options.privateKey,
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
      throw responseError(response, "INVALID_CONTINUITY_ACKNOWLEDGEMENT_RESPONSE");
    }
    return { acknowledged: body.data.acknowledged };
  }

  private async post(
    grantId: string,
    operation: "revisions" | "fetch" | "acknowledgements",
    body: unknown,
  ): Promise<unknown> {
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
        this.request(
          new URL(
            `/api/site-session-continuity/grants/${grantId}/${operation}`,
            this.options.baseUrl,
          ),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
        ),
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
      if (!response.ok) throw responseError(candidate, "CONTINUITY_CONTROL_PLANE_REJECTED");
      return candidate;
    } catch (error) {
      if (
        timedOut ||
        (error instanceof Error && error.name === "AbortError")
      ) {
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
