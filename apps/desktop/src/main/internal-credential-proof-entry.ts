import { OWNED_FIXTURE_ORIGIN } from "@village/contracts";
import {
  app,
  BaseWindow,
  clipboard,
  protocol,
  session,
  type Session,
  WebContentsView,
} from "electron";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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
import {
  ensureProtectedProfile,
  ProfileLock,
  scopedProfileAbsent,
  scopedProfilePath,
  type ProfileScope,
} from "../browser/profile-protection.js";
import { RestartStagedSessionErasureCoordinator } from "./session-erasure.js";
import { SessionErasureRequestController } from "./session-erasure-request.js";
import { StepUpAuthorizer } from "./step-up-auth.js";
import {
  completePendingSessionErasure,
  PendingSessionErasureStore,
} from "./pending-session-erasure.js";
import { registerVillageScheme } from "./local-app-protocol.js";
import { RenderProcessRecovery } from "./render-process-recovery.js";
import { LocalActionExecutor } from "../browser/local-action-executor.js";
import { DesktopBrowserUiState } from "./desktop-browser-ui-state.js";
import type { LocalDiagnostic } from "./crash-reporting.js";

const targetProfileScope: ProfileScope = {
  principalId: "prn_01J00000000000000000000000",
  deviceId: "dev_01J00000000000000000000000",
  site: "OWNED_FIXTURE",
};
const siblingProfileScope: ProfileScope = {
  ...targetProfileScope,
  deviceId: "dev_01J00000000000000000000001",
};
const targetCookieName = "__Host-village_erasure_target";
const siblingCookieName = "__Host-village_erasure_sibling";
const siblingCookieValue = "sibling-session-preserved";
const siblingStorageValue = "sibling-storage-preserved";

// This internal-only package proves broker and erasure behavior, not OS-crypt.
// The release package excludes this entry; the dedicated profile proof owns
// the real macOS Keychain gate.
app.commandLine.appendSwitch("use-mock-keychain");
registerVillageScheme(protocol);

function reportProofStage(stage: string): void {
  process.stderr.write(`VILLAGE_PROOF_STAGE:${stage}\n`);
}

function requiredPath(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || !isAbsolute(value)) {
    throw new Error("PACKAGED_FIXTURE_SECRET_PATH_UNSAFE");
  }
  return value;
}

function optionalPath(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || !isAbsolute(value)) {
    throw new Error("PACKAGED_FIXTURE_SECRET_PATH_UNSAFE");
  }
  return value;
}

async function pathAbsent(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}

async function createSiblingProofHost(
  userDataPath: string,
): Promise<LocalBrowserHost> {
  return LocalBrowserHost.create({
    ...siblingProfileScope,
    profileRoot: LocalBrowserHost.profileRoot(userDataPath),
    initialUrl: `${OWNED_FIXTURE_ORIGIN}/login`,
    profileProtection: internalProofProfileProtection,
    prepareSession: (browserSession: Session) =>
      installFixtureSessionHandler(
        browserSession.protocol,
        async () =>
          new Response(
            "<!doctype html><html><body><p>Sibling profile proof</p></body></html>",
            { headers: { "content-type": "text/html; charset=utf-8" } },
          ),
      ),
  });
}

async function seedSiblingBrowserStorage(
  host: LocalBrowserHost,
): Promise<void> {
  await host.view.webContents.executeJavaScript(
    `(async () => {
      localStorage.setItem("village-erasure-sibling", ${JSON.stringify(siblingStorageValue)});
      await new Promise((resolve, reject) => {
        const request = indexedDB.open("village-erasure-sibling-indexeddb", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("records");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction("records", "readwrite");
          transaction.objectStore("records").put(${JSON.stringify(siblingStorageValue)}, "status");
          transaction.oncomplete = () => {
            database.close();
            resolve(true);
          };
          transaction.onerror = () => reject(transaction.error);
        };
      });
      const cache = await caches.open("village-erasure-sibling-cache");
      await cache.put("/sibling-cached-proof", new Response(${JSON.stringify(siblingStorageValue)}));
      return true;
    })()`,
    true,
  );
}

async function inspectSiblingBrowserStorage(host: LocalBrowserHost): Promise<{
  localStorage: boolean;
  indexedDb: boolean;
  cache: boolean;
  permissionPolicy: boolean;
}> {
  const storage = (await host.view.webContents.executeJavaScript(
    `(async () => {
      const expected = ${JSON.stringify(siblingStorageValue)};
      const databases = await indexedDB.databases();
      const hasDatabase = databases.some(
        (database) => database.name === "village-erasure-sibling-indexeddb"
      );
      const indexedDbValue = hasDatabase
        ? await new Promise((resolve, reject) => {
            const request = indexedDB.open("village-erasure-sibling-indexeddb");
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const database = request.result;
              const transaction = database.transaction("records", "readonly");
              const read = transaction.objectStore("records").get("status");
              read.onsuccess = () => {
                database.close();
                resolve(read.result);
              };
              read.onerror = () => reject(read.error);
            };
          })
        : undefined;
      const cached = await caches.match("/sibling-cached-proof");
      return {
        localStorage: localStorage.getItem("village-erasure-sibling") === expected,
        indexedDb: indexedDbValue === expected,
        cache: cached !== undefined && (await cached.text()) === expected,
      };
    })()`,
    true,
  )) as { localStorage: boolean; indexedDb: boolean; cache: boolean };
  const permissionPolicy = await host.view.webContents.executeJavaScript(
    `new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        () => resolve(false),
        (error) => resolve(error.code === 1),
        { timeout: 1000 }
      );
    })`,
    true,
  );
  return { ...storage, permissionPolicy: permissionPolicy === true };
}

async function runRestartErasureVerification(
  profilePath: string,
  reportPath: string,
): Promise<void> {
  const profileRoot = LocalBrowserHost.profileRoot(profilePath);
  const targetPath = scopedProfilePath(profileRoot, targetProfileScope);
  const pendingStore = new PendingSessionErasureStore(
    join(profilePath, "session-erasure"),
  );
  const completed = await completePendingSessionErasure(
    pendingStore,
    profileRoot,
  );
  const siblingProfile = await ensureProtectedProfile(
    profileRoot,
    siblingProfileScope,
    process.platform,
    internalProofProfileProtection,
  );
  const siblingHost = await createSiblingProofHost(profilePath);
  const siblingEvidence = await (async () => {
    try {
      return {
        cookies: await session
          .fromPath(siblingProfile.path, { cache: true })
          .cookies.get({
            url: OWNED_FIXTURE_ORIGIN,
            name: siblingCookieName,
          }),
        storage: await inspectSiblingBrowserStorage(siblingHost),
      };
    } finally {
      await siblingHost.close();
    }
  })();
  await writeFile(
    reportPath,
    JSON.stringify({
      targetAbsentAfterRestart: await scopedProfileAbsent(targetPath),
      targetLockAbsentAfterRestart: await pathAbsent(`${targetPath}.lock`),
      siblingCookiePreserved:
        siblingEvidence.cookies.length === 1 &&
        siblingEvidence.cookies[0]?.value === siblingCookieValue,
      siblingLocalStoragePreserved: siblingEvidence.storage.localStorage,
      siblingIndexedDbPreserved: siblingEvidence.storage.indexedDb,
      siblingCachePreserved: siblingEvidence.storage.cache,
      siblingPermissionPolicyPreserved:
        siblingEvidence.storage.permissionPolicy,
      siblingJournalPreserved: !(await pathAbsent(
        join(siblingProfile.path, "action-journal.json"),
      )),
      siblingVaultReferencePreserved: !(await pathAbsent(
        join(siblingProfile.path, "credential-reference.marker"),
      )),
      credentialReferenceAbsentAfterRestart: await pathAbsent(
        join(targetPath, "fixture-secret-vault.json"),
      ),
      pendingErasureConsumed:
        completed?.binding.principalId === targetProfileScope.principalId &&
        (await pendingStore.load()) === null,
    }),
    { mode: 0o600, flag: "wx" },
  );
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
  const profilePath = requiredPath("--village-fixture-secret-profile");
  const crashDumpPath = join(profilePath, "crash-dumps");
  const restartErasureReport = optionalPath(
    "--village-fixture-erasure-restart-report",
  );
  await mkdir(crashDumpPath, { recursive: true, mode: 0o700 });
  app.setPath("userData", profilePath);
  app.setPath("crashDumps", crashDumpPath);
  installGlobalSecurityPolicy(app);
  await app.whenReady();
  await session.defaultSession.protocol.handle("village", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "app" || url.pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }
    return new Response(
      "<!doctype html><html><body><p>Village crash recovery proof</p></body></html>",
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  });
  reportProofStage("APP_READY");
  if (restartErasureReport) {
    await runRestartErasureVerification(profilePath, restartErasureReport);
    reportProofStage("RESTART_VERIFIED");
    app.quit();
    return;
  }
  const seedPath = requiredPath("--village-fixture-secret-seed");
  const reportPath = requiredPath("--village-fixture-secret-report");
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
  const profileRoot = LocalBrowserHost.profileRoot(profilePath);
  const [targetProfile, siblingProfile] = await Promise.all([
    ensureProtectedProfile(
      profileRoot,
      targetProfileScope,
      process.platform,
      internalProofProfileProtection,
    ),
    ensureProtectedProfile(
      profileRoot,
      siblingProfileScope,
      process.platform,
      internalProofProfileProtection,
    ),
  ]);
  reportProofStage("PROFILES_READY");
  const vault = new SecretVault(
    join(targetProfile.path, "fixture-secret-vault.json"),
    protector,
  );
  await vault.store("sec_fixture_primary", secret);
  const secretBufferCleared = secret.every((byte) => byte === 0);
  const siblingLock = await ProfileLock.acquire(siblingProfile.path);
  try {
    const [targetSession, siblingSession] = [
      session.fromPath(targetProfile.path, { cache: true }),
      session.fromPath(siblingProfile.path, { cache: true }),
    ];
    await Promise.all([
      targetSession.cookies.set({
        url: OWNED_FIXTURE_ORIGIN,
        name: targetCookieName,
        value: "target-session-to-delete",
        secure: true,
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        expirationDate: Date.now() / 1_000 + 3_600,
      }),
      siblingSession.cookies.set({
        url: OWNED_FIXTURE_ORIGIN,
        name: siblingCookieName,
        value: siblingCookieValue,
        secure: true,
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        expirationDate: Date.now() / 1_000 + 3_600,
      }),
    ]);
    reportProofStage("COOKIES_SEEDED");
    await Promise.all([
      targetSession.flushStorageData(),
      siblingSession.flushStorageData(),
    ]);
  } finally {
    await siblingLock.release();
  }
  await Promise.all([
    writeFile(join(targetProfile.path, "action-journal.json"), "[]", {
      mode: 0o600,
      flag: "wx",
    }),
    mkdir(join(targetProfile.path, "temporary"), { mode: 0o700 }),
    mkdir(join(targetProfile.path, "Downloads"), { mode: 0o700 }),
    writeFile(join(siblingProfile.path, "action-journal.json"), "[]", {
      mode: 0o600,
      flag: "wx",
    }),
    writeFile(
      join(siblingProfile.path, "credential-reference.marker"),
      "preserved",
      { mode: 0o600, flag: "wx" },
    ),
  ]);
  await Promise.all([
    writeFile(join(targetProfile.path, "temporary", "pending.tmp"), "temp", {
      mode: 0o600,
      flag: "wx",
    }),
    writeFile(
      join(targetProfile.path, "Downloads", "download.part"),
      "partial",
      { mode: 0o600, flag: "wx" },
    ),
  ]);
  const siblingHost = await createSiblingProofHost(profilePath);
  try {
    await seedSiblingBrowserStorage(siblingHost);
    await session
      .fromPath(siblingProfile.path, { cache: true })
      .flushStorageData();
  } finally {
    await siblingHost.close();
  }

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
      ...targetProfileScope,
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
    reportProofStage("BROWSER_READY");
    host.view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    window.contentView.addChildView(host.view);
    const browserStorageSeeded = await host.view.webContents.executeJavaScript(
      `(async () => {
        localStorage.setItem("village-erasure-local", "present");
        await new Promise((resolve, reject) => {
          const request = indexedDB.open("village-erasure-indexeddb", 1);
          request.onupgradeneeded = () => request.result.createObjectStore("records");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const transaction = request.result.transaction("records", "readwrite");
            transaction.objectStore("records").put("present", "status");
            transaction.oncomplete = () => resolve(true);
            transaction.onerror = () => reject(transaction.error);
          };
        });
        const cache = await caches.open("village-erasure-cache");
        await cache.put("/cached-proof", new Response("present"));
        return localStorage.getItem("village-erasure-local") === "present";
      })()`,
      true,
    );
    const permissionPolicyEnforced =
      await host.view.webContents.executeJavaScript(
        `new Promise((resolve) => {
          navigator.geolocation.getCurrentPosition(
            () => resolve(false),
            (error) => resolve(error.code === 1),
            { timeout: 1000 }
          );
        })`,
        true,
      );
    reportProofStage("STORAGE_AND_PERMISSIONS_VERIFIED");
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
    reportProofStage("CREDENTIAL_FILL_VERIFIED");
    await host.view.webContents.executeJavaScript(
      `(() => {
        const field = document.querySelector('input[autocomplete="current-password"]');
        if (field instanceof HTMLInputElement) field.value = '';
      })()`,
      true,
    );
    const devToolsOpened = host.view.webContents.isDevToolsOpened();

    const trustedView = new WebContentsView();
    trustedView.setBounds({ x: 799, y: 599, width: 1, height: 1 });
    window.contentView.addChildView(trustedView);
    await trustedView.webContents.loadURL("village://app/");
    const crashUiState = new DesktopBrowserUiState();
    const crashExecutor = new LocalActionExecutor({ leaseEpoch: 1 });
    const crashDiagnostics: LocalDiagnostic[] = [];
    let trustedReloadUrl: string | undefined;
    let trustedStateRepublished = false;
    const crashRecovery = new RenderProcessRecovery({
      browser: host.view.webContents,
      trustedRenderer: trustedView.webContents,
      fenceBrowser: () => crashExecutor.markOfflineTakeover(),
      markBrowserUnavailable: () => crashUiState.markConnection("ABSENT"),
      capture: (diagnostic) => crashDiagnostics.push(diagnostic),
      reloadTrustedRenderer: async (url) => {
        trustedReloadUrl = url;
        await trustedView.webContents.loadURL(url);
      },
      republishTrustedState: () => {
        trustedStateRepublished = true;
      },
    });
    crashRecovery.start();
    const remoteRendererGone = new Promise<void>((resolve) =>
      host!.view.webContents.once("render-process-gone", () => resolve()),
    );
    host.view.webContents.forcefullyCrashRenderer();
    await remoteRendererGone;
    const browserCrashFenced = crashExecutor.isAutomationBlocked();
    const browserCrashWaiting =
      crashUiState.current().connection === "ABSENT" &&
      crashUiState.current().jobState === "WAITING_FOR_BROWSER" &&
      crashUiState.current().controller === "NONE";

    const trustedRendererGone = new Promise<void>((resolve) =>
      trustedView.webContents.once("render-process-gone", () => resolve()),
    );
    trustedView.webContents.forcefullyCrashRenderer();
    await trustedRendererGone;
    await crashRecovery.settled();
    const trustedRendererRecovered =
      trustedReloadUrl === "village://app/" &&
      trustedStateRepublished &&
      trustedView.webContents.getURL() === "village://app/";
    const crashDiagnosticsBounded =
      JSON.stringify(crashDiagnostics) ===
      JSON.stringify([
        {
          component: "BROWSER_HOST",
          code: "REMOTE_RENDERER_GONE",
          retriable: true,
        },
        {
          component: "BROWSER_HOST",
          code: "TRUSTED_RENDERER_GONE",
          retriable: true,
        },
      ]);
    crashRecovery.stop();
    if (!trustedView.webContents.isDestroyed()) trustedView.webContents.close();
    window.contentView.removeChildView(trustedView);
    reportProofStage("RENDERER_CRASH_RECOVERY_VERIFIED");

    const erasureBinding = {
      principalId: targetProfileScope.principalId,
      deviceId: targetProfileScope.deviceId,
      browserSessionId: "brs_01J00000000000000000000000",
      site: "OWNED_FIXTURE" as const,
      operation: "FORGET_SESSION" as const,
      currentState: "PRESENT" as const,
    };
    let matrixNow = 1_000;
    const matrixAuthorizer = new StepUpAuthorizer(() => matrixNow);
    const bindingCases = [
      { ...erasureBinding, principalId: "prn_01J00000000000000000000001" },
      { ...erasureBinding, deviceId: siblingProfileScope.deviceId },
      { ...erasureBinding, browserSessionId: "brs_01J00000000000000000000001" },
      { ...erasureBinding, site: "LINKEDIN" as const },
      { ...erasureBinding, operation: "NOT_FORGET_SESSION" as never },
      { ...erasureBinding, currentState: "ERASURE_FAILED" as const },
    ];
    const bindingMatrixRejected = bindingCases.every((candidate) => {
      const token = matrixAuthorizer.mint(erasureBinding, 5_000).token;
      const result = matrixAuthorizer.consume(token, candidate);
      return !result.ok && result.code === "STEP_UP_BINDING_MISMATCH";
    });
    const absentTokenRejected = !matrixAuthorizer.consume(
      "absent-token",
      erasureBinding,
    ).ok;
    const expiredToken = matrixAuthorizer.mint(erasureBinding, 1_000).token;
    matrixNow = 2_000;
    const expiredResult = matrixAuthorizer.consume(
      expiredToken,
      erasureBinding,
    );
    const replayToken = matrixAuthorizer.mint(erasureBinding, 5_000).token;
    const firstConsumption = matrixAuthorizer.consume(
      replayToken,
      erasureBinding,
    );
    const replayConsumption = matrixAuthorizer.consume(
      replayToken,
      erasureBinding,
    );

    const authorizer = new StepUpAuthorizer();
    let automationFenced = false;
    let credentialReferenceRevoked = false;
    let stageAttempts = 0;
    let failedStep: string | undefined;
    let ownerPresenceRequests = 0;
    let confirmationRequests = 0;
    const pendingStore = new PendingSessionErasureStore(
      join(profilePath, "session-erasure"),
    );
    const erasure = new RestartStagedSessionErasureCoordinator(authorizer, {
      revokeAutomation: async () => {
        automationFenced = true;
      },
      closeTarget: async () => host!.closeTargetForErasure(),
      clearBrowserStorage: async () => host!.clearSiteStorage(),
      clearPermissions: async () => host!.clearSitePermissions(),
      revokeCredentialReferences: async () => {
        if (!credentialReferenceRevoked) {
          await vault.revoke("sec_fixture_primary");
        }
        credentialReferenceRevoked = true;
      },
      stageProfileRemoval: async (binding) => {
        stageAttempts += 1;
        if (stageAttempts === 1) throw new Error("injected staging failure");
        await pendingStore.stage(binding);
      },
    });
    let allowConfirmation = false;
    const request = new SessionErasureRequestController({
      binding: () => erasureBinding,
      verifyOwner: async () => {
        ownerPresenceRequests += 1;
        return true;
      },
      confirm: async () => {
        confirmationRequests += 1;
        return allowConfirmation;
      },
      authorizer,
      coordinator: erasure,
      onStepUpRequired: () => undefined,
      onErasureStarted: () => undefined,
      onErasureStaged: () => undefined,
      onErasureFailed: (step) => {
        failedStep = step;
      },
      restart: () => undefined,
    });
    const declinedResult = await request.request();
    const profilePreservedAfterCancel = !(await scopedProfileAbsent(
      targetProfile.path,
    ));
    allowConfirmation = true;
    const partialResult = await request.request();
    const retryResult = await request.request();
    reportProofStage("ERASURE_STAGED");
    const targetPresentUntilRestart = !(await scopedProfileAbsent(
      targetProfile.path,
    ));
    const credentialAbsent = await vault
      .withSecret("sec_fixture_primary", async () => false)
      .catch(
        (error: unknown) =>
          error instanceof Error && error.message === "SECRET_REVOKED",
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
        devToolsOpened,
        browserStorageSeeded,
        permissionPolicyEnforced,
        browserCrashFenced,
        browserCrashWaiting,
        trustedRendererRecovered,
        crashDiagnosticsBounded,
        crashDumpSinkScoped: app.getPath("crashDumps") === crashDumpPath,
        bindingMatrixRejected,
        absentTokenRejected,
        expiredTokenRejected:
          !expiredResult.ok && expiredResult.code === "STEP_UP_EXPIRED",
        replayRejected:
          firstConsumption.ok &&
          !replayConsumption.ok &&
          replayConsumption.code === "STEP_UP_REPLAYED",
        mainProcessRequestPathUsed:
          ownerPresenceRequests === 3 && confirmationRequests === 3,
        cancelPreservedProfile:
          declinedResult === "DECLINED" && profilePreservedAfterCancel,
        partialFailureObserved:
          partialResult === "PARTIAL_FAILURE" &&
          failedStep === "stageProfileRemoval" &&
          stageAttempts === 2,
        erasureStaged: retryResult === "RESTART_REQUIRED",
        automationFenced,
        credentialReferenceRevoked,
        credentialAbsent,
        targetPresentUntilRestart,
      }),
      { mode: 0o600, flag: "wx" },
    );
    reportProofStage("REPORT_WRITTEN");
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
