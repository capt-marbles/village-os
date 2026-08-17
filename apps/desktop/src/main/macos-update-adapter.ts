import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type {
  UpdateArtifactVerifier,
  UpdateInstaller,
  VerifiedUpdateArtifact,
} from "./update-runtime.js";
import { isValidUpdateVersion } from "./updater.js";

const execFileAsync = promisify(execFile);
const archiveUncompressedByteLimit = 2 * 1024 * 1024 * 1024;

interface MacOsArtifactInspectionDependencies {
  listArchiveEntries(archivePath: string): Promise<readonly string[]>;
  readArchiveTotals(
    archivePath: string,
  ): Promise<{ entryCount: number; uncompressedBytes: number }>;
  extractArchive(archivePath: string, destination: string): Promise<void>;
  verifyCodeSignature(appPath: string): Promise<void>;
  extractLeafCertificate(
    appPath: string,
    certificatePrefix: string,
  ): Promise<void>;
  readBundleValue(infoPlistPath: string, key: string): Promise<string>;
}

const macOsInspectionDefaults: MacOsArtifactInspectionDependencies = {
  async listArchiveEntries(archivePath) {
    const { stdout } = await execFileAsync(
      "/usr/bin/unzip",
      ["-Z1", archivePath],
      { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 },
    );
    return stdout.split("\n").filter(Boolean);
  },
  async readArchiveTotals(archivePath) {
    const { stdout } = await execFileAsync(
      "/usr/bin/unzip",
      ["-Z", "-t", archivePath],
      { timeout: 30_000, maxBuffer: 64 * 1024 },
    );
    const match =
      /^(\d+) files?, (\d+) bytes uncompressed, (\d+) bytes compressed:/m.exec(
        stdout,
      );
    if (!match) throw new Error("UPDATE_ARCHIVE_SHAPE_INVALID");
    return {
      entryCount: Number(match[1]),
      uncompressedBytes: Number(match[2]),
    };
  },
  async extractArchive(archivePath, destination) {
    await execFileAsync(
      "/usr/bin/ditto",
      ["-x", "-k", archivePath, destination],
      {
        timeout: 60_000,
        maxBuffer: 64 * 1024,
      },
    );
  },
  async verifyCodeSignature(appPath) {
    await execFileAsync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", "--verbose=2", appPath],
      { timeout: 60_000, maxBuffer: 64 * 1024 },
    );
  },
  async extractLeafCertificate(appPath, certificatePrefix) {
    await execFileAsync(
      "/usr/bin/codesign",
      ["--display", "--extract-certificates", certificatePrefix, appPath],
      { timeout: 30_000, maxBuffer: 64 * 1024 },
    );
  },
  async readBundleValue(infoPlistPath, key) {
    const { stdout } = await execFileAsync(
      "/usr/bin/plutil",
      ["-extract", key, "raw", "-o", "-", infoPlistPath],
      { timeout: 30_000, maxBuffer: 4 * 1024 },
    );
    return stdout.trim();
  },
};

export class MacOsUpdateArtifactVerifier implements UpdateArtifactVerifier {
  constructor(
    private readonly dependencies: MacOsArtifactInspectionDependencies = macOsInspectionDefaults,
  ) {}

  async inspect(artifactPath: string) {
    if (process.platform !== "darwin") {
      throw new Error("UPDATE_PLATFORM_UNSUPPORTED");
    }
    const extractionRoot = await mkdtemp(join(tmpdir(), "village-update-"));
    await chmod(extractionRoot, 0o700);
    try {
      const [archiveEntries, totals] = await Promise.all([
        this.dependencies.listArchiveEntries(artifactPath),
        this.dependencies.readArchiveTotals(artifactPath),
      ]);
      validateArchiveEntries(archiveEntries, totals);
      await this.dependencies.extractArchive(artifactPath, extractionRoot);
      const extractedEntries = (await readdir(extractionRoot)).filter(
        (entry) => entry !== "__MACOSX",
      );
      if (
        extractedEntries.length !== 1 ||
        !extractedEntries[0]!.endsWith(".app")
      ) {
        throw new Error("UPDATE_ARCHIVE_SHAPE_INVALID");
      }
      const appPath = resolve(extractionRoot, extractedEntries[0]!);
      if (!appPath.startsWith(`${resolve(extractionRoot)}/`)) {
        throw new Error("UPDATE_ARCHIVE_SHAPE_INVALID");
      }
      const appStat = await lstat(appPath);
      if (!appStat.isDirectory() || appStat.isSymbolicLink()) {
        throw new Error("UPDATE_ARCHIVE_SHAPE_INVALID");
      }
      await this.dependencies.verifyCodeSignature(appPath);
      const certificatePrefix = join(extractionRoot, "signer-certificate-");
      await this.dependencies.extractLeafCertificate(
        appPath,
        certificatePrefix,
      );
      const certificate = await readFile(`${certificatePrefix}0`);
      if (!certificate.length) throw new Error("UPDATE_SIGNER_INVALID");
      const infoPlistPath = join(appPath, "Contents", "Info.plist");
      const [productId, version] = await Promise.all([
        this.dependencies.readBundleValue(infoPlistPath, "CFBundleIdentifier"),
        this.dependencies.readBundleValue(
          infoPlistPath,
          "CFBundleShortVersionString",
        ),
      ]);
      if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(productId)) {
        throw new Error("UPDATE_PRODUCT_ID_INVALID");
      }
      if (!isValidUpdateVersion(version)) {
        throw new Error("UPDATE_VERSION_INVALID");
      }
      return {
        productId,
        version,
        signerSha256: createHash("sha256").update(certificate).digest("hex"),
      };
    } finally {
      await rm(extractionRoot, { recursive: true, force: true });
    }
  }
}

function validateArchiveEntries(
  entries: readonly string[],
  totals: { entryCount: number; uncompressedBytes: number },
): void {
  if (
    !entries.length ||
    entries.length > 20_000 ||
    totals.entryCount !== entries.length ||
    !Number.isSafeInteger(totals.uncompressedBytes) ||
    totals.uncompressedBytes < 0 ||
    totals.uncompressedBytes > archiveUncompressedByteLimit
  ) {
    throw new Error("UPDATE_ARCHIVE_SHAPE_INVALID");
  }
  let appRoot: string | undefined;
  for (const entry of entries) {
    if (
      !entry ||
      Buffer.byteLength(entry, "utf8") > 1_024 ||
      entry.startsWith("/") ||
      entry.includes("\\") ||
      entry.includes("\0")
    ) {
      throw new Error("UPDATE_ARCHIVE_SHAPE_INVALID");
    }
    const segments = entry.replace(/\/$/, "").split("/");
    if (
      !segments.length ||
      segments.some(
        (segment) => !segment || segment === "." || segment === "..",
      )
    ) {
      throw new Error("UPDATE_ARCHIVE_SHAPE_INVALID");
    }
    if (segments[0] === "__MACOSX") continue;
    if (!segments[0]!.endsWith(".app")) {
      throw new Error("UPDATE_ARCHIVE_SHAPE_INVALID");
    }
    appRoot ??= segments[0];
    if (segments[0] !== appRoot) {
      throw new Error("UPDATE_ARCHIVE_SHAPE_INVALID");
    }
  }
  if (!appRoot) throw new Error("UPDATE_ARCHIVE_SHAPE_INVALID");
}

type UpdateDownloadedListener = (
  event: unknown,
  releaseNotes: string,
  releaseName: string,
  releaseDate: Date,
  updateUrl: string,
) => void;
type UpdateUnavailableListener = () => void;
type UpdateErrorListener = (error: Error) => void;

interface ElectronAutoUpdaterPort {
  setFeedURL(options: { url: string; serverType: "json" }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  on(event: "update-downloaded", listener: UpdateDownloadedListener): unknown;
  on(
    event: "update-not-available",
    listener: UpdateUnavailableListener,
  ): unknown;
  on(event: "error", listener: UpdateErrorListener): unknown;
  removeListener(
    event: "update-downloaded",
    listener: UpdateDownloadedListener,
  ): unknown;
  removeListener(
    event: "update-not-available",
    listener: UpdateUnavailableListener,
  ): unknown;
  removeListener(event: "error", listener: UpdateErrorListener): unknown;
}

interface ElectronMacUpdateInstallerOptions {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  onBackgroundError?: UpdateErrorListener;
}

export class ElectronMacUpdateInstaller implements UpdateInstaller {
  private prepared = false;
  private activeStages = 0;
  private readonly platform: NodeJS.Platform;
  private readonly timeoutMs: number;
  private readonly onBackgroundError: UpdateErrorListener;
  private readonly backgroundErrorListener: UpdateErrorListener;

  constructor(
    private readonly autoUpdater: ElectronAutoUpdaterPort,
    options: ElectronMacUpdateInstallerOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.onBackgroundError = options.onBackgroundError ?? (() => undefined);
    this.backgroundErrorListener = (error) => {
      if (this.activeStages === 0) this.onBackgroundError(error);
    };
    this.autoUpdater.on("error", this.backgroundErrorListener);
  }

  async stageVerifiedUpdate(update: VerifiedUpdateArtifact): Promise<void> {
    if (this.platform !== "darwin") {
      throw new Error("UPDATE_PLATFORM_UNSUPPORTED");
    }
    if (!isValidUpdateVersion(update.version)) {
      throw new Error("UPDATE_VERSION_INVALID");
    }
    const artifactPath = resolve(update.artifactPath);
    const artifactStat = await lstat(artifactPath);
    if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) {
      throw new Error("UPDATE_ARTIFACT_INVALID");
    }
    const artifactUrl = pathToFileURL(artifactPath).toString();
    const feedPath = join(dirname(artifactPath), "manifest.json");
    await writeFile(
      feedPath,
      JSON.stringify({
        currentRelease: update.version,
        releases: [
          {
            version: update.version,
            updateTo: {
              version: update.version,
              url: artifactUrl,
              name: update.version,
              notes: "",
              pub_date: new Date(0).toISOString(),
            },
          },
        ],
      }),
      { mode: 0o600, flag: "wx" },
    );
    await chmod(feedPath, 0o600);

    this.activeStages += 1;
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const cleanup = () => {
          clearTimeout(timeout);
          this.autoUpdater.removeListener("update-downloaded", onDownloaded);
          this.autoUpdater.removeListener(
            "update-not-available",
            onUnavailable,
          );
          this.autoUpdater.removeListener("error", onError);
        };
        const finish = (error?: Error) => {
          cleanup();
          if (error) rejectPromise(error);
          else resolvePromise();
        };
        const onDownloaded = (
          _event: unknown,
          _releaseNotes: string,
          releaseName: string,
          _releaseDate: Date,
          updateUrl: string,
        ) => {
          try {
            if (
              releaseName !== update.version ||
              fileURLToPath(updateUrl) !== artifactPath
            ) {
              finish(new Error("UPDATE_STAGED_EVIDENCE_MISMATCH"));
              return;
            }
            this.prepared = true;
            finish();
          } catch {
            finish(new Error("UPDATE_STAGED_EVIDENCE_MISMATCH"));
          }
        };
        const onUnavailable = () =>
          finish(new Error("UPDATE_STAGING_UNAVAILABLE"));
        const onError = () => finish(new Error("UPDATE_STAGING_FAILED"));
        const timeout = setTimeout(
          () => finish(new Error("UPDATE_STAGING_TIMEOUT")),
          this.timeoutMs,
        );
        this.autoUpdater.on("update-downloaded", onDownloaded);
        this.autoUpdater.on("update-not-available", onUnavailable);
        this.autoUpdater.on("error", onError);
        try {
          this.autoUpdater.setFeedURL({
            url: pathToFileURL(feedPath).toString(),
            serverType: "json",
          });
          this.autoUpdater.checkForUpdates();
        } catch {
          finish(new Error("UPDATE_STAGING_FAILED"));
        }
      });
    } finally {
      this.activeStages -= 1;
    }
  }

  installPrepared(): void {
    if (!this.prepared) throw new Error("UPDATE_NOT_PREPARED");
    this.autoUpdater.quitAndInstall();
  }
}
