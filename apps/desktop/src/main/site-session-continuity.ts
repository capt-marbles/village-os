import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import {
  browserSessionIdSchema,
  deviceIdSchema,
  principalIdSchema,
} from "@village/contracts";
import type { CookiesSetDetails } from "electron";
import { z } from "zod";

const continuityBindingSchema = z.strictObject({
  principalId: principalIdSchema,
  grantId: z.string().regex(/^cgr_[0-9A-HJKMNP-TV-Z]{26}$/),
  sourceDeviceId: deviceIdSchema,
  destinationDeviceId: deviceIdSchema,
  sourceBrowserSessionId: browserSessionIdSchema,
  destinationBrowserSessionId: browserSessionIdSchema,
  site: z.literal("OWNED_FIXTURE"),
});

const fixtureCookieSchema = z
  .strictObject({
    name: z.string().regex(/^[^\s;=]{1,256}$/),
    value: z.string().max(8_192),
    domain: z.enum(["fixture.village.test", ".fixture.village.test"]),
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

const fixtureSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  cookies: z.array(fixtureCookieSchema).max(64),
});

const x25519PublicKeySchema = z.strictObject({
  kty: z.literal("OKP"),
  crv: z.literal("X25519"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

const encryptedContinuityRevisionSchema = z.strictObject({
  protocolVersion: z.literal(1),
  ...continuityBindingSchema.shape,
  revision: z.number().int().positive(),
  previousDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  issuedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  ephemeralPublicKey: x25519PublicKeySchema,
  salt: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  ciphertext: z.string().min(1).max(131_072),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});

export type ContinuityBinding = z.infer<typeof continuityBindingSchema>;
export type EncryptedContinuityRevision = z.infer<
  typeof encryptedContinuityRevisionSchema
>;
type FixtureCookie = z.infer<typeof fixtureCookieSchema>;

const managedCookieSchema = z.strictObject({
  name: fixtureCookieSchema.shape.name,
  domain: fixtureCookieSchema.shape.domain,
  path: fixtureCookieSchema.shape.path,
  hostOnly: fixtureCookieSchema.shape.hostOnly,
});

const destinationJournalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ...continuityBindingSchema.shape,
  appliedRevision: z.number().int().nonnegative(),
  appliedDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  managedCookies: z.array(managedCookieSchema).max(64),
});

const continuityAcknowledgementSchema = z.strictObject({
  ...continuityBindingSchema.shape,
  revision: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});

export type ContinuityAcknowledgement = z.infer<
  typeof continuityAcknowledgementSchema
>;

interface CreateEncryptedFixtureRevisionInput {
  binding: ContinuityBinding;
  revision: number;
  previousDigest: string | null;
  cookies: readonly FixtureCookie[];
  issuedAt: string;
  expiresAt: string;
  sourceSigningKey: CryptoKey;
  destinationEncryptionKey: CryptoKey;
}

export async function generateContinuityEncryptionKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey("X25519", false, [
    "deriveBits",
  ])) as CryptoKeyPair;
}

export async function createEncryptedFixtureRevision(
  input: CreateEncryptedFixtureRevisionInput,
): Promise<EncryptedContinuityRevision> {
  const binding = continuityBindingSchema.parse(input.binding);
  const snapshot = fixtureSnapshotSchema.parse({
    schemaVersion: 1,
    cookies: input.cookies,
  });
  assertRevisionLifetime(input.issuedAt, input.expiresAt);
  const ephemeral = await generateContinuityEncryptionKeyPair();
  const exportedEphemeralKey = await crypto.subtle.exportKey(
    "jwk",
    ephemeral.publicKey,
  );
  const ephemeralPublicKey = x25519PublicKeySchema.parse({
    kty: exportedEphemeralKey.kty,
    crv: exportedEphemeralKey.crv,
    x: exportedEphemeralKey.x,
  });
  const saltBytes = ownedBytes(crypto.getRandomValues(new Uint8Array(16)));
  const ivBytes = ownedBytes(crypto.getRandomValues(new Uint8Array(12)));
  const associatedData = continuityAssociatedData({
    protocolVersion: 1,
    ...binding,
    revision: input.revision,
    previousDigest: input.previousDigest,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    ephemeralPublicKey,
    salt: encode(saltBytes),
    iv: encode(ivBytes),
  });
  const encryptionKey = await deriveEncryptionKey(
    ephemeral.privateKey,
    input.destinationEncryptionKey,
    saltBytes,
    associatedData,
  );
  const ciphertextBytes = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: ivBytes, additionalData: associatedData },
      encryptionKey,
      ownedBytes(new TextEncoder().encode(JSON.stringify(snapshot))),
    ),
  );
  const unsigned = {
    protocolVersion: 1 as const,
    ...binding,
    revision: z.number().int().positive().parse(input.revision),
    previousDigest: input.previousDigest,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    ephemeralPublicKey,
    salt: encode(saltBytes),
    iv: encode(ivBytes),
    ciphertext: encode(ciphertextBytes),
    digest: await sha256Hex(
      revisionDigestBytes(associatedData, ciphertextBytes),
    ),
  };
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      input.sourceSigningKey,
      revisionSignatureBytes(unsigned),
    ),
  );
  return encryptedContinuityRevisionSchema.parse({
    ...unsigned,
    signature: encode(signature),
  });
}

export async function openEncryptedFixtureRevision(
  candidate: unknown,
  options: {
    binding: ContinuityBinding;
    now: number;
    sourceSigningKey: CryptoKey;
    destinationEncryptionKey: CryptoKey;
  },
): Promise<z.infer<typeof fixtureSnapshotSchema>> {
  const parsed = encryptedContinuityRevisionSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("CONTINUITY_REVISION_INVALID");
  const revision = parsed.data;
  const binding = continuityBindingSchema.parse(options.binding);
  if (!sameBinding(revision, binding)) {
    throw new Error("CONTINUITY_REVISION_BINDING_MISMATCH");
  }
  if (Date.parse(revision.expiresAt) <= options.now) {
    throw new Error("CONTINUITY_REVISION_EXPIRED");
  }
  const { signature, ...unsigned } = revision;
  const verified = await crypto.subtle.verify(
    "Ed25519",
    options.sourceSigningKey,
    decode(signature),
    revisionSignatureBytes(unsigned),
  );
  if (!verified) throw new Error("CONTINUITY_REVISION_UNAUTHENTICATED");
  const associatedData = continuityAssociatedData(unsigned);
  const ciphertext = decode(revision.ciphertext);
  if (
    (await sha256Hex(revisionDigestBytes(associatedData, ciphertext))) !==
    revision.digest
  ) {
    throw new Error("CONTINUITY_REVISION_DIGEST_MISMATCH");
  }

  try {
    const ephemeralPublicKey = await crypto.subtle.importKey(
      "jwk",
      revision.ephemeralPublicKey,
      "X25519",
      false,
      [],
    );
    const encryptionKey = await deriveEncryptionKey(
      options.destinationEncryptionKey,
      ephemeralPublicKey,
      decode(revision.salt),
      associatedData,
    );
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decode(revision.iv),
        additionalData: associatedData,
      },
      encryptionKey,
      ciphertext,
    );
    return fixtureSnapshotSchema.parse(
      JSON.parse(new TextDecoder().decode(plaintext)),
    );
  } catch {
    throw new Error("CONTINUITY_REVISION_DECRYPTION_FAILED");
  }
}

export class LocalContinuityRelay {
  private readonly revisions: EncryptedContinuityRevision[] = [];
  private acknowledgedRevision = 0;

  async publish(candidate: unknown): Promise<{ stored: boolean }> {
    const parsed = encryptedContinuityRevisionSchema.safeParse(candidate);
    if (!parsed.success) throw new Error("CONTINUITY_REVISION_INVALID");
    const revision = parsed.data;
    const current = this.revisions.at(-1);
    if (!current) {
      if (revision.revision !== 1 || revision.previousDigest !== null) {
        throw new Error("CONTINUITY_REVISION_CHAIN_INVALID");
      }
      this.revisions.push(revision);
      return { stored: true };
    }
    if (
      revision.revision === current.revision &&
      revision.digest === current.digest
    ) {
      return { stored: false };
    }
    if (
      !sameBinding(revision, current) ||
      revision.revision !== current.revision + 1 ||
      revision.previousDigest !== current.digest
    ) {
      throw new Error("CONTINUITY_REVISION_CHAIN_INVALID");
    }
    this.revisions.push(revision);
    return { stored: true };
  }

  async fetchAfter(
    binding: ContinuityBinding,
    revision: number,
  ): Promise<EncryptedContinuityRevision | null> {
    const expected = continuityBindingSchema.parse(binding);
    if (
      this.revisions.length === 0 ||
      !sameBinding(this.revisions[0]!, expected)
    ) {
      return null;
    }
    const next = this.revisions.find((entry) => entry.revision > revision);
    return next ? structuredClone(next) : null;
  }

  async acknowledge(candidate: unknown): Promise<{ acknowledged: boolean }> {
    const acknowledgement = continuityAcknowledgementSchema.parse(candidate);
    const revision = this.revisions.find(
      (entry) => entry.revision === acknowledgement.revision,
    );
    if (
      !revision ||
      !sameBinding(revision, acknowledgement) ||
      revision.digest !== acknowledgement.digest
    ) {
      throw new Error("CONTINUITY_ACKNOWLEDGEMENT_INVALID");
    }
    if (acknowledgement.revision <= this.acknowledgedRevision) {
      return { acknowledged: false };
    }
    if (acknowledgement.revision !== this.acknowledgedRevision + 1) {
      throw new Error("CONTINUITY_ACKNOWLEDGEMENT_OUT_OF_ORDER");
    }
    this.acknowledgedRevision = acknowledgement.revision;
    return { acknowledged: true };
  }

  exportState(): unknown {
    return structuredClone({
      revisions: this.revisions,
      acknowledgedRevision: this.acknowledgedRevision,
    });
  }
}

interface FixtureCookieStore {
  set(details: CookiesSetDetails): Promise<void>;
  remove(url: string, name: string): Promise<void>;
  flushStore(): Promise<void>;
}

interface FixtureContinuityDestinationOptions {
  binding: ContinuityBinding;
  journalPath: string;
  cookieStore: FixtureCookieStore;
  sourceSigningKey: CryptoKey;
  destinationEncryptionKey: CryptoKey;
  now?: () => number;
}

export class FixtureContinuityDestination {
  private operationTail: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: FixtureContinuityDestinationOptions) {
    this.now = options.now ?? Date.now;
  }

  apply(candidate: unknown): Promise<ContinuityAcknowledgement> {
    return this.enqueue(async () => {
      const revision = encryptedContinuityRevisionSchema.parse(candidate);
      const snapshot = await openEncryptedFixtureRevision(revision, {
        binding: this.options.binding,
        now: this.now(),
        sourceSigningKey: this.options.sourceSigningKey,
        destinationEncryptionKey: this.options.destinationEncryptionKey,
      });
      const journal = await this.readJournal();
      if (
        revision.revision === journal.appliedRevision &&
        revision.digest === journal.appliedDigest
      ) {
        return acknowledgementFor(revision);
      }
      if (
        revision.revision !== journal.appliedRevision + 1 ||
        revision.previousDigest !== journal.appliedDigest
      ) {
        throw new Error("CONTINUITY_DESTINATION_CHAIN_INVALID");
      }
      if (
        snapshot.cookies.some(
          (cookie) => cookie.expirationDate <= this.now() / 1_000,
        )
      ) {
        throw new Error("CONTINUITY_COOKIE_EXPIRED");
      }

      const nextManaged = snapshot.cookies.map(toManagedCookie);
      const nextKeys = new Set(nextManaged.map(managedCookieKey));
      try {
        for (const cookie of snapshot.cookies) {
          await this.options.cookieStore.set(toCookieDetails(cookie));
        }
        for (const cookie of journal.managedCookies) {
          if (!nextKeys.has(managedCookieKey(cookie))) {
            await this.options.cookieStore.remove(
              cookieUrl(cookie),
              cookie.name,
            );
          }
        }
        await this.options.cookieStore.flushStore();
        await this.writeJournal({
          schemaVersion: 1,
          ...this.options.binding,
          appliedRevision: revision.revision,
          appliedDigest: revision.digest,
          managedCookies: nextManaged,
        });
      } catch {
        throw new Error("CONTINUITY_DESTINATION_OUTCOME_UNKNOWN");
      }
      return acknowledgementFor(revision);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readJournal(): Promise<
    z.infer<typeof destinationJournalSchema>
  > {
    try {
      const metadata = await lstat(this.options.journalPath);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        metadata.size > 65_536 ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
      ) {
        throw new Error("CONTINUITY_JOURNAL_CORRUPT");
      }
      const parsed = destinationJournalSchema.parse(
        JSON.parse(await readFile(this.options.journalPath, "utf8")),
      );
      if (!sameBinding(parsed, this.options.binding)) {
        throw new Error("CONTINUITY_JOURNAL_BINDING_MISMATCH");
      }
      return parsed;
    } catch (error) {
      if (isMissingFile(error)) {
        return destinationJournalSchema.parse({
          schemaVersion: 1,
          ...this.options.binding,
          appliedRevision: 0,
          appliedDigest: null,
          managedCookies: [],
        });
      }
      if (
        error instanceof Error &&
        (error.message === "CONTINUITY_JOURNAL_CORRUPT" ||
          error.message === "CONTINUITY_JOURNAL_BINDING_MISMATCH")
      ) {
        throw error;
      }
      throw new Error("CONTINUITY_JOURNAL_CORRUPT");
    }
  }

  private async writeJournal(
    candidate: z.infer<typeof destinationJournalSchema>,
  ): Promise<void> {
    const journal = destinationJournalSchema.parse(candidate);
    const directory = dirname(this.options.journalPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${this.options.journalPath}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(journal), {
        flag: "wx",
        mode: 0o600,
      });
      await chmod(temporary, 0o600);
      await rename(temporary, this.options.journalPath);
      await chmod(this.options.journalPath, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function acknowledgementFor(
  revision: EncryptedContinuityRevision,
): ContinuityAcknowledgement {
  return continuityAcknowledgementSchema.parse({
    principalId: revision.principalId,
    grantId: revision.grantId,
    sourceDeviceId: revision.sourceDeviceId,
    destinationDeviceId: revision.destinationDeviceId,
    sourceBrowserSessionId: revision.sourceBrowserSessionId,
    destinationBrowserSessionId: revision.destinationBrowserSessionId,
    site: revision.site,
    revision: revision.revision,
    digest: revision.digest,
  });
}

function toManagedCookie(
  cookie: FixtureCookie,
): z.infer<typeof managedCookieSchema> {
  return managedCookieSchema.parse({
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path,
    hostOnly: cookie.hostOnly,
  });
}

function managedCookieKey(cookie: z.infer<typeof managedCookieSchema>): string {
  return JSON.stringify([
    cookie.name,
    cookie.domain,
    cookie.path,
    cookie.hostOnly,
  ]);
}

function cookieUrl(cookie: z.infer<typeof managedCookieSchema>): string {
  return `https://${cookie.domain.replace(/^\./, "")}${cookie.path}`;
}

function toCookieDetails(cookie: FixtureCookie): CookiesSetDetails {
  return {
    url: cookieUrl(cookie),
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

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function sameBinding(
  left: ContinuityBinding,
  right: ContinuityBinding,
): boolean {
  return (
    left.principalId === right.principalId &&
    left.grantId === right.grantId &&
    left.sourceDeviceId === right.sourceDeviceId &&
    left.destinationDeviceId === right.destinationDeviceId &&
    left.sourceBrowserSessionId === right.sourceBrowserSessionId &&
    left.destinationBrowserSessionId === right.destinationBrowserSessionId &&
    left.site === right.site
  );
}

function assertRevisionLifetime(issuedAt: string, expiresAt: string): void {
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    expires <= issued ||
    expires - issued > 24 * 60 * 60_000
  ) {
    throw new Error("CONTINUITY_REVISION_LIFETIME_INVALID");
  }
}

function continuityAssociatedData(input: {
  protocolVersion: 1;
  principalId: string;
  grantId: string;
  sourceDeviceId: string;
  destinationDeviceId: string;
  sourceBrowserSessionId: string;
  destinationBrowserSessionId: string;
  site: "OWNED_FIXTURE";
  revision: number;
  previousDigest: string | null;
  issuedAt: string;
  expiresAt: string;
  ephemeralPublicKey: { kty: "OKP"; crv: "X25519"; x: string };
  salt: string;
  iv: string;
}): Uint8Array<ArrayBuffer> {
  return ownedBytes(
    new TextEncoder().encode(
      JSON.stringify([
        input.protocolVersion,
        input.principalId,
        input.grantId,
        input.sourceDeviceId,
        input.destinationDeviceId,
        input.sourceBrowserSessionId,
        input.destinationBrowserSessionId,
        input.site,
        input.revision,
        input.previousDigest,
        input.issuedAt,
        input.expiresAt,
        input.ephemeralPublicKey,
        input.salt,
        input.iv,
      ]),
    ),
  );
}

function revisionDigestBytes(
  associatedData: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(associatedData.length + ciphertext.length);
  bytes.set(associatedData);
  bytes.set(ciphertext, associatedData.length);
  return bytes;
}

function revisionSignatureBytes(input: {
  protocolVersion: 1;
  principalId: string;
  grantId: string;
  sourceDeviceId: string;
  destinationDeviceId: string;
  sourceBrowserSessionId: string;
  destinationBrowserSessionId: string;
  site: "OWNED_FIXTURE";
  revision: number;
  previousDigest: string | null;
  issuedAt: string;
  expiresAt: string;
  ephemeralPublicKey: { kty: "OKP"; crv: "X25519"; x: string };
  salt: string;
  iv: string;
  ciphertext: string;
  digest: string;
}): Uint8Array<ArrayBuffer> {
  return ownedBytes(
    new TextEncoder().encode(
      JSON.stringify([
        ...JSON.parse(
          new TextDecoder().decode(continuityAssociatedData(input)),
        ),
        input.ciphertext,
        input.digest,
      ]),
    ),
  );
}

async function deriveEncryptionKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const secret = await crypto.subtle.deriveBits(
    { name: "X25519", public: publicKey },
    privateKey,
    256,
  );
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString(
    "hex",
  );
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  return ownedBytes(Buffer.from(value, "base64url"));
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Uint8Array(buffer);
}
