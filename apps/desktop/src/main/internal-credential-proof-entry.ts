import { OWNED_FIXTURE_ORIGIN } from "@village/contracts";
import { app, BaseWindow, clipboard, type Session } from "electron";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalBrowserHost } from "../browser/local-browser-host.js";
import { internalProofProfileProtection } from "./internal-profile-protection.js";
import {
  SecretVault,
  type SecretEncryptionProvider,
} from "../secrets/secret-vault.js";
import { installFixtureSessionHandler } from "./fixture-session-handler.js";
import { OwnedFixtureCredentialFill } from "./owned-fixture-credential-fill.js";
import { installGlobalSecurityPolicy } from "./security.js";

function requiredPath(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || !isAbsolute(value)) {
    throw new Error("PACKAGED_FIXTURE_SECRET_PATH_UNSAFE");
  }
  return value;
}

function digest(value: Uint8Array | string): Buffer {
  return createHash("sha256").update(value).digest();
}

class EphemeralProofEncryptionProvider implements SecretEncryptionProvider {
  private readonly key = randomBytes(32);

  async availability() {
    return {
      available: true,
      backend: "internal-proof-ephemeral-aes-gcm",
      secure: true,
    };
  }

  async encrypt(value: string): Promise<Uint8Array> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const encrypted = Buffer.concat([nonce, tag, ciphertext]);
    nonce.fill(0);
    tag.fill(0);
    ciphertext.fill(0);
    return encrypted;
  }

  async decrypt(value: Uint8Array) {
    if (value.byteLength < 29) throw new Error("PROOF_CIPHERTEXT_INVALID");
    const bytes = Buffer.from(value);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(12, 28));
    const plaintext = Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]);
    try {
      return { value: plaintext.toString("utf8"), shouldReEncrypt: false };
    } finally {
      plaintext.fill(0);
    }
  }

  destroy(): void {
    this.key.fill(0);
  }
}

async function waitForDestination(
  destination: Promise<void>,
  timeoutMs = 10_000,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      destination,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("PACKAGED_FIXTURE_SECRET_REQUEST_TIMEOUT")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function run(): Promise<void> {
  const seedPath = requiredPath("--village-fixture-secret-seed");
  const reportPath = requiredPath("--village-fixture-secret-report");
  const profilePath = requiredPath("--village-fixture-secret-profile");
  app.setPath("userData", profilePath);
  installGlobalSecurityPolicy(app);
  await app.whenReady();
  const window = new BaseWindow({
    show: true,
    width: 800,
    height: 600,
    title: "Village fixture credential proof",
    backgroundColor: "#101410",
  });
  app.focus({ steal: true });
  const watchdog = setTimeout(() => app.exit(70), 60_000);

  const secret = await readFile(seedPath);
  await unlink(seedPath);
  const expectedDigest = digest(secret);
  const protector = new EphemeralProofEncryptionProvider();
  const vault = new SecretVault(
    join(profilePath, "fixture-secret-vault.json"),
    protector,
  );
  await vault.store("sec_fixture_primary", secret);
  const secretBufferCleared = secret.every((byte) => byte === 0);

  const fixtureRoot = join(
    process.resourcesPath,
    "internal-proof/node_modules/@village/test-auth-site/dist",
  );
  const { createOwnedFixtureCredentialRequestHandler } = await import(
    pathToFileURL(join(fixtureRoot, "credential-request-handler.js")).href
  );
  let requestCount = 0;
  let destinationRequestCount = 0;
  let nonDestinationRequests = 0;
  let approvedDestinationRequest = false;
  let resolveDestination!: () => void;
  const destination = new Promise<void>((resolve) => {
    resolveDestination = resolve;
  });
  const applicationHandler = createOwnedFixtureCredentialRequestHandler({
    onDestinationRequest: async (request: {
      username: string;
      password: string;
    }) => {
      destinationRequestCount += 1;
      const received = digest(request.password);
      approvedDestinationRequest =
        request.username === "owner" &&
        received.length === expectedDigest.length &&
        timingSafeEqual(received, expectedDigest);
      resolveDestination();
    },
  }) as (request: Request) => Promise<Response>;
  let host: LocalBrowserHost | undefined;
  const clipboardBefore = clipboard.readText();
  try {
    host = await LocalBrowserHost.create({
      principalId: "prn_01J00000000000000000000000",
      deviceId: "dev_01J00000000000000000000000",
      site: "OWNED_FIXTURE",
      profileRoot: LocalBrowserHost.profileRoot(profilePath),
      initialUrl: `${OWNED_FIXTURE_ORIGIN}/login`,
      profileProtection: internalProofProfileProtection,
      prepareSession: async (browserSession: Session) =>
        installFixtureSessionHandler(
          browserSession.protocol,
          async (request) => {
            requestCount += 1;
            const url = new URL(request.url);
            if (
              url.pathname !== "/login" ||
              (request.method !== "GET" && request.method !== "POST")
            ) {
              nonDestinationRequests += 1;
            }
            return applicationHandler(request);
          },
        ),
    });
    host.view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    window.contentView.addChildView(host.view);
    const operation = new OwnedFixtureCredentialFill(vault, {
      confirmCredentialUse: async () => true,
    });
    const authorization = await operation.fill(
      {
        principalId: "prn_01J00000000000000000000000",
        deviceId: "dev_01J00000000000000000000000",
        jobId: "job_01J00000000000000000000000",
        browserSessionId: "brs_01J00000000000000000000000",
        actionId: "act_01J00000000000000000000000",
        leaseEpoch: 1,
        exactOrigin: OWNED_FIXTURE_ORIGIN,
        fieldSemantic: "PASSWORD",
        secretRef: "sec_fixture_primary",
        site: "OWNED_FIXTURE",
      },
      host.view.webContents.debugger,
    );
    const approvedFieldFilled = await host.view.webContents.executeJavaScript(
      `(() => {
        const username = document.querySelector('input[autocomplete="username"]');
        const password = document.querySelector('input[autocomplete="current-password"]');
        if (username) username.value = 'owner';
        return password instanceof HTMLInputElement && password.value.length > 0;
      })()`,
      true,
    );
    await host.view.webContents.executeJavaScript(
      "document.querySelector('form')?.requestSubmit(); true",
      true,
    );
    await waitForDestination(destination);
    await host.view.webContents.executeJavaScript(
      `(() => {
        const field = document.querySelector('input[autocomplete="current-password"]');
        if (field instanceof HTMLInputElement) field.value = '';
      })()`,
      true,
    );

    await writeFile(
      reportPath,
      JSON.stringify({
        status:
          authorization.ok && approvedDestinationRequest ? "PASS" : "FAIL",
        authorizationResult: authorization.ok ? "OK" : authorization.code,
        approvedFieldFilled,
        approvedDestinationRequest,
        requestCount,
        destinationRequestCount,
        nonDestinationRequests,
        secretBufferCleared,
        clipboardUnchanged: clipboard.readText() === clipboardBefore,
        devToolsOpened: host.view.webContents.isDevToolsOpened(),
      }),
      { mode: 0o600, flag: "wx" },
    );
  } finally {
    clearTimeout(watchdog);
    await host?.close();
    window.destroy();
    expectedDigest.fill(0);
    protector.destroy();
    app.quit();
  }
}

void run().catch((error: unknown) => {
  console.error(
    "Village packaged fixture secret proof blocked:",
    error instanceof Error ? error.message : "UNKNOWN_FAILURE",
  );
  app.exit(1);
});
