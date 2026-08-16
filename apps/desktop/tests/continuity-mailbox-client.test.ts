import {
  canonicalContinuityActivationRequestBytes,
  canonicalContinuityAcknowledgementBytes,
  canonicalContinuityFetchBytes,
  canonicalContinuityRecipientKeyEnrollmentBytes,
  continuityAcknowledgementEnvelopeSchema,
  continuityActivationRequestSchema,
  continuityFetchEnvelopeSchema,
  continuityRecipientKeyEnrollmentSchema,
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
  it("signs activation discovery and validates role-scoped public material", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ]);
    let candidate: unknown;
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      candidate = JSON.parse(String(init?.body));
      return Response.json({
        ok: true,
        activations: [
          {
            role: "DESTINATION",
            binding,
            peerSigningPublicKey: {
              kty: "OKP",
              crv: "Ed25519",
              x: "s".repeat(43),
            },
          },
        ],
      });
    });
    const client = new ContinuityMailboxClient({
      baseUrl: new URL("https://village.test"),
      privateKey: keys.privateKey,
      sequences: { reserveNext: async () => 7 },
      request,
      now: () => Date.parse("2026-08-15T20:00:00.000Z"),
    });

    await expect(
      client.loadActivations({
        principalId: binding.principalId,
        deviceId: binding.destinationDeviceId,
        browserSessionId: binding.destinationBrowserSessionId,
        site: binding.site,
      }),
    ).resolves.toMatchObject([{ role: "DESTINATION", binding }]);

    const activation = continuityActivationRequestSchema.parse(candidate);
    const { signature, ...unsigned } = activation;
    await expect(
      crypto.subtle.verify(
        "Ed25519",
        keys.publicKey,
        Buffer.from(signature, "base64url"),
        canonicalContinuityActivationRequestBytes(unsigned),
      ),
    ).resolves.toBe(true);
    expect(String(request.mock.calls[0]![0])).toBe(
      "https://village.test/api/site-session-continuity/activations",
    );
  });

  it("signs recipient-key enrollment for the paired destination session", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ]);
    let candidate: unknown;
    let sequence = 0;
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      candidate = JSON.parse(String(init?.body));
      return Response.json({
        ok: true,
        enrolled: true,
        deviceId: binding.destinationDeviceId,
        browserSessionId: binding.destinationBrowserSessionId,
      });
    });
    const client = new ContinuityMailboxClient({
      baseUrl: new URL("https://village.test"),
      privateKey: keys.privateKey,
      sequences: { reserveNext: async () => ++sequence },
      request,
      now: () => Date.parse("2026-08-15T20:00:00.000Z"),
    });

    await expect(
      client.enrollRecipientKey(
        {
          principalId: binding.principalId,
          deviceId: binding.destinationDeviceId,
          browserSessionId: binding.destinationBrowserSessionId,
          site: binding.site,
        },
        { kty: "OKP", crv: "X25519", x: "x".repeat(43) },
      ),
    ).resolves.toEqual({ enrolled: true });

    const enrollment = continuityRecipientKeyEnrollmentSchema.parse(candidate);
    const { signature, ...unsigned } = enrollment;
    await expect(
      crypto.subtle.verify(
        "Ed25519",
        keys.publicKey,
        Buffer.from(signature, "base64url"),
        canonicalContinuityRecipientKeyEnrollmentBytes(unsigned),
      ),
    ).resolves.toBe(true);
    expect(String(request.mock.calls[0]![0])).toBe(
      "https://village.test/api/site-session-continuity/recipient-keys",
    );
  });

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

    const fetchEnvelope = continuityFetchEnvelopeSchema.parse(
      requests[0]!.body,
    );
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

  it("keeps activation discovery and mailbox mutation sequence spaces independent", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ]);
    const sequences = new Map<string, number>();
    const observed: unknown[] = [];
    const client = new ContinuityMailboxClient({
      baseUrl: new URL("https://village.test"),
      privateKey: keys.privateKey,
      sequences: {
        reserveNext: async (_deviceId, _browserSessionId, scope) => {
          const next = (sequences.get(scope) ?? 0) + 1;
          sequences.set(scope, next);
          return next;
        },
      },
      request: vi.fn(async (_input, init) => {
        observed.push(JSON.parse(String(init?.body)));
        return observed.length === 1
          ? Response.json({ ok: true, activations: [] })
          : Response.json({ ok: true, revision: null });
      }),
    });

    await client.loadActivations({
      principalId: binding.principalId,
      deviceId: binding.destinationDeviceId,
      browserSessionId: binding.destinationBrowserSessionId,
      site: binding.site,
    });
    await client.fetchAfter(binding, 0);

    expect(continuityActivationRequestSchema.parse(observed[0]).sequence).toBe(
      1,
    );
    expect(continuityFetchEnvelopeSchema.parse(observed[1]).sequence).toBe(1);
    expect([...sequences.keys()]).toEqual([
      "CONTINUITY_ACTIVATION",
      "CONTINUITY_MAILBOX",
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
