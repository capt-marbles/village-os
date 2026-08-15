import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FixtureContinuityDestination,
  LocalContinuityRelay,
  createEncryptedFixtureRevision,
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
  value: "owner-only-session-value",
  domain: "fixture.village.test" as const,
  path: "/",
  secure: true as const,
  httpOnly: true,
  sameSite: "lax" as const,
  expirationDate: 1_800_000_000,
  hostOnly: true,
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "village-continuity-"));
  roots.push(root);
  const sourceSigningKeys = await crypto.subtle.generateKey("Ed25519", false, [
    "sign",
    "verify",
  ]);
  const destinationEncryptionKeys = await generateContinuityEncryptionKeyPair();
  const calls: string[] = [];
  const cookieStore = {
    set: vi.fn(async () => {
      calls.push("set");
    }),
    remove: vi.fn(async () => {
      calls.push("remove");
    }),
    flushStore: vi.fn(async () => {
      calls.push("flush");
    }),
  };
  const options = {
    binding,
    journalPath: join(root, "continuity", "fixture.json"),
    cookieStore,
    sourceSigningKey: sourceSigningKeys.publicKey,
    destinationEncryptionKey: destinationEncryptionKeys.privateKey,
    now: () => Date.parse("2026-08-15T19:01:00.000Z"),
  };
  return {
    root,
    sourceSigningKeys,
    destinationEncryptionKeys,
    cookieStore,
    calls,
    options,
    destination: new FixtureContinuityDestination(options),
  };
}

describe("authoritative fixture Site Session destination", () => {
  it("applies a snapshot, propagates logout, and acks only after flush", async () => {
    const setup = await harness();
    const relay = new LocalContinuityRelay();
    const first = await createEncryptedFixtureRevision({
      binding,
      revision: 1,
      previousDigest: null,
      cookies: [sessionCookie],
      issuedAt: "2026-08-15T19:00:00.000Z",
      expiresAt: "2026-08-16T19:00:00.000Z",
      sourceSigningKey: setup.sourceSigningKeys.privateKey,
      destinationEncryptionKey: setup.destinationEncryptionKeys.publicKey,
    });
    const second = await createEncryptedFixtureRevision({
      binding,
      revision: 2,
      previousDigest: first.digest,
      cookies: [],
      issuedAt: "2026-08-15T19:00:30.000Z",
      expiresAt: "2026-08-16T19:00:30.000Z",
      sourceSigningKey: setup.sourceSigningKeys.privateKey,
      destinationEncryptionKey: setup.destinationEncryptionKeys.publicKey,
    });
    await relay.publish(first);
    await relay.publish(second);

    const deliveredFirst = await relay.fetchAfter(binding, 0);
    const firstAck = await setup.destination.apply(deliveredFirst);
    expect(setup.calls).toEqual(["set", "flush"]);
    expect(await relay.acknowledge(firstAck)).toEqual({ acknowledged: true });

    const deliveredSecond = await relay.fetchAfter(binding, 1);
    const secondAck = await setup.destination.apply(deliveredSecond);
    expect(setup.calls).toEqual(["set", "flush", "remove", "flush"]);
    expect(await relay.acknowledge(secondAck)).toEqual({ acknowledged: true });
    expect(setup.cookieStore.remove).toHaveBeenCalledWith(
      "https://fixture.village.test/",
      "fixture_session",
    );
    expect(JSON.stringify(relay.exportState())).not.toContain(
      "owner-only-session-value",
    );
    expect(await relay.fetchAfter(binding, 2)).toBeNull();

    const journal = await readFile(setup.options.journalPath, "utf8");
    expect(journal).not.toContain("owner-only-session-value");
  });

  it("recovers safely when the process dies after flush but before ack", async () => {
    const setup = await harness();
    const relay = new LocalContinuityRelay();
    const revision = await createEncryptedFixtureRevision({
      binding,
      revision: 1,
      previousDigest: null,
      cookies: [sessionCookie],
      issuedAt: "2026-08-15T19:00:00.000Z",
      expiresAt: "2026-08-16T19:00:00.000Z",
      sourceSigningKey: setup.sourceSigningKeys.privateKey,
      destinationEncryptionKey: setup.destinationEncryptionKeys.publicKey,
    });
    await relay.publish(revision);
    const delivered = await relay.fetchAfter(binding, 0);
    const ack = await setup.destination.apply(delivered);

    const restarted = new FixtureContinuityDestination(setup.options);
    await expect(restarted.apply(delivered)).resolves.toEqual(ack);
    expect(setup.cookieStore.set).toHaveBeenCalledOnce();
    expect(setup.cookieStore.flushStore).toHaveBeenCalledOnce();
    expect(await relay.acknowledge(ack)).toEqual({ acknowledged: true });
    expect(await relay.acknowledge(ack)).toEqual({ acknowledged: false });
  });

  it("fails closed on a corrupt destination journal before touching cookies", async () => {
    const setup = await harness();
    await mkdir(join(setup.root, "continuity"), { mode: 0o700 });
    await writeFile(setup.options.journalPath, "not-json", { mode: 0o600 });
    await chmod(setup.options.journalPath, 0o600);
    const revision = await createEncryptedFixtureRevision({
      binding,
      revision: 1,
      previousDigest: null,
      cookies: [sessionCookie],
      issuedAt: "2026-08-15T19:00:00.000Z",
      expiresAt: "2026-08-16T19:00:00.000Z",
      sourceSigningKey: setup.sourceSigningKeys.privateKey,
      destinationEncryptionKey: setup.destinationEncryptionKeys.publicKey,
    });

    await expect(setup.destination.apply(revision)).rejects.toThrow(
      "CONTINUITY_JOURNAL_CORRUPT",
    );
    expect(setup.cookieStore.set).not.toHaveBeenCalled();
    expect(setup.cookieStore.remove).not.toHaveBeenCalled();
    expect(setup.cookieStore.flushStore).not.toHaveBeenCalled();
  });
});
