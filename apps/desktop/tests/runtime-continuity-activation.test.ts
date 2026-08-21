import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContinuityActivation,
  EncryptedContinuityRevision,
} from "@village/contracts";
import { RuntimeContinuityActivation } from "../src/main/runtime-continuity-activation.js";

const binding = {
  principalId: "prn_01J00000000000000000000000",
  grantId: "cgr_01J00000000000000000000000",
  sourceDeviceId: "dev_01J00000000000000000000001",
  destinationDeviceId: "dev_01J00000000000000000000002",
  sourceBrowserSessionId: "brs_01J00000000000000000000001",
  destinationBrowserSessionId: "brs_01J00000000000000000000002",
  site: "OWNED_FIXTURE" as const,
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("runtime fixture continuity activation", () => {
  it("publishes, applies, acknowledges, and resumes without duplicate effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-runtime-continuity-"));
    roots.push(root);
    const signing = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const encryption = (await crypto.subtle.generateKey("X25519", true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const signingJwk = await crypto.subtle.exportKey("jwk", signing.publicKey);
    const encryptionJwk = await crypto.subtle.exportKey(
      "jwk",
      encryption.publicKey,
    );
    let revision: EncryptedContinuityRevision | null = null;
    const acknowledged = vi.fn(async () => ({ acknowledged: true }));
    const sourceActivation: ContinuityActivation = {
      role: "SOURCE",
      binding,
      peerSigningPublicKey: {
        kty: "OKP",
        crv: "Ed25519",
        x: signingJwk.x!,
      },
      destinationEncryptionPublicKey: {
        kty: "OKP",
        crv: "X25519",
        x: encryptionJwk.x!,
      },
    };
    const destinationActivation: ContinuityActivation = {
      role: "DESTINATION",
      binding,
      peerSigningPublicKey: {
        kty: "OKP",
        crv: "Ed25519",
        x: signingJwk.x!,
      },
    };
    const mailbox = {
      loadActivations: vi.fn(),
      publish: vi.fn(async (candidate: EncryptedContinuityRevision) => {
        revision = candidate;
        return { stored: true };
      }),
      fetchAfter: vi.fn(async (_binding: typeof binding, after: number) =>
        revision && revision.revision > after ? revision : null,
      ),
      acknowledge: acknowledged,
    };
    const source = new RuntimeContinuityActivation({
      identity: {
        principalId: binding.principalId,
        deviceId: binding.sourceDeviceId,
        browserSessionId: binding.sourceBrowserSessionId,
        site: binding.site,
      },
      journalRoot: join(root, "source"),
      deviceSigningKey: signing.privateKey,
      recipientPrivateKey: encryption.privateKey,
      cookieStore: {
        get: vi.fn(async () => [
          {
            name: "fixture_session",
            value: "source-session",
            domain: "fixture.village.test",
            hostOnly: true,
            path: "/",
            secure: true,
            httpOnly: true,
            session: false,
            sameSite: "lax" as const,
            expirationDate: 1_800_000_000,
          },
        ]),
        set: vi.fn(),
        remove: vi.fn(),
        flushStore: vi.fn(),
      },
      mailbox: {
        ...mailbox,
        loadActivations: vi.fn(async () => [sourceActivation]),
      },
      now: () => Date.parse("2026-08-15T20:00:00.000Z"),
    });
    await expect(source.synchronize()).resolves.toMatchObject({
      role: "SOURCE",
      published: 1,
    });

    const destinationCookies = {
      get: vi.fn(async () => []),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      flushStore: vi.fn(async () => undefined),
    };
    const destinationOptions = {
      identity: {
        principalId: binding.principalId,
        deviceId: binding.destinationDeviceId,
        browserSessionId: binding.destinationBrowserSessionId,
        site: binding.site,
      },
      journalRoot: join(root, "destination"),
      deviceSigningKey: signing.privateKey,
      recipientPrivateKey: encryption.privateKey,
      cookieStore: destinationCookies,
      mailbox: {
        ...mailbox,
        loadActivations: vi.fn(async () => [destinationActivation]),
      },
      now: () => Date.parse("2026-08-15T20:01:00.000Z"),
    };
    await expect(
      new RuntimeContinuityActivation(destinationOptions).synchronize(),
    ).resolves.toMatchObject({ role: "DESTINATION", applied: 1 });
    expect(destinationCookies.set).toHaveBeenCalledTimes(1);
    expect(acknowledged).toHaveBeenCalledTimes(1);

    await expect(
      new RuntimeContinuityActivation(destinationOptions).synchronize(),
    ).resolves.toMatchObject({ role: "DESTINATION", applied: 0 });
    expect(destinationCookies.set).toHaveBeenCalledTimes(1);
    expect(acknowledged).toHaveBeenCalledTimes(2);
  });

  it("fails closed when more than one active grant targets the profile", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ]);
    const activation = {
      role: "DESTINATION" as const,
      binding,
      peerSigningPublicKey: {
        kty: "OKP" as const,
        crv: "Ed25519" as const,
        x: "s".repeat(43),
      },
    };
    const runtime = new RuntimeContinuityActivation({
      identity: {
        principalId: binding.principalId,
        deviceId: binding.destinationDeviceId,
        browserSessionId: binding.destinationBrowserSessionId,
        site: binding.site,
      },
      journalRoot: "/unused",
      deviceSigningKey: keys.privateKey,
      recipientPrivateKey: keys.privateKey,
      cookieStore: {
        get: vi.fn(),
        set: vi.fn(),
        remove: vi.fn(),
        flushStore: vi.fn(),
      },
      mailbox: {
        loadActivations: vi.fn(async () => [activation, activation]),
        publish: vi.fn(),
        fetchAfter: vi.fn(),
        acknowledge: vi.fn(),
      },
    });
    await expect(runtime.synchronize()).rejects.toThrow(
      "MULTIPLE_CONTINUITY_GRANTS_OWNER_RECOVERY_REQUIRED",
    );
  });
});
