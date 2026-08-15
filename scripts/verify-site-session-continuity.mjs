import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { verifyPackagedMac } from "./verify-packaged-mac.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultApplicationPath = path.join(
  root,
  "apps/desktop/dist/continuity-e2e",
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
  if (report.revokedFetchRejected !== true) {
    throw new Error("PACKAGED_CONTINUITY_REVOCATION_FAILED");
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
  return report;
}

async function createKeyMaterial() {
  const sourceSigning = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  const destinationSigning = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  const destinationEncryption = await crypto.subtle.generateKey(
    "X25519",
    true,
    ["deriveBits"],
  );
  return {
    sourceSigningPrivateKey: await crypto.subtle.exportKey(
      "jwk",
      sourceSigning.privateKey,
    ),
    sourceSigningPublicKey: await crypto.subtle.exportKey(
      "jwk",
      sourceSigning.publicKey,
    ),
    destinationSigningPrivateKey: await crypto.subtle.exportKey(
      "jwk",
      destinationSigning.privateKey,
    ),
    destinationEncryptionPrivateKey: await crypto.subtle.exportKey(
      "jwk",
      destinationEncryption.privateKey,
    ),
    destinationEncryptionPublicKey: await crypto.subtle.exportKey(
      "jwk",
      destinationEncryption.publicKey,
    ),
  };
}

function createMailboxServer() {
  const revisions = [];
  let acknowledgedRevision = 0;
  let revoked = false;
  let loseFirstPublishResponse = true;
  let plaintextMailboxOccurrences = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.includes("packaged-source-value-")) {
      plaintextMailboxOccurrences += 1;
    }
    const body = JSON.parse(text);
    const operation = request.url?.split("/").at(-1);
    if (revoked) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ ok: false, code: "CONTINUITY_GRANT_NOT_FOUND" }),
      );
      return;
    }
    if (operation === "revisions") {
      const current = revisions.at(-1);
      if (!current) revisions.push(body);
      else if (
        current.revision === body.revision &&
        current.digest === body.digest
      ) {
        // Idempotent response-loss retry.
      } else if (
        body.revision === current.revision + 1 &&
        body.previousDigest === current.digest
      )
        revisions.push(body);
      else {
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
        request.socket.destroy();
        return;
      }
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, stored: current !== body }));
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
    evidence: () => ({
      revisions,
      acknowledgedRevision,
      plaintextMailboxOccurrences,
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
  const mailbox = createMailboxServer();
  await new Promise((resolve) =>
    mailbox.server.listen(0, "127.0.0.1", resolve),
  );
  const address = mailbox.server.address();
  if (!address || typeof address === "string")
    throw new Error("PACKAGED_CONTINUITY_SERVER_FAILED");
  const controlPlane = `http://127.0.0.1:${address.port}`;
  const binding = {
    principalId: "prn_01J00000000000000000000000",
    grantId: "cgr_01J00000000000000000000000",
    sourceDeviceId: "dev_01J00000000000000000000001",
    destinationDeviceId: "dev_01J00000000000000000000002",
    sourceBrowserSessionId: "brs_01J00000000000000000000001",
    destinationBrowserSessionId: "brs_01J00000000000000000000002",
    site: "OWNED_FIXTURE",
  };
  try {
    await Promise.all([
      mkdir(sourceProfile, { recursive: true, mode: 0o700 }),
      mkdir(destinationProfile, { recursive: true, mode: 0o700 }),
    ]);
    const keys = await createKeyMaterial();
    await writeFile(
      sourceConfig,
      JSON.stringify({
        role: "SOURCE",
        binding,
        sourceSigningPrivateKey: keys.sourceSigningPrivateKey,
        destinationEncryptionPublicKey: keys.destinationEncryptionPublicKey,
      }),
      { mode: 0o600 },
    );
    await writeFile(
      destinationConfig,
      JSON.stringify({
        role: "DESTINATION",
        binding,
        destinationSigningPrivateKey: keys.destinationSigningPrivateKey,
        destinationEncryptionPrivateKey: keys.destinationEncryptionPrivateKey,
        sourceSigningPublicKey: keys.sourceSigningPublicKey,
      }),
      { mode: 0o600 },
    );

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
      "--continuity-target",
      "20",
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
      "--continuity-target",
      "21",
    ]);
    const logout = await readReport(logoutDestinationReport);

    const restartReport = path.join(temporary, "restart.json");
    await launch(executable, [
      "--continuity-mode",
      "RESTART",
      ...destinationBase,
      "--continuity-report",
      restartReport,
      "--continuity-target",
      "21",
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
      revokedFetchRejected: revoked.rejected,
      sourceProfileDistinct: sourceProfile !== destinationProfile,
      destinationProfileDistinct: sourceProfile !== destinationProfile,
      plaintextMailboxOccurrences: evidence.plaintextMailboxOccurrences,
      keychainMode:
        source.keychainMode === "MOCK_TEST_ONLY" &&
        destination.keychainMode === "MOCK_TEST_ONLY" &&
        restart.keychainMode === "MOCK_TEST_ONLY"
          ? "MOCK_TEST_ONLY"
          : "UNKNOWN",
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
