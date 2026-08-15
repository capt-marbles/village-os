import { continuityBindingSchema } from "@village/contracts";
import { app, session } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { FileProtocolSequenceStore } from "./control-plane-client.js";
import { ContinuityMailboxClient } from "./continuity-mailbox-client.js";
import {
  FixtureContinuityDestination,
  FixtureContinuitySource,
} from "./site-session-continuity.js";

// This entry is excluded from release packages. It isolates cookie-transfer
// behavior from ad-hoc build Keychain prompts; signed-build prompt behavior is
// a separate manual release gate.
app.commandLine.appendSwitch("use-mock-keychain");

type ProofRole = "SOURCE" | "DESTINATION";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requiredAbsoluteArgument(name: string): string {
  const value = argument(name);
  if (!value || !isAbsolute(value)) {
    throw new Error("PACKAGED_CONTINUITY_PATH_UNSAFE");
  }
  return value;
}

async function readConfiguration(role: ProofRole) {
  const candidate = JSON.parse(
    await readFile(requiredAbsoluteArgument("--continuity-config"), "utf8"),
  ) as Record<string, unknown>;
  const binding = continuityBindingSchema.parse(candidate.binding);
  if (candidate.role !== role)
    throw new Error("PACKAGED_CONTINUITY_ROLE_MISMATCH");
  return { binding, candidate };
}

async function importPrivateKey(
  candidate: unknown,
  algorithm: "Ed25519" | "X25519",
  usage: KeyUsage,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    candidate as JsonWebKey,
    algorithm,
    false,
    [usage],
  );
}

async function importPublicKey(
  candidate: unknown,
  algorithm: "Ed25519" | "X25519",
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    candidate as JsonWebKey,
    algorithm,
    false,
    algorithm === "Ed25519" ? ["verify"] : [],
  );
}

async function writeReport(value: unknown): Promise<void> {
  const path = requiredAbsoluteArgument("--continuity-report");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}

function mailboxClient(
  baseUrl: URL,
  privateKey: CryptoKey,
  profilePath: string,
) {
  return new ContinuityMailboxClient({
    baseUrl,
    privateKey,
    sequences: new FileProtocolSequenceStore(
      join(profilePath, "continuity", "sequences.json"),
    ),
  });
}

async function sourceMode(profilePath: string, baseUrl: URL): Promise<void> {
  const { binding, candidate } = await readConfiguration("SOURCE");
  const sourceSigningKey = await importPrivateKey(
    candidate.sourceSigningPrivateKey,
    "Ed25519",
    "sign",
  );
  const destinationEncryptionKey = await importPublicKey(
    candidate.destinationEncryptionPublicKey,
    "X25519",
  );
  const browserSession = session.fromPath(join(profilePath, "browser"));
  const count = Number.parseInt(argument("--continuity-count") ?? "0", 10);
  if (!Number.isInteger(count) || count < 0 || count > 20) {
    throw new Error("PACKAGED_CONTINUITY_COUNT_INVALID");
  }
  const source = new FixtureContinuitySource({
    binding,
    journalPath: join(profilePath, "continuity", "source.json"),
    cookieStore: browserSession.cookies,
    sourceSigningKey,
    destinationEncryptionKey,
    publish: (revision) =>
      mailboxClient(baseUrl, sourceSigningKey, profilePath).publish(revision),
  });
  let lastRevision = 0;
  if (count === 0) {
    await browserSession.cookies.remove(
      "https://fixture.village.test/",
      "fixture_session",
    );
    await browserSession.cookies.flushStore();
    lastRevision = (await source.publishCurrent()).revision;
  } else {
    for (let index = 0; index < count; index += 1) {
      await browserSession.cookies.set({
        url: "https://fixture.village.test/",
        name: "fixture_session",
        value: `packaged-source-value-${index}`,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        expirationDate: Math.floor(Date.now() / 1_000) + 86_400,
      });
      await browserSession.cookies.flushStore();
      lastRevision = (await source.publishCurrent()).revision;
    }
  }
  await writeReport({
    status: "PASS",
    role: "SOURCE",
    keychainMode: "MOCK_TEST_ONLY",
    published: count === 0 ? 1 : count,
    lastRevision,
  });
}

async function destinationMode(
  profilePath: string,
  baseUrl: URL,
  mode: "DESTINATION" | "RESTART" | "REVOKED",
): Promise<void> {
  const { binding, candidate } = await readConfiguration("DESTINATION");
  const destinationSigningKey = await importPrivateKey(
    candidate.destinationSigningPrivateKey,
    "Ed25519",
    "sign",
  );
  const destinationEncryptionKey = await importPrivateKey(
    candidate.destinationEncryptionPrivateKey,
    "X25519",
    "deriveBits",
  );
  const sourceSigningKey = await importPublicKey(
    candidate.sourceSigningPublicKey,
    "Ed25519",
  );
  const browserSession = session.fromPath(join(profilePath, "browser"));
  const destination = new FixtureContinuityDestination({
    binding,
    journalPath: join(profilePath, "continuity", "destination.json"),
    cookieStore: browserSession.cookies,
    sourceSigningKey,
    destinationEncryptionKey,
  });
  const target = Number.parseInt(argument("--continuity-target") ?? "0", 10);
  const client = () =>
    mailboxClient(baseUrl, destinationSigningKey, profilePath);

  if (mode === "REVOKED") {
    let rejected = false;
    try {
      await client().fetchAfter(
        binding,
        (await destination.current()).revision,
      );
    } catch (error) {
      rejected =
        error instanceof Error &&
        ["CONTINUITY_GRANT_NOT_FOUND", "MAILBOX_NOT_ACTIVE"].includes(
          error.message,
        );
    }
    await writeReport({
      status: "PASS",
      role: mode,
      keychainMode: "MOCK_TEST_ONLY",
      rejected,
    });
    return;
  }

  let applied = 0;
  let current = await destination.current();
  while (current.revision < target) {
    const revision = await client().fetchAfter(binding, current.revision);
    if (!revision) throw new Error("PACKAGED_CONTINUITY_REVISION_MISSING");
    const acknowledgement = await destination.apply(revision);
    await client().acknowledge(binding, acknowledgement);
    applied += 1;
    current = await destination.current();
  }
  const authenticated =
    (
      await browserSession.cookies.get({
        url: "https://fixture.village.test/",
        name: "fixture_session",
      })
    ).length === 1;
  const noNewRevision =
    mode === "RESTART"
      ? (await client().fetchAfter(binding, current.revision)) === null
      : undefined;
  await writeReport({
    status: "PASS",
    role: mode,
    keychainMode: "MOCK_TEST_ONLY",
    applied,
    revision: current.revision,
    authenticated,
    ...(noNewRevision === undefined ? {} : { noNewRevision }),
  });
}

async function run(): Promise<void> {
  const profilePath = requiredAbsoluteArgument("--continuity-profile");
  app.setPath("userData", profilePath);
  await app.whenReady();
  const baseUrl = new URL(argument("--continuity-control-plane") ?? "");
  const mode = argument("--continuity-mode");
  if (mode === "SOURCE") await sourceMode(profilePath, baseUrl);
  else if (mode === "DESTINATION" || mode === "RESTART" || mode === "REVOKED") {
    await destinationMode(profilePath, baseUrl, mode);
  } else throw new Error("PACKAGED_CONTINUITY_MODE_INVALID");
  app.exit(0);
}

void run().catch((error: unknown) => {
  console.error(
    "Packaged continuity proof failed:",
    error instanceof Error ? error.message : "UNKNOWN",
  );
  app.exit(1);
});
