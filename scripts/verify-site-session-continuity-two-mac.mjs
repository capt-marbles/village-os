import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalContinuityRecipientKeyEnrollmentBytes,
  continuityGrantIdSchema,
  continuityRecipientKeyEnrollmentSchema,
  deviceIdSchema,
  browserSessionIdSchema,
  hostIdSchema,
  principalIdSchema,
} from "../packages/contracts/dist/index.js";
import { verifyPackagedMac } from "./verify-packaged-mac.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultApplicationPath = path.join(
  root,
  "apps/desktop/release/continuity-e2e",
  process.arch === "arm64" ? "mac-arm64" : "mac",
  "Village.app",
);

export function assertTwoMacSiteSessionContinuity(report) {
  if (report.status !== "PASS") {
    throw new Error("TWO_MAC_CONTINUITY_FAILED");
  }
  if (
    !report.sourceMachineId ||
    !report.destinationMachineId ||
    report.sourceMachineId === report.destinationMachineId ||
    report.sourceHost === report.destinationHost
  ) {
    throw new Error("TWO_MAC_CONTINUITY_MACHINE_ISOLATION_FAILED");
  }
  if (report.site !== "OWNED_FIXTURE") {
    throw new Error("TWO_MAC_CONTINUITY_SITE_BOUNDARY_FAILED");
  }
  if (
    report.transfersApplied !== 20 ||
    report.destinationRevision !== 20 ||
    report.destinationOfflineDuringPublish !== true ||
    report.sourceProfileDistinct !== true ||
    report.destinationProfileDistinct !== true
  ) {
    throw new Error("TWO_MAC_CONTINUITY_TRANSFER_FAILED");
  }
  if (
    report.restartRevision !== 20 ||
    report.restartNoNewRevision !== true ||
    report.authenticatedAfterRestart !== true
  ) {
    throw new Error("TWO_MAC_CONTINUITY_RESTART_FAILED");
  }
  if (report.logoutRevision !== 21 || report.logoutPropagated !== true) {
    throw new Error("TWO_MAC_CONTINUITY_LOGOUT_FAILED");
  }
  if (
    report.revokedActivationAbsent !== true ||
    report.revokedFetchRejected !== true ||
    report.grantDeleted !== true
  ) {
    throw new Error("TWO_MAC_CONTINUITY_REVOCATION_FAILED");
  }
  if (report.keychainMode !== "MOCK_TEST_ONLY") {
    throw new Error("TWO_MAC_CONTINUITY_KEYCHAIN_MODE_UNDECLARED");
  }
  return report;
}

export function assertOwnerCeremonyTwoMacContinuity(report) {
  assertTwoMacSiteSessionContinuity(report);
  if (
    report.ownerCeremony !== true ||
    report.ownerApprovedGrant !== true ||
    report.ownerObservedLogout !== true ||
    report.ownerStoppedHandoff !== true ||
    report.ownerDeletedHandoff !== true
  ) {
    throw new Error("TWO_MAC_OWNER_CEREMONY_FAILED");
  }
  return report;
}

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function createVillageId(prefix, now = Date.now()) {
  let time = now;
  let suffix = "";
  for (let index = 0; index < 10; index += 1) {
    suffix = alphabet[time % 32] + suffix;
    time = Math.floor(time / 32);
  }
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
    suffix += alphabet[byte & 31];
  }
  return `${prefix}_${suffix}`;
}

function publicKey(jwk) {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function createKeyMaterial() {
  const [
    sourceSigning,
    destinationSigning,
    sourceEncryption,
    destinationEncryption,
  ] = await Promise.all([
    crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]),
    crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]),
    crypto.subtle.generateKey("X25519", true, ["deriveBits"]),
    crypto.subtle.generateKey("X25519", true, ["deriveBits"]),
  ]);
  const exported = await Promise.all([
    crypto.subtle.exportKey("jwk", sourceSigning.privateKey),
    crypto.subtle.exportKey("jwk", sourceSigning.publicKey),
    crypto.subtle.exportKey("jwk", destinationSigning.privateKey),
    crypto.subtle.exportKey("jwk", destinationSigning.publicKey),
    crypto.subtle.exportKey("jwk", sourceEncryption.privateKey),
    crypto.subtle.exportKey("jwk", destinationEncryption.privateKey),
    crypto.subtle.exportKey("jwk", destinationEncryption.publicKey),
  ]);
  return {
    sourceSigningPrivateKey: exported[0],
    sourceSigningPublicKey: exported[1],
    destinationSigningPrivateKey: exported[2],
    destinationSigningPublicKey: exported[3],
    sourceEncryptionPrivateKey: exported[4],
    destinationEncryptionPrivateKey: exported[5],
    destinationEncryptionPublicKey: exported[6],
  };
}

async function responseJson(response) {
  const body = await response.json();
  if (!response.ok || body?.ok !== true) {
    throw new Error(
      body && typeof body.code === "string"
        ? body.code
        : `TWO_MAC_CONTROL_PLANE_${response.status}`,
    );
  }
  return body;
}

function ownerHeaders(principalId, csrf) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    cookie: `village_csrf=${csrf}`,
    origin: "http://localhost",
    "x-village-csrf": csrf,
    "x-village-development-principal": principalId,
  };
}

async function ownerRequest(
  baseUrl,
  principalId,
  csrf,
  pathname,
  options = {},
) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: options.method ?? "POST",
    headers: ownerHeaders(principalId, csrf),
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  return responseJson(response);
}

export async function awaitOwnerApprovedGrant({
  baseUrl,
  principalId,
  csrf,
  binding,
  timeoutMs = 15 * 60_000,
  pollIntervalMs = 1_000,
  request = fetch,
  pause = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = Date.now,
}) {
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    const snapshot = await responseJson(
      await request(new URL("/api/site-session-continuity/setup", baseUrl), {
        method: "GET",
        headers: ownerHeaders(principalId, csrf),
      }),
    );
    const approved = snapshot.grants?.find(
      (grant) =>
        grant.state === "ACTIVE" &&
        grant.site === "OWNED_FIXTURE" &&
        grant.sourceDeviceId === binding.sourceDeviceId &&
        grant.destinationDeviceId === binding.destinationDeviceId &&
        grant.sourceBrowserSessionId === binding.sourceBrowserSessionId &&
        grant.destinationBrowserSessionId ===
          binding.destinationBrowserSessionId,
    );
    if (approved) return approved;
    await pause(pollIntervalMs);
  }
  throw new Error("TWO_MAC_OWNER_APPROVAL_TIMEOUT");
}

export async function awaitOwnerGrantState({
  baseUrl,
  principalId,
  csrf,
  grantId,
  expectedState,
  timeoutMs = 15 * 60_000,
  pollIntervalMs = 1_000,
  request = fetch,
  pause = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = Date.now,
}) {
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    const status = await responseJson(
      await request(
        new URL(`/api/site-session-continuity/grants/${grantId}`, baseUrl),
        { method: "GET", headers: ownerHeaders(principalId, csrf) },
      ),
    );
    if (status.grant?.state === expectedState) return status;
    await pause(pollIntervalMs);
  }
  throw new Error("TWO_MAC_OWNER_GRANT_STATE_TIMEOUT");
}

export async function awaitOwnerDeletedGrant({
  baseUrl,
  principalId,
  csrf,
  grantId,
  timeoutMs = 15 * 60_000,
  pollIntervalMs = 1_000,
  request = fetch,
  pause = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = Date.now,
}) {
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    const response = await request(
      new URL(`/api/site-session-continuity/grants/${grantId}`, baseUrl),
      { method: "GET", headers: ownerHeaders(principalId, csrf) },
    );
    if (response.status === 404) return;
    await responseJson(response);
    await pause(pollIntervalMs);
  }
  throw new Error("TWO_MAC_OWNER_DELETION_TIMEOUT");
}

export async function createOwnerCeremonyConfiguration({
  configurationPath,
  controlPlane,
  principalId,
  csrf,
  sourceDeviceName,
  destinationDeviceName,
}) {
  await writeFile(
    configurationPath,
    JSON.stringify({ controlPlane, principalId, csrf }),
    { mode: 0o600 },
  );
  return {
    event: "OWNER_CEREMONY_READY",
    configurationPath,
    webOrigin: "http://localhost:5174",
    sourceDeviceName,
    destinationDeviceName,
  };
}

async function pairDevice({
  baseUrl,
  principalId,
  csrf,
  deviceId,
  displayName,
  signingPublicKey,
}) {
  const secret = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const secretHash = base64Url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
  );
  const challenge = await ownerRequest(
    baseUrl,
    principalId,
    csrf,
    "/api/pairing/challenges",
    {
      body: {
        deviceId,
        deviceDisplayName: displayName,
        publicKey: publicKey(signingPublicKey),
        protection: "OS_PROTECTED_FALLBACK",
        secretHash,
      },
    },
  );
  await ownerRequest(
    baseUrl,
    principalId,
    csrf,
    `/api/pairing/${challenge.pairingId}/confirm`,
  );
  await responseJson(
    await fetch(
      new URL(`/api/pairing/${challenge.pairingId}/consume`, baseUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ principalId, secret }),
      },
    ),
  );
}

async function createFixtureSession(baseUrl, principalId, csrf, deviceId) {
  const job = await ownerRequest(baseUrl, principalId, csrf, "/api/jobs");
  const browserSessionId = browserSessionIdSchema.parse(createVillageId("brs"));
  await ownerRequest(
    baseUrl,
    principalId,
    csrf,
    `/api/jobs/${job.jobId}/browser-sessions`,
    {
      body: {
        deviceId,
        browserSessionId,
        hostId: hostIdSchema.parse(createVillageId("hst")),
        site: "OWNED_FIXTURE",
      },
    },
  );
  return browserSessionId;
}

async function enrollDestinationKey({
  baseUrl,
  principalId,
  deviceId,
  browserSessionId,
  signingPrivateKey,
  encryptionPublicKey,
}) {
  const issuedAt = Date.now();
  const unsigned = {
    protocolVersion: 1,
    principalId,
    deviceId,
    browserSessionId,
    site: "OWNED_FIXTURE",
    sequence: 1,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + 30_000).toISOString(),
    encryptionPublicKey: publicKey(encryptionPublicKey),
  };
  const key = await crypto.subtle.importKey(
    "jwk",
    signingPrivateKey,
    "Ed25519",
    false,
    ["sign"],
  );
  const enrollment = continuityRecipientKeyEnrollmentSchema.parse({
    ...unsigned,
    signature: base64Url(
      await crypto.subtle.sign(
        "Ed25519",
        key,
        canonicalContinuityRecipientKeyEnrollmentBytes(unsigned),
      ),
    ),
  });
  return responseJson(
    await fetch(
      new URL("/api/site-session-continuity/recipient-keys", baseUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(enrollment),
      },
    ),
  );
}

async function launchLocal(executable, arguments_) {
  await execFileAsync(executable, arguments_, { cwd: root, timeout: 120_000 });
}

async function launchRemote(remoteHost, executable, arguments_) {
  await execFileAsync("ssh", [remoteHost, executable, ...arguments_], {
    cwd: root,
    timeout: 120_000,
  });
}

async function readJson(pathname) {
  return JSON.parse(await readFile(pathname, "utf8"));
}

async function machineIdentity(remoteHost) {
  const local = await execFileAsync("scutil", ["--get", "LocalHostName"]);
  const remote = await execFileAsync("ssh", [
    remoteHost,
    "scutil",
    "--get",
    "LocalHostName",
  ]);
  const sourceMachineId = local.stdout.trim();
  const destinationMachineId = remote.stdout.trim();
  return {
    sourceHost: sourceMachineId,
    destinationHost: destinationMachineId,
    sourceMachineId,
    destinationMachineId,
  };
}

async function installRemoteApplication(
  remoteHost,
  applicationPath,
  temporary,
) {
  const archive = path.join(temporary, "Village-continuity-e2e.zip");
  await execFileAsync("ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    applicationPath,
    archive,
  ]);
  const remote = await execFileAsync("ssh", [
    remoteHost,
    "mktemp",
    "-d",
    "/tmp/village-two-mac.XXXXXX",
  ]);
  const remoteRoot = remote.stdout.trim();
  if (!/^\/tmp\/village-two-mac\.[A-Za-z0-9]+$/.test(remoteRoot)) {
    throw new Error("TWO_MAC_REMOTE_TEMPORARY_PATH_UNSAFE");
  }
  try {
    await execFileAsync("scp", [
      archive,
      `${remoteHost}:${remoteRoot}/app.zip`,
    ]);
    await execFileAsync("ssh", [
      remoteHost,
      "ditto",
      "-x",
      "-k",
      `${remoteRoot}/app.zip`,
      remoteRoot,
    ]);
    return {
      remoteRoot,
      executable: `${remoteRoot}/Village.app/Contents/MacOS/Village`,
    };
  } catch (error) {
    await removeRemoteInstallation(remoteHost, remoteRoot);
    throw error;
  }
}

async function removeRemoteInstallation(remoteHost, remoteRoot) {
  if (!/^\/tmp\/village-two-mac\.[A-Za-z0-9]+$/.test(remoteRoot)) {
    throw new Error("TWO_MAC_REMOTE_TEMPORARY_PATH_UNSAFE");
  }
  await execFileAsync("ssh", [remoteHost, "rm", "-rf", remoteRoot]);
}

export async function runTwoMacSiteSessionContinuity({
  controlPlane,
  remoteHost,
  applicationPath = defaultApplicationPath,
  ownerCeremony = false,
  ownerEvent = (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
}) {
  const baseUrl = new URL(controlPlane);
  if (baseUrl.protocol !== "https:") {
    throw new Error("TWO_MAC_CONTROL_PLANE_URL_UNSAFE");
  }
  await verifyPackagedMac(applicationPath);
  const machines = await machineIdentity(remoteHost);
  if (machines.sourceMachineId === machines.destinationMachineId) {
    throw new Error("TWO_MAC_CONTINUITY_MACHINE_ISOLATION_FAILED");
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "village-two-mac-"));
  let remoteInstallation;
  let grantCleanup;
  try {
    const keys = await createKeyMaterial();
    const principalId = principalIdSchema.parse(createVillageId("prn"));
    const sourceDeviceId = deviceIdSchema.parse(createVillageId("dev"));
    const destinationDeviceId = deviceIdSchema.parse(createVillageId("dev"));
    const csrf = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    await Promise.all([
      pairDevice({
        baseUrl,
        principalId,
        csrf,
        deviceId: sourceDeviceId,
        displayName: machines.sourceHost,
        signingPublicKey: keys.sourceSigningPublicKey,
      }),
      pairDevice({
        baseUrl,
        principalId,
        csrf,
        deviceId: destinationDeviceId,
        displayName: machines.destinationHost,
        signingPublicKey: keys.destinationSigningPublicKey,
      }),
    ]);
    const [sourceBrowserSessionId, destinationBrowserSessionId] =
      await Promise.all([
        createFixtureSession(baseUrl, principalId, csrf, sourceDeviceId),
        createFixtureSession(baseUrl, principalId, csrf, destinationDeviceId),
      ]);
    await enrollDestinationKey({
      baseUrl,
      principalId,
      deviceId: destinationDeviceId,
      browserSessionId: destinationBrowserSessionId,
      signingPrivateKey: keys.destinationSigningPrivateKey,
      encryptionPublicKey: keys.destinationEncryptionPublicKey,
    });
    const preparedBinding = {
      sourceDeviceId,
      destinationDeviceId,
      sourceBrowserSessionId,
      destinationBrowserSessionId,
      site: "OWNED_FIXTURE",
    };
    let grant;
    if (ownerCeremony) {
      ownerEvent(
        await createOwnerCeremonyConfiguration({
          configurationPath: path.join(temporary, "owner-ceremony.json"),
          controlPlane: baseUrl.href,
          principalId,
          csrf,
          sourceDeviceName: machines.sourceHost,
          destinationDeviceName: machines.destinationHost,
        }),
      );
      grant = {
        grant: await awaitOwnerApprovedGrant({
          baseUrl,
          principalId,
          csrf,
          binding: preparedBinding,
        }),
      };
    } else {
      const grantId = continuityGrantIdSchema.parse(createVillageId("cgr"));
      grant = await ownerRequest(
        baseUrl,
        principalId,
        csrf,
        "/api/site-session-continuity/grants",
        {
          body: {
            grantId,
            ...preparedBinding,
            expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
          },
        },
      );
    }
    if (grant.grant?.state !== "ACTIVE") {
      throw new Error("TWO_MAC_CONTINUITY_GRANT_NOT_ACTIVE");
    }
    const grantId = continuityGrantIdSchema.parse(grant.grant.grantId);
    grantCleanup = { baseUrl, principalId, csrf, grantId };
    const binding = {
      principalId,
      grantId,
      sourceDeviceId,
      destinationDeviceId,
      sourceBrowserSessionId,
      destinationBrowserSessionId,
      site: "OWNED_FIXTURE",
    };
    const sourceIdentity = {
      principalId,
      deviceId: sourceDeviceId,
      browserSessionId: sourceBrowserSessionId,
      site: "OWNED_FIXTURE",
    };
    const destinationIdentity = {
      principalId,
      deviceId: destinationDeviceId,
      browserSessionId: destinationBrowserSessionId,
      site: "OWNED_FIXTURE",
    };
    const sourceConfig = path.join(temporary, "source-config.json");
    const destinationConfig = path.join(temporary, "destination-config.json");
    await Promise.all([
      writeFile(
        sourceConfig,
        JSON.stringify({
          role: "SOURCE",
          identity: sourceIdentity,
          binding,
          deviceSigningPrivateKey: keys.sourceSigningPrivateKey,
          recipientEncryptionPrivateKey: keys.sourceEncryptionPrivateKey,
        }),
        { mode: 0o600 },
      ),
      writeFile(
        destinationConfig,
        JSON.stringify({
          role: "DESTINATION",
          identity: destinationIdentity,
          binding,
          deviceSigningPrivateKey: keys.destinationSigningPrivateKey,
          recipientEncryptionPrivateKey: keys.destinationEncryptionPrivateKey,
        }),
        { mode: 0o600 },
      ),
    ]);
    remoteInstallation = await installRemoteApplication(
      remoteHost,
      applicationPath,
      temporary,
    );
    await execFileAsync("scp", [
      destinationConfig,
      `${remoteHost}:${remoteInstallation.remoteRoot}/destination-config.json`,
    ]);
    const sourceProfile = path.join(temporary, "source-profile");
    await mkdir(sourceProfile, { recursive: true, mode: 0o700 });
    const sourceReport = path.join(temporary, "source-report.json");
    const localExecutable = path.join(
      applicationPath,
      "Contents/MacOS/Village",
    );
    const sourceBase = [
      "--continuity-mode",
      "SOURCE",
      "--continuity-profile",
      sourceProfile,
      "--continuity-config",
      sourceConfig,
      "--continuity-control-plane",
      baseUrl.href,
    ];
    await launchLocal(localExecutable, [
      ...sourceBase,
      "--continuity-report",
      sourceReport,
      "--continuity-count",
      "20",
    ]);
    const source = await readJson(sourceReport);

    const destinationProfile = `${remoteInstallation.remoteRoot}/destination-profile`;
    const destinationConfigRemote = `${remoteInstallation.remoteRoot}/destination-config.json`;
    const remoteReport = (name) =>
      `${remoteInstallation.remoteRoot}/${name}.json`;
    const destinationBase = [
      "--continuity-profile",
      destinationProfile,
      "--continuity-config",
      destinationConfigRemote,
      "--continuity-control-plane",
      baseUrl.href,
    ];
    const runRemoteAndRead = async (mode, name) => {
      const report = remoteReport(name);
      await launchRemote(remoteHost, remoteInstallation.executable, [
        "--continuity-mode",
        mode,
        ...destinationBase,
        "--continuity-report",
        report,
      ]);
      const localReport = path.join(temporary, `${name}.json`);
      await execFileAsync("scp", [`${remoteHost}:${report}`, localReport]);
      return readJson(localReport);
    };
    const destination = await runRemoteAndRead("DESTINATION", "destination");
    const restart = await runRemoteAndRead("RESTART", "restart");

    const logoutSourceReport = path.join(temporary, "logout-source.json");
    await launchLocal(localExecutable, [
      ...sourceBase,
      "--continuity-report",
      logoutSourceReport,
      "--continuity-count",
      "0",
    ]);
    const logout = await runRemoteAndRead("DESTINATION", "logout");
    if (ownerCeremony) {
      const logoutStatus = await awaitOwnerGrantState({
        baseUrl,
        principalId,
        csrf,
        grantId,
        expectedState: "ACTIVE",
      });
      if (
        logoutStatus.transfer?.publishedRevision !== 21 ||
        logoutStatus.transfer?.appliedRevision !== 21 ||
        logoutStatus.transfer?.pendingRevisions !== 0
      ) {
        throw new Error("TWO_MAC_OWNER_LOGOUT_PROJECTION_FAILED");
      }
      ownerEvent({
        event: "OWNER_CEREMONY_LOGOUT_READY",
        grantId,
        publishedRevision: 21,
        appliedRevision: 21,
      });
      await awaitOwnerGrantState({
        baseUrl,
        principalId,
        csrf,
        grantId,
        expectedState: "REVOKED",
      });
    } else {
      await ownerRequest(
        baseUrl,
        principalId,
        csrf,
        `/api/site-session-continuity/grants/${grantId}/revoke`,
      );
    }
    const revoked = await runRemoteAndRead("REVOKED", "revoked");
    if (ownerCeremony) {
      ownerEvent({ event: "OWNER_CEREMONY_STOPPED", grantId });
      await awaitOwnerDeletedGrant({
        baseUrl,
        principalId,
        csrf,
        grantId,
      });
    } else {
      await ownerRequest(
        baseUrl,
        principalId,
        csrf,
        `/api/site-session-continuity/grants/${grantId}`,
        { method: "DELETE" },
      );
    }
    grantCleanup = undefined;
    const deleted = await fetch(
      new URL(`/api/site-session-continuity/grants/${grantId}`, baseUrl),
      { method: "GET", headers: ownerHeaders(principalId, csrf) },
    );
    const report = {
      status: "PASS",
      ...machines,
      transfersApplied: destination.applied,
      destinationRevision: destination.revision,
      restartRevision: restart.revision,
      restartNoNewRevision: restart.noNewRevision,
      authenticatedAfterRestart: restart.authenticated,
      logoutRevision: logout.revision,
      logoutPropagated: logout.authenticated === false,
      revokedActivationAbsent: revoked.activationAbsent,
      revokedFetchRejected: revoked.fetchRejected,
      grantDeleted: deleted.status === 404,
      destinationOfflineDuringPublish: true,
      sourceProfileDistinct: sourceProfile !== destinationProfile,
      destinationProfileDistinct: sourceProfile !== destinationProfile,
      keychainMode:
        source.keychainMode === "MOCK_TEST_ONLY" &&
        destination.keychainMode === "MOCK_TEST_ONLY" &&
        restart.keychainMode === "MOCK_TEST_ONLY"
          ? "MOCK_TEST_ONLY"
          : "UNKNOWN",
      site: "OWNED_FIXTURE",
      ...(ownerCeremony
        ? {
            ownerCeremony: true,
            ownerApprovedGrant: true,
            ownerObservedLogout: true,
            ownerStoppedHandoff: true,
            ownerDeletedHandoff: true,
          }
        : {}),
    };
    return ownerCeremony
      ? assertOwnerCeremonyTwoMacContinuity(report)
      : assertTwoMacSiteSessionContinuity(report);
  } finally {
    if (grantCleanup) {
      await ownerRequest(
        grantCleanup.baseUrl,
        grantCleanup.principalId,
        grantCleanup.csrf,
        `/api/site-session-continuity/grants/${grantCleanup.grantId}/revoke`,
      ).catch(() => undefined);
      await ownerRequest(
        grantCleanup.baseUrl,
        grantCleanup.principalId,
        grantCleanup.csrf,
        `/api/site-session-continuity/grants/${grantCleanup.grantId}`,
        { method: "DELETE" },
      ).catch(() => undefined);
    }
    if (remoteInstallation?.remoteRoot) {
      await removeRemoteInstallation(
        remoteHost,
        remoteInstallation.remoteRoot,
      ).catch(() => undefined);
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const controlPlane = argument("--control-plane");
  const remoteHost = argument("--remote-host");
  if (!controlPlane || !remoteHost) {
    throw new Error("TWO_MAC_CONTINUITY_ARGUMENTS_REQUIRED");
  }
  const report = await runTwoMacSiteSessionContinuity({
    controlPlane,
    remoteHost,
    ownerCeremony: process.argv.includes("--owner-ceremony"),
    ...(argument("--application")
      ? { applicationPath: path.resolve(argument("--application")) }
      : {}),
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
