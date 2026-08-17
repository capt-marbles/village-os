import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { basename, join } from "node:path";
import {
  VILLAGE_PRODUCT_ID,
  VILLAGE_UPDATE_CHANNEL,
  VILLAGE_UPDATE_ENDPOINT,
  isValidUpdateVersion,
  parseUpdateManifest,
  validateUpdateCandidate,
  type UpdateTrustPolicy,
  type UpdateValidation,
  type VillageUpdateManifest,
} from "./updater.js";
import type { LocalDiagnostic } from "./crash-reporting.js";

const manifestByteLimit = 64 * 1024;
const artifactByteLimit = 512 * 1024 * 1024;
const manifestRequestTimeoutMs = 30_000;
const artifactRequestTimeoutMs = 10 * 60_000;
const signerPattern = /^[a-f0-9]{64}$/;

export interface UpdateArtifactInspection {
  productId: string;
  version: string;
  signerSha256: string;
}

export interface UpdateArtifactVerifier {
  inspect(artifactPath: string): Promise<UpdateArtifactInspection>;
}

export interface VerifiedUpdateArtifact {
  version: string;
  artifactPath: string;
}

export interface UpdateInstaller {
  stageVerifiedUpdate(update: VerifiedUpdateArtifact): Promise<void>;
  installPrepared(): void;
}

export type DesktopUpdateResult =
  | { status: "NO_UPDATE" }
  | { status: "PREPARED"; version: string }
  | { status: "REJECTED"; code: UpdateRejectCode }
  | { status: "FAILED"; code: UpdateFailureCode; retriable: boolean };

type UpdateRejectCode =
  | Exclude<UpdateValidation, { ok: true }>["code"]
  | "MANIFEST_REDIRECT_DENIED"
  | "MANIFEST_TOO_LARGE"
  | "ARTIFACT_TOO_LARGE"
  | "ARTIFACT_NOT_ZIP"
  | "ARTIFACT_VERSION_MISMATCH";

type UpdateFailureCode =
  | "MANIFEST_UNAVAILABLE"
  | "ARTIFACT_UNAVAILABLE"
  | "ARTIFACT_INSPECTION_FAILED"
  | "UPDATE_STAGING_FAILED";

interface DesktopUpdateDependencies {
  policy: UpdateTrustPolicy;
  currentVersion: string;
  stagingRoot: string;
  fetch: typeof fetch;
  verifier: UpdateArtifactVerifier;
  installer: UpdateInstaller;
  manifestTimeoutMs?: number;
  artifactTimeoutMs?: number;
}

type UpdateDiagnosticTarget = {
  reportLocalDiagnostic(diagnostic: LocalDiagnostic): void;
};

type DesktopUpdateOperations = Pick<
  DesktopUpdateService,
  "checkAndStage" | "installPrepared"
>;

interface PackagedDesktopUpdateOptions {
  loadPolicy(): Promise<UpdateTrustPolicy | undefined>;
  createService(policy: UpdateTrustPolicy): DesktopUpdateOperations;
  confirmInstall(version: string): Promise<boolean>;
}

export function desktopUpdateFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): ReturnType<typeof fetch> {
  return globalThis.fetch(input, init);
}

class UpdateRuntimeFailure extends Error {
  constructor(
    readonly result: Exclude<DesktopUpdateResult, { status: "PREPARED" }>,
  ) {
    super(result.status);
  }
}

export class DesktopUpdateService {
  private inFlight: Promise<DesktopUpdateResult> | undefined;
  private preparedVersion: string | undefined;

  constructor(private readonly dependencies: DesktopUpdateDependencies) {}

  checkAndStage(): Promise<DesktopUpdateResult> {
    if (this.preparedVersion) {
      return Promise.resolve({
        status: "PREPARED",
        version: this.preparedVersion,
      });
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.performCheck().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  installPrepared(): void {
    if (!this.preparedVersion) throw new Error("UPDATE_NOT_PREPARED");
    this.dependencies.installer.installPrepared();
  }

  private async performCheck(): Promise<DesktopUpdateResult> {
    let stagingDirectory: string | undefined;
    try {
      const manifestRequest = await beginTimedFetch(
        this.dependencies.fetch,
        this.dependencies.policy.endpoint,
        "application/json",
        "MANIFEST_UNAVAILABLE",
        this.dependencies.manifestTimeoutMs ?? manifestRequestTimeoutMs,
      );
      let manifest: VillageUpdateManifest;
      let manifestUrl: string;
      try {
        const manifestResponse = manifestRequest.response;
        if (manifestResponse.status === 204) return { status: "NO_UPDATE" };
        rejectRedirect(manifestResponse, "MANIFEST_REDIRECT_DENIED");
        if (!manifestResponse.ok) {
          throw new UpdateRuntimeFailure({
            status: "FAILED",
            code: "MANIFEST_UNAVAILABLE",
            retriable: manifestResponse.status >= 500,
          });
        }
        const contentType = manifestResponse.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().startsWith("application/json")) {
          throw rejected("INVALID_UPDATE_METADATA");
        }
        manifestUrl = responseUrl(
          manifestResponse,
          this.dependencies.policy.endpoint,
        );
        manifest = parseManifestBytes(
          await readBoundedResponse(manifestResponse, manifestByteLimit),
        );
      } finally {
        manifestRequest.close();
      }
      prevalidateManifest(
        this.dependencies.policy,
        this.dependencies.currentVersion,
        manifest,
        manifestUrl,
      );

      const artifactRequest = await beginTimedFetch(
        this.dependencies.fetch,
        manifest.artifactUrl,
        "application/zip",
        "ARTIFACT_UNAVAILABLE",
        this.dependencies.artifactTimeoutMs ?? artifactRequestTimeoutMs,
      );
      let artifactFinalUrl: string;
      let artifactPath: string;
      let downloadedSha512: string;
      try {
        const artifactResponse = artifactRequest.response;
        rejectRedirect(artifactResponse, "ARTIFACT_REDIRECT_DENIED");
        if (!artifactResponse.ok) {
          throw new UpdateRuntimeFailure({
            status: "FAILED",
            code: "ARTIFACT_UNAVAILABLE",
            retriable: artifactResponse.status >= 500,
          });
        }
        artifactFinalUrl = responseUrl(artifactResponse, manifest.artifactUrl);
        stagingDirectory = await createStagingDirectory(
          this.dependencies.stagingRoot,
        );
        artifactPath = join(
          stagingDirectory,
          basename(new URL(manifest.artifactUrl).pathname),
        );
        downloadedSha512 = await downloadArtifact(
          artifactResponse,
          artifactPath,
        );
      } finally {
        artifactRequest.close();
      }
      const inspection = await inspectArtifact(
        this.dependencies.verifier,
        artifactPath,
      );
      if (inspection.version !== manifest.version) {
        throw rejected("ARTIFACT_VERSION_MISMATCH");
      }
      const validation = validateUpdateCandidate(
        this.dependencies.policy,
        this.dependencies.currentVersion,
        {
          productId: inspection.productId,
          channel: manifest.channel,
          version: inspection.version,
          requestedUrl: this.dependencies.policy.endpoint,
          finalUrl: manifestUrl,
          signerSha256: inspection.signerSha256,
          expectedSha512: manifest.sha512,
          downloadedSha512,
          artifactRequestedUrl: manifest.artifactUrl,
          artifactFinalUrl,
        },
      );
      if (!validation.ok) throw rejected(validation.code);
      stagingDirectory = undefined;
      try {
        await this.dependencies.installer.stageVerifiedUpdate({
          version: validation.version,
          artifactPath,
        });
      } catch {
        throw new UpdateRuntimeFailure({
          status: "FAILED",
          code: "UPDATE_STAGING_FAILED",
          retriable: false,
        });
      }
      this.preparedVersion = validation.version;
      return { status: "PREPARED", version: validation.version };
    } catch (error) {
      if (error instanceof UpdateRuntimeFailure) return error.result;
      return {
        status: "FAILED",
        code: "MANIFEST_UNAVAILABLE",
        retriable: true,
      };
    } finally {
      if (stagingDirectory) {
        await rm(stagingDirectory, { recursive: true, force: true });
      }
    }
  }
}

export function startNonBlockingDesktopUpdate<
  Window extends UpdateDiagnosticTarget,
>(
  window: Window,
  service: DesktopUpdateOperations,
  confirmInstall: (version: string) => Promise<boolean>,
): Window {
  void service
    .checkAndStage()
    .then(async (result) => {
      if (result.status === "NO_UPDATE") return;
      if (result.status === "PREPARED") {
        if (await confirmInstall(result.version)) service.installPrepared();
        return;
      }
      window.reportLocalDiagnostic({
        component: "UPDATER",
        code: `UPDATE_${result.code}`,
        retriable: result.status === "FAILED" ? result.retriable : false,
      });
    })
    .catch(() => {
      window.reportLocalDiagnostic({
        component: "UPDATER",
        code: "UPDATE_RUNTIME_FAILED",
        retriable: true,
      });
    });
  return window;
}

export function startPackagedDesktopUpdates<
  Window extends UpdateDiagnosticTarget,
>(window: Window, options: PackagedDesktopUpdateOptions): Window {
  void options
    .loadPolicy()
    .then((policy) => {
      if (!policy) return;
      startNonBlockingDesktopUpdate(
        window,
        options.createService(policy),
        options.confirmInstall,
      );
    })
    .catch(() => {
      window.reportLocalDiagnostic({
        component: "UPDATER",
        code: "UPDATE_TRUST_CONFIGURATION_INVALID",
        retriable: false,
      });
    });
  return window;
}

export async function loadPackagedUpdateTrustPolicy(
  appPath: string,
): Promise<UpdateTrustPolicy | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(appPath, "package.json"), "utf8");
  } catch {
    throw new Error("PACKAGED_UPDATE_TRUST_UNREADABLE");
  }
  if (Buffer.byteLength(raw, "utf8") > manifestByteLimit) {
    throw new Error("PACKAGED_UPDATE_TRUST_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PACKAGED_UPDATE_TRUST_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PACKAGED_UPDATE_TRUST_INVALID");
  }
  const record = parsed as Record<string, unknown>;
  const signerSha256 = record.villageUpdateSignerSha256;
  if (signerSha256 === undefined || signerSha256 === null) return undefined;
  if (
    record.name !== "@village/desktop" ||
    typeof signerSha256 !== "string" ||
    !signerPattern.test(signerSha256)
  ) {
    throw new Error("PACKAGED_UPDATE_TRUST_INVALID");
  }
  return {
    productId: VILLAGE_PRODUCT_ID,
    channel: VILLAGE_UPDATE_CHANNEL,
    endpoint: VILLAGE_UPDATE_ENDPOINT,
    signerSha256,
  };
}

async function beginTimedFetch(
  fetcher: typeof fetch,
  url: string,
  accept: string,
  failureCode: "MANIFEST_UNAVAILABLE" | "ARTIFACT_UNAVAILABLE",
  timeoutMs: number,
): Promise<{ response: Response; close(): void }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      method: "GET",
      headers: { accept },
      redirect: "manual",
      signal: controller.signal,
    });
    return {
      response,
      close: () => clearTimeout(timeout),
    };
  } catch {
    clearTimeout(timeout);
    throw new UpdateRuntimeFailure({
      status: "FAILED",
      code: failureCode,
      retriable: true,
    });
  }
}

function responseUrl(response: Response, requestedUrl: string): string {
  return response.url || requestedUrl;
}

function rejectRedirect(
  response: Response,
  code: "MANIFEST_REDIRECT_DENIED" | "ARTIFACT_REDIRECT_DENIED",
): void {
  if (response.status >= 300 && response.status < 400) {
    throw rejected(code);
  }
}

async function readBoundedResponse(
  response: Response,
  limit: number,
): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw rejected("MANIFEST_TOO_LARGE");
  }
  if (!response.body) throw rejected("INVALID_UPDATE_METADATA");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw rejected("MANIFEST_TOO_LARGE");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, length);
}

function parseManifestBytes(bytes: Buffer): VillageUpdateManifest {
  let input: unknown;
  try {
    input = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw rejected("INVALID_UPDATE_METADATA");
  }
  const manifest = parseUpdateManifest(input);
  if (!manifest) throw rejected("INVALID_UPDATE_METADATA");
  return manifest;
}

function prevalidateManifest(
  policy: UpdateTrustPolicy,
  currentVersion: string,
  manifest: VillageUpdateManifest,
  finalUrl: string,
): void {
  const validation = validateUpdateCandidate(policy, currentVersion, {
    productId: manifest.productId,
    channel: manifest.channel,
    version: manifest.version,
    requestedUrl: policy.endpoint,
    finalUrl,
    signerSha256: policy.signerSha256,
    expectedSha512: manifest.sha512,
    downloadedSha512: manifest.sha512,
    artifactRequestedUrl: manifest.artifactUrl,
    artifactFinalUrl: manifest.artifactUrl,
  });
  if (!validation.ok) throw rejected(validation.code);
}

async function downloadArtifact(
  response: Response,
  artifactPath: string,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (
    declared &&
    (!/^\d+$/.test(declared) || Number(declared) > artifactByteLimit)
  ) {
    throw rejected("ARTIFACT_TOO_LARGE");
  }
  if (!response.body) {
    throw new UpdateRuntimeFailure({
      status: "FAILED",
      code: "ARTIFACT_UNAVAILABLE",
      retriable: true,
    });
  }
  let handle;
  try {
    handle = await open(artifactPath, "wx", 0o600);
  } catch {
    throw stagingFailed();
  }
  const reader = response.body.getReader();
  const digest = createHash("sha512");
  let length = 0;
  let offset = 0;
  let prefix = Buffer.alloc(0);
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw artifactUnavailable();
      }
      const { done, value } = chunk;
      if (done) break;
      length += value.byteLength;
      if (length > artifactByteLimit) {
        await reader.cancel();
        throw rejected("ARTIFACT_TOO_LARGE");
      }
      const bytes = Buffer.from(value);
      if (prefix.length < 4) {
        prefix = Buffer.concat([prefix, bytes.subarray(0, 4 - prefix.length)]);
      }
      digest.update(bytes);
      try {
        await handle.write(bytes, 0, bytes.length, offset);
      } catch {
        throw stagingFailed();
      }
      offset += bytes.length;
    }
    try {
      await handle.sync();
    } catch {
      throw stagingFailed();
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (!prefix.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw rejected("ARTIFACT_NOT_ZIP");
  }
  return digest.digest("hex");
}

async function createStagingDirectory(stagingRoot: string): Promise<string> {
  try {
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    await chmod(stagingRoot, 0o700);
    const entries = await readdir(stagingRoot, { withFileTypes: true });
    await Promise.all(
      entries
        .filter(
          (entry) => entry.name.startsWith("candidate-") && entry.isDirectory(),
        )
        .map(async (entry) => {
          const candidatePath = join(stagingRoot, entry.name);
          const stat = await lstat(candidatePath);
          if (stat.isDirectory() && !stat.isSymbolicLink()) {
            await rm(candidatePath, { recursive: true, force: true });
          }
        }),
    );
    const directory = await mkdtemp(join(stagingRoot, "candidate-"));
    await chmod(directory, 0o700);
    return directory;
  } catch {
    throw stagingFailed();
  }
}

async function inspectArtifact(
  verifier: UpdateArtifactVerifier,
  artifactPath: string,
): Promise<UpdateArtifactInspection> {
  try {
    const inspection = await verifier.inspect(artifactPath);
    if (
      !inspection ||
      inspection.productId.length > 128 ||
      !isValidUpdateVersion(inspection.version) ||
      !signerPattern.test(inspection.signerSha256)
    ) {
      throw new Error("invalid");
    }
    return inspection;
  } catch {
    throw new UpdateRuntimeFailure({
      status: "FAILED",
      code: "ARTIFACT_INSPECTION_FAILED",
      retriable: false,
    });
  }
}

function rejected(code: UpdateRejectCode): UpdateRuntimeFailure {
  return new UpdateRuntimeFailure({ status: "REJECTED", code });
}

function artifactUnavailable(): UpdateRuntimeFailure {
  return new UpdateRuntimeFailure({
    status: "FAILED",
    code: "ARTIFACT_UNAVAILABLE",
    retriable: true,
  });
}

function stagingFailed(): UpdateRuntimeFailure {
  return new UpdateRuntimeFailure({
    status: "FAILED",
    code: "UPDATE_STAGING_FAILED",
    retriable: false,
  });
}
