import {
  canonicalContinuityAcknowledgementBytes,
  canonicalContinuityFetchBytes,
  continuityAcknowledgementEnvelopeSchema,
  continuityFetchEnvelopeSchema,
} from "@village/contracts";
import { describe, expect, it, vi } from "vitest";
import { ContinuityMailboxClient } from "../src/main/continuity-mailbox-client.js";

const binding = {
  principalId: "prn_01J00000000000000000000000",
  grantId: "cgr_01J00000000000000000000000",
  sourceDeviceId: "dev_01J00000000000000000000001",
  destinationDeviceId: "dev_01J00000000000000000000002",
  sourceBrowserSessionId: "brs_01J00000000000000000000001",
  destinationBrowserSessionId: "brs_01J00000000000000000000002",
  site: "OWNED_FIXTURE" as const,
};

describe("desktop encrypted continuity mailbox client", () => {
  it("signs destination fetch and acknowledgement requests with monotonic sequences", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ]);
    const requests: { url: string; body: unknown }[] = [];
    const request = vi.fn<typeof fetch>(async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json(
        requests.length === 1
          ? { ok: true, revision: null }
          : { ok: true, acknowledged: true },
      );
    });
    let sequence = 0;
    const client = new ContinuityMailboxClient({
      baseUrl: new URL("https://village.test"),
      privateKey: keys.privateKey,
      sequences: { reserveNext: async () => ++sequence },
      request,
      now: () => Date.parse("2026-08-15T20:00:00.000Z"),
    });

    await expect(client.fetchAfter(binding, 4)).resolves.toBeNull();
    await expect(
      client.acknowledge(binding, {
        revision: 5,
        digest: "a".repeat(64),
      }),
    ).resolves.toEqual({ acknowledged: true });

    const fetchEnvelope = continuityFetchEnvelopeSchema.parse(requests[0]!.body);
    const { signature: fetchSignature, ...unsignedFetch } = fetchEnvelope;
    await expect(
      crypto.subtle.verify(
        "Ed25519",
        keys.publicKey,
        Buffer.from(fetchSignature, "base64url"),
        canonicalContinuityFetchBytes(unsignedFetch),
      ),
    ).resolves.toBe(true);
    expect(fetchEnvelope).toMatchObject({
      ...binding,
      sequence: 1,
      afterRevision: 4,
      issuedAt: "2026-08-15T20:00:00.000Z",
      expiresAt: "2026-08-15T20:00:30.000Z",
    });

    const ackEnvelope = continuityAcknowledgementEnvelopeSchema.parse(
      requests[1]!.body,
    );
    const { signature: ackSignature, ...unsignedAck } = ackEnvelope;
    await expect(
      crypto.subtle.verify(
        "Ed25519",
        keys.publicKey,
        Buffer.from(ackSignature, "base64url"),
        canonicalContinuityAcknowledgementBytes(unsignedAck),
      ),
    ).resolves.toBe(true);
    expect(ackEnvelope.sequence).toBe(2);
    expect(requests.map(({ url }) => url)).toEqual([
      `https://village.test/api/site-session-continuity/grants/${binding.grantId}/fetch`,
      `https://village.test/api/site-session-continuity/grants/${binding.grantId}/acknowledgements`,
    ]);
  });

  it("fails closed on unsafe origins, malformed responses, and timeouts", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ]);
    expect(
      () =>
        new ContinuityMailboxClient({
          baseUrl: new URL("http://public.example"),
          privateKey: keys.privateKey,
          sequences: { reserveNext: async () => 1 },
        }),
    ).toThrow("CONTINUITY_CONTROL_PLANE_URL_UNSAFE");

    const malformed = new ContinuityMailboxClient({
      baseUrl: new URL("https://village.test"),
      privateKey: keys.privateKey,
      sequences: { reserveNext: async () => 1 },
      request: vi.fn(async () => Response.json({ ok: true, revision: {} })),
    });
    await expect(malformed.fetchAfter(binding, 0)).rejects.toThrow(
      "INVALID_CONTINUITY_FETCH_RESPONSE",
    );

    const timedOut = new ContinuityMailboxClient({
      baseUrl: new URL("https://village.test"),
      privateKey: keys.privateKey,
      sequences: { reserveNext: async () => 1 },
      request: vi.fn(() => new Promise<Response>(() => undefined)),
      timeoutMs: 5,
    });
    await expect(timedOut.fetchAfter(binding, 0)).rejects.toThrow(
      "CONTINUITY_CONTROL_PLANE_TIMEOUT",
    );
  });
});
