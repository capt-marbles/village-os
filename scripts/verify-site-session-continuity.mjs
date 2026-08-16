import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  canonicalContinuityActivationRequestBytes,
  continuityActivationRequestSchema,
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

export function assertPackagedSiteSessionContinuity(report) {
  if (report.status !== "PASS") throw new Error("PACKAGED_CONTINUITY_FAILED");
  if (report.transfersApplied !== 20) {
    throw new Error("PACKAGED_CONTINUITY_TRANSFER_COUNT_INVALID");
  }
  if (report.duplicateEffects !== 0) {
    throw new Error("PACKAGED_CONTINUITY_DUPLICATE_EFFECT");
  }
  if (
    report.restartRevision !== 21 ||
    report.authenticatedAfterRestart !== false ||
    report.logoutPropagated !== true
  ) {
    throw new Error("PACKAGED_CONTINUITY_RESTART_OR_LOGOUT_FAILED");
  }
  if (
    report.revokedActivationAbsent !== true ||
    report.revokedFetchRejected !== true
  ) {
    throw new Error("PACKAGED_CONTINUITY_REVOCATION_FAILED");
  }
  if (report.badSignatureRejected !== true) {
    throw new Error("PACKAGED_CONTINUITY_ACTIVATION_AUTH_NOT_PROVEN");
  }
  if (
    report.sourceProfileDistinct !== true ||
    report.destinationProfileDistinct !== true
  ) {
    throw new Error("PACKAGED_CONTINUITY_PROFILE_ISOLATION_FAILED");
  }
  if (report.plaintextMailboxOccurrences !== 0) {
    throw new Error("PACKAGED_CONTINUITY_PLAINTEXT_LEAKED");
  }
  if (report.keychainMode !== "MOCK_TEST_ONLY") {
    throw new Error("PACKAGED_CONTINUITY_KEYCHAIN_MODE_UNDECLARED");
  }
  if (report.responseLossesObserved !== 1) {
    throw new Error("PACKAGED_CONTINUITY_RESPONSE_LOSS_NOT_PROVEN");
  }
  if (
    report.acknowledgedRevision !== 21 ||
    report.restartNoNewRevision !== true
  ) {
    throw new Error("PACKAGED_CONTINUITY_ACK_OR_RESTART_EVIDENCE_MISSING");
  }
  if (
    !Number.isInteger(report.sourceActivationRequests) ||
    report.sourceActivationRequests < 1 ||
    !Number.isInteger(report.destinationActivationRequests) ||
    report.destinationActivationRequests < 1
  ) {
    throw new Error("PACKAGED_CONTINUITY_ACTIVATION_PATH_MISSING");
  }
  return report;
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
  const [
    sourceSigningPrivateKey,
    sourceSigningPublicKey,
    destinationSigningPrivateKey,
    destinationSigningPublicKey,
    sourceEncryptionPrivateKey,
    destinationEncryptionPrivateKey,
    destinationEncryptionPublicKey,
  ] = await Promise.all([
    crypto.subtle.exportKey("jwk", sourceSigning.privateKey),
    crypto.subtle.exportKey("jwk", sourceSigning.publicKey),
    crypto.subtle.exportKey("jwk", destinationSigning.privateKey),
    crypto.subtle.exportKey("jwk", destinationSigning.publicKey),
    crypto.subtle.exportKey("jwk", sourceEncryption.privateKey),
    crypto.subtle.exportKey("jwk", destinationEncryption.privateKey),
    crypto.subtle.exportKey("jwk", destinationEncryption.publicKey),
  ]);
  return {
    sourceSigningPrivateKey,
    sourceSigningPublicKey,
    destinationSigningPrivateKey,
    destinationSigningPublicKey,
    sourceEncryptionPrivateKey,
    destinationEncryptionPrivateKey,
    destinationEncryptionPublicKey,
  };
}

function createMailboxServer() {
  const revisions = [];
  let acknowledgedRevision = 0;
  let revoked = false;
  let loseFirstPublishResponse = true;
  let responseLossesObserved = 0;
  let plaintextMailboxOccurrences = 0;
  const activationsByDevice = new Map();
  const activationRequests = new Map();
  const activationDevices = new Map();
  const activationSequences = new Map();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.includes("packaged-source-value-")) {
      plaintextMailboxOccurrences += 1;
    }
    const body = JSON.parse(text);
    const operation = request.url?.split("/").at(-1);
    if (operation === "activations") {
      const parsed = continuityActivationRequestSchema.safeParse(body);
      const configured = parsed.success
        ? activationDevices.get(parsed.data.deviceId)
        : undefined;
      const now = Date.now();
      const identityMatches =
        configured &&
        parsed.success &&
        parsed.data.principalId === configured.identity.principalId &&
        parsed.data.deviceId === configured.identity.deviceId &&
        parsed.data.browserSessionId === configured.identity.browserSessionId &&
        parsed.data.site === configured.identity.site;
      const current =
        parsed.success &&
        Date.parse(parsed.data.issuedAt) <= now + 5_000 &&
        Date.parse(parsed.data.expiresAt) > now;
      let signatureValid = false;
      if (configured && parsed.success && identityMatches && current) {
        try {
          const key = await crypto.subtle.importKey(
            "jwk",
            configured.signingPublicKey,
            "Ed25519",
            false,
            ["verify"],
          );
          const { signature, ...unsigned } = parsed.data;
          signatureValid = await crypto.subtle.verify(
            "Ed25519",
            key,
            Buffer.from(signature, "base64url"),
            canonicalContinuityActivationRequestBytes(unsigned),
          );
        } catch {
          signatureValid = false;
        }
      }
      const lastSequence = parsed.success
        ? (activationSequences.get(parsed.data.deviceId) ?? 0)
        : 0;
      const sequenceValid =
        parsed.success && parsed.data.sequence > lastSequence;
      if (
        !parsed.success ||
        !configured ||
        !identityMatches ||
        !current ||
        !signatureValid ||
        !sequenceValid
      ) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            code: !sequenceValid
              ? "CONTINUITY_ACTIVATION_REPLAYED"
              : !current
                ? "CONTINUITY_ACTIVATION_EXPIRED"
                : "INVALID_DEVICE_SIGNATURE",
          }),
        );
        return;
      }
      activationSequences.set(parsed.data.deviceId, parsed.data.sequence);
      activationRequests.set(
        parsed.data.deviceId,
        (activationRequests.get(parsed.data.deviceId) ?? 0) + 1,
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          activations: revoked
            ? []
            : (activationsByDevice.get(parsed.data.deviceId) ?? []),
        }),
      );
      return;
    }
    if (revoked) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ ok: false, code: "CONTINUITY_GRANT_NOT_FOUND" }),
      );
      return;
    }
    if (operation === "revisions") {
      const current = revisions.at(-1);
      let stored = false;
      if (!current) {
        revisions.push(body);
        stored = true;
      } else if (
        current.revision === body.revision &&
        current.digest === body.digest
      ) {
        // Idempotent response-loss retry.
      } else if (
        body.revision === current.revision + 1 &&
        body.previousDigest === current.digest
      ) {
        revisions.push(body);
        stored = true;
      } else {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            code: "CONTINUITY_REVISION_CHAIN_INVALID",
          }),
        );
        return;
      }
      if (loseFirstPublishResponse) {
        loseFirstPublishResponse = false;
        responseLossesObserved += 1;
        request.socket.destroy();
        return;
      }
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, stored }));
      return;
    }
    if (operation === "fetch") {
      const revision =
        revisions.find((entry) => entry.revision > body.afterRevision) ?? null;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, revision }));
      return;
    }
    if (operation === "acknowledgements") {
      const revision = revisions.find(
        (entry) => entry.revision === body.revision,
      );
      if (!revision || revision.digest !== body.digest) {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            code: "CONTINUITY_ACKNOWLEDGEMENT_INVALID",
          }),
        );
        return;
      }
      const acknowledged = body.revision > acknowledgedRevision;
      acknowledgedRevision = Math.max(acknowledgedRevision, body.revision);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, acknowledged }));
      return;
    }
    response.writeHead(404).end();
  });
  return {
    server,
    revoke: () => {
      revoked = true;
    },
    setActivation: (deviceId, activation, identity, signingPublicKey) => {
      activationsByDevice.set(deviceId, [activation]);
      activationDevices.set(deviceId, { identity, signingPublicKey });
    },
    evidence: () => ({
      revisions,
      acknowledgedRevision,
      plaintextMailboxOccurrences,
      responseLossesObserved,
      activationRequests,
    }),
  };
}

async function launch(executable, arguments_, timeoutMs = 60_000) {
  await execFileAsync(executable, arguments_, {
    cwd: root,
    timeout: timeoutMs,
  });
}

async function readReport(reportPath) {
  return JSON.parse(await readFile(reportPath, "utf8"));
}

async function proveBadActivationSignatureRejected(
  controlPlane,
  identity,
  wrongPrivateKey,
) {
  const issuedAt = Date.now();
  const unsigned = {
    protocolVersion: 1,
    ...identity,
    sequence: 1,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + 30_000).toISOString(),
  };
  const signature = await crypto.subtle.sign(
    "Ed25519",
    wrongPrivateKey,
    canonicalContinuityActivationRequestBytes(unsigned),
  );
  const request = continuityActivationRequestSchema.parse({
    ...unsigned,
    signature: Buffer.from(signature).toString("base64url"),
  });
  const response = await fetch(
    new URL("/api/site-session-continuity/activations", controlPlane),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    },
  );
  const body = await response.json();
  return response.status === 401 && body.code === "INVALID_DEVICE_SIGNATURE";
}

export async function runPackagedSiteSessionContinuity({
  applicationPath = defaultApplicationPath,
} = {}) {
  await verifyPackagedMac(applicationPath);
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "village-continuity-e2e-"),
  );
  const sourceProfile = path.join(temporary, "source-profile");
  const destinationProfile = path.join(temporary, "destination-profile");
  const sourceConfig = path.join(temporary, "source-config.json");
  const destinationConfig = path.join(temporary, "destination-config.json");
  const executable = path.join(applicationPath, "Contents/MacOS/Village");
  const binding = {
    principalId: "prn_01J00000000000000000000000",
    grantId: "cgr_01J00000000000000000000000",
    sourceDeviceId: "dev_01J00000000000000000000001",
    destinationDeviceId: "dev_01J00000000000000000000002",
    sourceBrowserSessionId: "brs_01J00000000000000000000001",
    destinationBrowserSessionId: "brs_01J00000000000000000000002",
    site: "OWNED_FIXTURE",
  };
  const mailbox = createMailboxServer();
  await new Promise((resolve) =>
    mailbox.server.listen(0, "127.0.0.1", resolve),
  );
  const address = mailbox.server.address();
  if (!address || typeof address === "string")
    throw new Error("PACKAGED_CONTINUITY_SERVER_FAILED");
  const controlPlane = `http://127.0.0.1:${address.port}`;
  try {
    await Promise.all([
      mkdir(sourceProfile, { recursive: true, mode: 0o700 }),
      mkdir(destinationProfile, { recursive: true, mode: 0o700 }),
    ]);
    const keys = await createKeyMaterial();
    const publicKey = (jwk) => ({
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
    });
    const sourceIdentity = {
      principalId: binding.principalId,
      deviceId: binding.sourceDeviceId,
      browserSessionId: binding.sourceBrowserSessionId,
      site: binding.site,
    };
    const destinationIdentity = {
      principalId: binding.principalId,
      deviceId: binding.destinationDeviceId,
      browserSessionId: binding.destinationBrowserSessionId,
      site: binding.site,
    };
    mailbox.setActivation(
      binding.sourceDeviceId,
      {
        role: "SOURCE",
        binding,
        peerSigningPublicKey: publicKey(keys.destinationSigningPublicKey),
        destinationEncryptionPublicKey: publicKey(
          keys.destinationEncryptionPublicKey,
        ),
      },
      sourceIdentity,
      publicKey(keys.sourceSigningPublicKey),
    );
    mailbox.setActivation(
      binding.destinationDeviceId,
      {
        role: "DESTINATION",
        binding,
        peerSigningPublicKey: publicKey(keys.sourceSigningPublicKey),
      },
      destinationIdentity,
      publicKey(keys.destinationSigningPublicKey),
    );
    const badSignatureRejected = await proveBadActivationSignatureRejected(
      controlPlane,
      sourceIdentity,
      await crypto.subtle.importKey(
        "jwk",
        keys.destinationSigningPrivateKey,
        "Ed25519",
        false,
        ["sign"],
      ),
    );
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

    const sourceReport = path.join(temporary, "source.json");
    const sourceBase = [
      "--continuity-mode",
      "SOURCE",
      "--continuity-profile",
      sourceProfile,
      "--continuity-config",
      sourceConfig,
      "--continuity-control-plane",
      controlPlane,
    ];
    const sourceArguments = [
      ...sourceBase,
      "--continuity-report",
      sourceReport,
      "--continuity-count",
      "20",
    ];
    await launch(executable, sourceArguments).then(
      () => {
        throw new Error("PACKAGED_CONTINUITY_RESPONSE_LOSS_NOT_OBSERVED");
      },
      () => undefined,
    );
    await launch(executable, sourceArguments);
    const source = await readReport(sourceReport);

    const destinationReport = path.join(temporary, "destination.json");
    const destinationBase = [
      "--continuity-profile",
      destinationProfile,
      "--continuity-config",
      destinationConfig,
      "--continuity-control-plane",
      controlPlane,
    ];
    await launch(executable, [
      "--continuity-mode",
      "DESTINATION",
      ...destinationBase,
      "--continuity-report",
      destinationReport,
    ]);
    const destination = await readReport(destinationReport);

    const logoutSourceReport = path.join(temporary, "logout-source.json");
    await launch(executable, [
      ...sourceBase,
      "--continuity-report",
      logoutSourceReport,
      "--continuity-count",
      "0",
    ]);
    const logoutDestinationReport = path.join(
      temporary,
      "logout-destination.json",
    );
    await launch(executable, [
      "--continuity-mode",
      "DESTINATION",
      ...destinationBase,
      "--continuity-report",
      logoutDestinationReport,
    ]);
    const logout = await readReport(logoutDestinationReport);

    const restartReport = path.join(temporary, "restart.json");
    await launch(executable, [
      "--continuity-mode",
      "RESTART",
      ...destinationBase,
      "--continuity-report",
      restartReport,
    ]);
    const restart = await readReport(restartReport);
    mailbox.revoke();
    const revokedReport = path.join(temporary, "revoked.json");
    await launch(executable, [
      "--continuity-mode",
      "REVOKED",
      ...destinationBase,
      "--continuity-report",
      revokedReport,
    ]);
    const revoked = await readReport(revokedReport);
    const evidence = mailbox.evidence();
    return assertPackagedSiteSessionContinuity({
      status: "PASS",
      transfersApplied: destination.applied,
      duplicateEffects: destination.applied - source.lastRevision,
      restartRevision: restart.revision,
      authenticatedAfterRestart: restart.authenticated,
      logoutPropagated:
        logout.authenticated === false && logout.revision === 21,
      revokedActivationAbsent: revoked.activationAbsent,
      revokedFetchRejected: revoked.fetchRejected,
      badSignatureRejected,
      sourceProfileDistinct: sourceProfile !== destinationProfile,
      destinationProfileDistinct: sourceProfile !== destinationProfile,
      plaintextMailboxOccurrences: evidence.plaintextMailboxOccurrences,
      keychainMode:
        source.keychainMode === "MOCK_TEST_ONLY" &&
        destination.keychainMode === "MOCK_TEST_ONLY" &&
        restart.keychainMode === "MOCK_TEST_ONLY"
          ? "MOCK_TEST_ONLY"
          : "UNKNOWN",
      responseLossesObserved: evidence.responseLossesObserved,
      acknowledgedRevision: evidence.acknowledgedRevision,
      restartNoNewRevision: restart.noNewRevision,
      sourceActivationRequests:
        evidence.activationRequests.get(binding.sourceDeviceId) ?? 0,
      destinationActivationRequests:
        evidence.activationRequests.get(binding.destinationDeviceId) ?? 0,
    });
  } finally {
    await new Promise((resolve) => mailbox.server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const appIndex = process.argv.indexOf("--app");
  console.log(
    JSON.stringify(
      await runPackagedSiteSessionContinuity({
        applicationPath:
          appIndex === -1 ? defaultApplicationPath : process.argv[appIndex + 1],
      }),
    ),
  );
}
