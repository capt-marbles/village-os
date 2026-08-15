import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FixtureContinuityDestination,
  FixtureContinuitySource,
  LocalContinuityRelay,
  generateContinuityEncryptionKeyPair,
} from "../src/main/site-session-continuity.js";

const binding = {
  principalId: "prn_01J00000000000000000000000",
  grantId: "cgr_01J00000000000000000000000",
  sourceDeviceId: "dev_01J00000000000000000000001",
  destinationDeviceId: "dev_01J00000000000000000000002",
  sourceBrowserSessionId: "brs_01J00000000000000000000001",
  destinationBrowserSessionId: "brs_01J00000000000000000000002",
  site: "OWNED_FIXTURE" as const,
};

const sessionCookie = {
  name: "fixture_session",
  value: "source-only-cookie-value",
  domain: "fixture.village.test",
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax" as const,
  expirationDate: 1_800_000_000,
  hostOnly: true,
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("restart-safe fixture Site Session transfer", () => {
  it("reuses a pending encrypted revision after network loss and never journals plaintext", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-source-continuity-"));
    roots.push(root);
    const signing = await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ]);
    const destinationKeys = await generateContinuityEncryptionKeyPair();
    const relay = new LocalContinuityRelay();
    let failOnce = true;
    const publish = vi.fn(async (revision: unknown) => {
      const result = await relay.publish(revision);
      if (failOnce) {
        failOnce = false;
        throw new Error("SIMULATED_RESPONSE_LOSS");
      }
      return result;
    });
    const options = {
      binding,
      journalPath: join(root, "source.json"),
      cookieStore: { get: vi.fn(async () => [sessionCookie]) },
      sourceSigningKey: signing.privateKey,
      destinationEncryptionKey: destinationKeys.publicKey,
      publish,
      now: () => Date.parse("2026-08-15T20:00:00.000Z"),
    };

    await expect(
      new FixtureContinuitySource(options).publishCurrent(),
    ).rejects.toThrow("SIMULATED_RESPONSE_LOSS");
    const pending = JSON.parse(await readFile(options.journalPath, "utf8"));
    expect(JSON.stringify(pending)).not.toContain(sessionCookie.value);

    await expect(
      new FixtureContinuitySource(options).publishCurrent(),
    ).resolves.toMatchObject({ revision: 1, stored: false });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0]![0]).toEqual(publish.mock.calls[1]![0]);
  });

  it("applies, acknowledges, survives restart, and propagates source logout exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-transfer-continuity-"));
    roots.push(root);
    const signing = await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ]);
    const destinationKeys = await generateContinuityEncryptionKeyPair();
    const relay = new LocalContinuityRelay();
    let sourceCookies = [sessionCookie];
    const sourceOptions = {
      binding,
      journalPath: join(root, "source.json"),
      cookieStore: { get: vi.fn(async () => sourceCookies) },
      sourceSigningKey: signing.privateKey,
      destinationEncryptionKey: destinationKeys.publicKey,
      publish: (revision: unknown) => relay.publish(revision),
      now: () => Date.parse("2026-08-15T20:00:00.000Z"),
    };
    const calls: string[] = [];
    const destinationOptions = {
      binding,
      journalPath: join(root, "destination.json"),
      cookieStore: {
        set: vi.fn(async () => calls.push("set")),
        remove: vi.fn(async () => calls.push("remove")),
        flushStore: vi.fn(async () => calls.push("flush")),
      },
      sourceSigningKey: signing.publicKey,
      destinationEncryptionKey: destinationKeys.privateKey,
      now: () => Date.parse("2026-08-15T20:00:00.000Z"),
    };

    await new FixtureContinuitySource(sourceOptions).publishCurrent();
    const firstDestination = new FixtureContinuityDestination(
      destinationOptions,
    );
    const firstRevision = await relay.fetchAfter(binding, 0);
    const firstAck = await firstDestination.apply(firstRevision);
    await relay.acknowledge(firstAck);
    expect(await firstDestination.current()).toMatchObject({ revision: 1 });

    const restarted = new FixtureContinuityDestination(destinationOptions);
    expect(await restarted.current()).toMatchObject({ revision: 1 });
    expect(await relay.fetchAfter(binding, 1)).toBeNull();

    sourceCookies = [];
    await new FixtureContinuitySource(sourceOptions).publishCurrent();
    const logoutRevision = await relay.fetchAfter(binding, 1);
    const logoutAck = await restarted.apply(logoutRevision);
    await relay.acknowledge(logoutAck);
    expect(calls).toEqual(["set", "flush", "remove", "flush"]);
    expect(await restarted.current()).toMatchObject({ revision: 2 });
  });
});
