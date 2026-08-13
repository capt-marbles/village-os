import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialBroker,
  type CredentialDestination,
  type CredentialFillBinding,
} from "../src/secrets/credential-broker.js";
import {
  SecretVault,
  type SecretEncryptionProvider,
} from "../src/secrets/secret-vault.js";

class TestEncryptionProvider implements SecretEncryptionProvider {
  constructor(
    private readonly state = {
      available: true,
      backend: "test-keychain",
      secure: true,
    },
  ) {}
  async availability() {
    return this.state;
  }
  async encrypt(value: string) {
    return new TextEncoder().encode(`encrypted:${value}`);
  }
  async decrypt(value: Uint8Array) {
    const encoded = new TextDecoder().decode(value);
    if (!encoded.startsWith("encrypted:")) throw new Error("bad ciphertext");
    return { value: encoded.slice(10), shouldReEncrypt: false };
  }
}

class FailingEncryptionProvider extends TestEncryptionProvider {
  failNext = false;
  override async encrypt(value: string) {
    if (this.failNext) throw new Error("simulated protection write failure");
    return super.encrypt(value);
  }
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup(
  provider: SecretEncryptionProvider = new TestEncryptionProvider(),
) {
  const directory = await mkdtemp(join(tmpdir(), "village-secret-vault-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "secrets.json");
  const vault = new SecretVault(path, provider);
  await vault.store(
    "sec_fixture_primary",
    Buffer.from("correct horse battery staple"),
  );
  const binding: CredentialFillBinding = {
    principalId: "prn_01J00000000000000000000000",
    deviceId: "dev_01J00000000000000000000000",
    jobId: "job_01J00000000000000000000000",
    browserSessionId: "brs_01J00000000000000000000000",
    actionId: "act_01J00000000000000000000000",
    leaseEpoch: 7,
    exactOrigin: "https://fixture.village.test",
    documentId: "doc_01J00000000000000000000000",
    mainFrameId: "frm_01J00000000000000000000000",
    nodeId: "nod_01J00000000000000000000000",
    fieldSemantic: "PASSWORD",
    secretRef: "sec_fixture_primary",
    site: "OWNED_FIXTURE",
  };
  let current = { ...binding };
  const writes: string[] = [];
  const retainedPlaintexts: Uint8Array[] = [];
  const destination: CredentialDestination = {
    async inspectApprovedFixtureField() {
      return {
        ...current,
        approved: true,
        visible: true,
        enabled: true,
        obscured: false,
      };
    },
    async writeApprovedFixtureField(request) {
      retainedPlaintexts.push(request.plaintext);
      writes.push(new TextDecoder().decode(request.plaintext));
    },
  };
  let now = 1_000;
  const broker = new CredentialBroker(
    vault,
    destination,
    { confirmCredentialUse: async () => true },
    () => now,
  );
  return {
    path,
    vault,
    binding,
    writes,
    retainedPlaintexts,
    broker,
    setCurrent(update: Partial<CredentialFillBinding>) {
      current = { ...current, ...update };
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("SecretVault", () => {
  it("owns encrypted versioned persistence, rotation, revocation, and permissions", async () => {
    const context = await setup();
    const raw = await readFile(context.path, "utf8");
    expect(raw).not.toContain("correct horse battery staple");
    expect(JSON.parse(raw)).toMatchObject({ schemaVersion: 1 });
    if (process.platform !== "win32") {
      const metadata = await stat(context.path);
      expect(metadata.mode & 0o777).toBe(0o600);
    }
    expect(await context.vault.configured("sec_fixture_primary")).toEqual({
      configured: true,
      version: 1,
    });
    await context.vault.store(
      "sec_fixture_primary",
      Buffer.from("rotated-secret"),
    );
    expect(await context.vault.configured("sec_fixture_primary")).toEqual({
      configured: true,
      version: 2,
    });
    await context.vault.revoke("sec_fixture_primary");
    expect(await context.vault.configured("sec_fixture_primary")).toEqual({
      configured: false,
    });
  });

  it("serializes concurrent mutations without losing stored credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-secret-vault-"));
    temporaryDirectories.push(directory);
    const vault = new SecretVault(
      join(directory, "secrets.json"),
      new TestEncryptionProvider(),
    );
    await Promise.all([
      vault.store("sec_fixture_first", Buffer.from("first-secret")),
      vault.store("sec_fixture_second", Buffer.from("second-secret")),
    ]);
    await expect(vault.configured("sec_fixture_first")).resolves.toEqual({
      configured: true,
      version: 1,
    });
    await expect(vault.configured("sec_fixture_second")).resolves.toEqual({
      configured: true,
      version: 1,
    });
  });

  it("takes ownership of and clears the plaintext input buffer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-secret-vault-"));
    temporaryDirectories.push(directory);
    const plaintext = Buffer.from("clear-this-input");
    const vault = new SecretVault(
      join(directory, "secrets.json"),
      new TestEncryptionProvider(),
    );
    await vault.store("sec_fixture_primary", plaintext);
    expect([...plaintext]).toEqual(Array(16).fill(0));
  });

  it("preserves the prior version when protection fails during overwrite", async () => {
    const provider = new FailingEncryptionProvider();
    const context = await setup(provider);
    provider.failNext = true;
    await expect(
      context.vault.store("sec_fixture_primary", Buffer.from("must-not-land")),
    ).rejects.toThrow("simulated protection write failure");
    await expect(
      context.vault.withSecret("sec_fixture_primary", async (plaintext) =>
        new TextDecoder().decode(plaintext),
      ),
    ).resolves.toBe("correct horse battery staple");
    expect(await context.vault.configured("sec_fixture_primary")).toEqual({
      configured: true,
      version: 1,
    });
  });

  it("fails closed for unsafe protection, corrupt storage, and broad permissions", async () => {
    const insecure = await setup(
      new TestEncryptionProvider({
        available: true,
        backend: "basic_text",
        secure: false,
      }),
    ).catch((error: unknown) => error);
    expect(insecure).toMatchObject({
      message: "SECURE_SECRET_STORAGE_UNAVAILABLE",
    });

    const context = await setup();
    await writeFile(context.path, "not-json", { mode: 0o600 });
    await expect(
      context.vault.configured("sec_fixture_primary"),
    ).rejects.toThrow("SECRET_VAULT_CORRUPT");
    if (process.platform !== "win32") {
      await chmod(context.path, 0o644);
      await expect(
        context.vault.configured("sec_fixture_primary"),
      ).rejects.toThrow("SECRET_VAULT_PERMISSIONS_TOO_BROAD");
    }
  });
});

describe("one-use credential broker", () => {
  it("fills the approved owned fixture field once and rejects replay", async () => {
    const context = await setup();
    const consent = await context.broker.authorize(context.binding, 5_000);
    await expect(
      context.broker.fill(consent.authorizationId, context.binding),
    ).resolves.toEqual({
      ok: true,
    });
    expect(context.writes).toEqual(["correct horse battery staple"]);
    expect([...context.retainedPlaintexts[0]!]).toEqual(Array(28).fill(0));
    await expect(
      context.broker.fill(consent.authorizationId, context.binding),
    ).resolves.toEqual({
      ok: false,
      code: "AUTHORIZATION_REPLAYED",
    });
  });

  it("rejects expiry and every authorization binding mismatch", async () => {
    const mismatchCases: Array<[keyof CredentialFillBinding, unknown]> = [
      ["principalId", "prn_01J11111111111111111111111"],
      ["deviceId", "dev_01J11111111111111111111111"],
      ["jobId", "job_01J11111111111111111111111"],
      ["browserSessionId", "brs_01J11111111111111111111111"],
      ["actionId", "act_01J11111111111111111111111"],
      ["leaseEpoch", 8],
      ["exactOrigin", "https://evil.example"],
      ["documentId", "doc_01J11111111111111111111111"],
      ["mainFrameId", "frm_01J11111111111111111111111"],
      ["nodeId", "nod_01J11111111111111111111111"],
      ["fieldSemantic", "USERNAME"],
      ["secretRef", "sec_other"],
      ["site", "LINKEDIN"],
    ];
    for (const [key, value] of mismatchCases) {
      const context = await setup();
      const consent = await context.broker.authorize(context.binding, 5_000);
      const changed = {
        ...context.binding,
        [key]: value,
      } as CredentialFillBinding;
      await expect(
        context.broker.fill(consent.authorizationId, changed),
      ).resolves.toEqual({
        ok: false,
        code: "AUTHORIZATION_BINDING_MISMATCH",
      });
    }
    const expired = await setup();
    const consent = await expired.broker.authorize(expired.binding, 5_000);
    expired.advance(5_001);
    await expect(
      expired.broker.fill(consent.authorizationId, expired.binding),
    ).resolves.toEqual({
      ok: false,
      code: "AUTHORIZATION_EXPIRED",
    });
  });

  it("revalidates navigation, document, node, field, frame, takeover, and revocation before write", async () => {
    const mutations: Partial<CredentialFillBinding>[] = [
      { exactOrigin: "https://evil.example" },
      { documentId: "doc_01J11111111111111111111111" },
      { nodeId: "nod_01J11111111111111111111111" },
      { fieldSemantic: "USERNAME" as "PASSWORD" },
      { mainFrameId: "frm_01J11111111111111111111111" },
      { leaseEpoch: 8 },
    ];
    for (const mutation of mutations) {
      const context = await setup();
      const consent = await context.broker.authorize(context.binding, 5_000);
      context.setCurrent(mutation);
      const result = await context.broker.fill(
        consent.authorizationId,
        context.binding,
      );
      expect(result).toEqual({
        ok: false,
        code: "DESTINATION_BINDING_MISMATCH",
      });
      expect(context.writes).toEqual([]);
    }
    const overlay = await setup();
    const overlayDestination: CredentialDestination = {
      inspectApprovedFixtureField: async () => ({
        ...overlay.binding,
        approved: true,
        visible: true,
        enabled: true,
        obscured: true,
      }),
      writeApprovedFixtureField: async () => {
        throw new Error("must not write through overlay");
      },
    };
    const overlayBroker = new CredentialBroker(
      overlay.vault,
      overlayDestination,
      { confirmCredentialUse: async () => true },
      () => 1_000,
    );
    const brokerConsent = await overlayBroker.authorize(overlay.binding, 5_000);
    await expect(
      overlayBroker.fill(brokerConsent.authorizationId, overlay.binding),
    ).resolves.toEqual({
      ok: false,
      code: "DESTINATION_BINDING_MISMATCH",
    });
    const revoked = await setup();
    const consent = await revoked.broker.authorize(revoked.binding, 5_000);
    await revoked.vault.revoke(revoked.binding.secretRef);
    await expect(
      revoked.broker.fill(consent.authorizationId, revoked.binding),
    ).resolves.toEqual({
      ok: false,
      code: "SECRET_REVOKED",
    });
  });

  it("invalidates outstanding consent on lifecycle changes and consumes consent after write failure", async () => {
    for (const invalidate of [
      (context: Awaited<ReturnType<typeof setup>>) =>
        context.broker.invalidateForNavigation(
          context.binding.browserSessionId,
        ),
      (context: Awaited<ReturnType<typeof setup>>) =>
        context.broker.invalidateForDocumentReplacement(
          context.binding.browserSessionId,
          context.binding.documentId,
        ),
      (context: Awaited<ReturnType<typeof setup>>) =>
        context.broker.invalidateForNodeReplacement(
          context.binding.browserSessionId,
          context.binding.nodeId,
        ),
      (context: Awaited<ReturnType<typeof setup>>) =>
        context.broker.invalidateForTakeover(context.binding.browserSessionId),
    ]) {
      const context = await setup();
      const consent = await context.broker.authorize(context.binding, 5_000);
      invalidate(context);
      await expect(
        context.broker.fill(consent.authorizationId, context.binding),
      ).resolves.toEqual({
        ok: false,
        code: "AUTHORIZATION_INVALIDATED",
      });
    }

    const failed = await setup();
    const broker = new CredentialBroker(
      failed.vault,
      {
        inspectApprovedFixtureField: async () => ({
          ...failed.binding,
          approved: true,
          visible: true,
          enabled: true,
          obscured: false,
        }),
        writeApprovedFixtureField: async () => {
          throw new Error("renderer crashed");
        },
      },
      { confirmCredentialUse: async () => true },
      () => 1_000,
    );
    const failedConsent = await broker.authorize(failed.binding, 5_000);
    await expect(
      broker.fill(failedConsent.authorizationId, failed.binding),
    ).resolves.toEqual({
      ok: false,
      code: "DESTINATION_WRITE_FAILED",
    });
    await expect(
      broker.fill(failedConsent.authorizationId, failed.binding),
    ).resolves.toEqual({
      ok: false,
      code: "AUTHORIZATION_REPLAYED",
    });
  });

  it("does not mint authorization when the main-process prompt declines", async () => {
    const context = await setup();
    const broker = new CredentialBroker(
      context.vault,
      {
        inspectApprovedFixtureField: async () => ({
          ...context.binding,
          approved: true,
          visible: true,
          enabled: true,
          obscured: false,
        }),
        writeApprovedFixtureField: async () => {
          throw new Error("must not write");
        },
      },
      { confirmCredentialUse: async () => false },
      () => 1_000,
    );
    await expect(broker.authorize(context.binding, 5_000)).rejects.toThrow(
      "CREDENTIAL_USE_DECLINED",
    );
  });
});
