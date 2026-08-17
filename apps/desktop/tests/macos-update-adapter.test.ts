import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ElectronMacUpdateInstaller,
  MacOsUpdateArtifactVerifier,
} from "../src/main/macos-update-adapter.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("macOS update adapter", () => {
  it("derives product and signer evidence from the extracted signed app", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-update-verify-"));
    directories.push(root);
    const archive = join(root, "Village.zip");
    await writeFile(archive, Buffer.from("PK\u0003\u0004fixture"));
    const certificate = Buffer.from("leaf-certificate");
    const verifier = new MacOsUpdateArtifactVerifier({
      listArchiveEntries: async () => [
        "Village.app/",
        "Village.app/Contents/Info.plist",
      ],
      readArchiveTotals: async () => ({
        entryCount: 2,
        uncompressedBytes: 1_024,
      }),
      extractArchive: async (_archive, destination) => {
        await mkdir(join(destination, "Village.app"));
      },
      verifyCodeSignature: vi.fn(async () => undefined),
      extractLeafCertificate: async (_appPath, certificatePrefix) => {
        await writeFile(`${certificatePrefix}0`, certificate);
      },
      readBundleValue: vi.fn(async (_path, key) =>
        key === "CFBundleIdentifier" ? "com.village.desktop" : "1.1.0-alpha.1",
      ),
    });

    await expect(verifier.inspect(archive)).resolves.toEqual({
      productId: "com.village.desktop",
      version: "1.1.0-alpha.1",
      signerSha256:
        "0c8893630b087f7ab19a71c016e599cebc3b5235fd449e9917a43850edddaa38",
    });
  });

  it("rejects an archive without exactly one top-level app", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-update-shape-"));
    directories.push(root);
    const archive = join(root, "Village.zip");
    await writeFile(archive, Buffer.from("PK\u0003\u0004fixture"));
    const verifier = new MacOsUpdateArtifactVerifier({
      listArchiveEntries: async () => ["Village.app/", "Other.app/"],
      readArchiveTotals: async () => ({
        entryCount: 2,
        uncompressedBytes: 1_024,
      }),
      extractArchive: async (_archive, destination) => {
        await mkdir(join(destination, "Village.app"));
        await mkdir(join(destination, "Other.app"));
      },
      verifyCodeSignature: vi.fn(async () => undefined),
      extractLeafCertificate: vi.fn(async () => undefined),
      readBundleValue: vi.fn(async (_path, key) =>
        key === "CFBundleIdentifier" ? "com.village.desktop" : "1.1.0-alpha.1",
      ),
    });

    await expect(verifier.inspect(archive)).rejects.toThrowError(
      "UPDATE_ARCHIVE_SHAPE_INVALID",
    );
  });

  it("rejects traversal entries before extracting an untrusted archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-update-traversal-"));
    directories.push(root);
    const archive = join(root, "Village.zip");
    await writeFile(archive, Buffer.from("PK\u0003\u0004fixture"));
    const extractArchive = vi.fn(async () => undefined);
    const verifier = new MacOsUpdateArtifactVerifier({
      listArchiveEntries: async () => ["../escape", "Village.app/"],
      readArchiveTotals: async () => ({
        entryCount: 2,
        uncompressedBytes: 1_024,
      }),
      extractArchive,
      verifyCodeSignature: vi.fn(async () => undefined),
      extractLeafCertificate: vi.fn(async () => undefined),
      readBundleValue: vi.fn(async (_path, key) =>
        key === "CFBundleIdentifier" ? "com.village.desktop" : "1.1.0-alpha.1",
      ),
    });

    await expect(verifier.inspect(archive)).rejects.toThrowError(
      "UPDATE_ARCHIVE_SHAPE_INVALID",
    );
    expect(extractArchive).not.toHaveBeenCalled();
  });

  it("rejects an archive that expands beyond the temporary-disk budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-update-expansion-"));
    directories.push(root);
    const archive = join(root, "Village.zip");
    await writeFile(archive, Buffer.from("PK\u0003\u0004fixture"));
    const extractArchive = vi.fn(async () => undefined);
    const verifier = new MacOsUpdateArtifactVerifier({
      listArchiveEntries: async () => ["Village.app/"],
      readArchiveTotals: async () => ({
        entryCount: 1,
        uncompressedBytes: 2 * 1024 * 1024 * 1024 + 1,
      }),
      extractArchive,
      verifyCodeSignature: vi.fn(async () => undefined),
      extractLeafCertificate: vi.fn(async () => undefined),
      readBundleValue: vi.fn(async (_path, key) =>
        key === "CFBundleIdentifier" ? "com.village.desktop" : "1.1.0-alpha.1",
      ),
    });

    await expect(verifier.inspect(archive)).rejects.toThrowError(
      "UPDATE_ARCHIVE_SHAPE_INVALID",
    );
    expect(extractArchive).not.toHaveBeenCalled();
  });

  it("gives Electron only a private local feed for the already verified zip", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-update-stage-"));
    directories.push(root);
    const artifactPath = join(root, "Village.zip");
    await writeFile(artifactPath, Buffer.from("PK\u0003\u0004fixture"));
    class FakeAutoUpdater extends EventEmitter {
      readonly setFeedURL = vi.fn();
      readonly checkForUpdates = vi.fn(() => {
        queueMicrotask(() => {
          this.emit(
            "update-downloaded",
            {},
            "",
            "1.1.0-alpha.1",
            new Date(),
            pathToFileURL(artifactPath).toString(),
          );
        });
      });
      readonly quitAndInstall = vi.fn();
    }
    const autoUpdater = new FakeAutoUpdater();
    const installer = new ElectronMacUpdateInstaller(autoUpdater, {
      platform: "darwin",
      timeoutMs: 1_000,
    });

    await installer.stageVerifiedUpdate({
      version: "1.1.0-alpha.1",
      artifactPath,
    });
    const feedUrl = autoUpdater.setFeedURL.mock.calls[0]![0].url as string;
    const feed = JSON.parse(await readFile(new URL(feedUrl), "utf8")) as Record<
      string,
      unknown
    >;
    expect(feed).toEqual({
      currentRelease: "1.1.0-alpha.1",
      releases: [
        {
          version: "1.1.0-alpha.1",
          updateTo: {
            version: "1.1.0-alpha.1",
            url: pathToFileURL(artifactPath).toString(),
            name: "1.1.0-alpha.1",
            notes: "",
            pub_date: "1970-01-01T00:00:00.000Z",
          },
        },
      ],
    });
    installer.installPrepared();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched Squirrel evidence without preparing installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-update-mismatch-"));
    directories.push(root);
    const artifactPath = join(root, "Village.zip");
    await writeFile(artifactPath, Buffer.from("PK\u0003\u0004fixture"));
    class FakeAutoUpdater extends EventEmitter {
      readonly setFeedURL = vi.fn();
      readonly checkForUpdates = vi.fn(() => {
        queueMicrotask(() => {
          this.emit(
            "update-downloaded",
            {},
            "",
            "9.9.9",
            new Date(),
            pathToFileURL(artifactPath).toString(),
          );
        });
      });
      readonly quitAndInstall = vi.fn();
    }
    const installer = new ElectronMacUpdateInstaller(new FakeAutoUpdater(), {
      platform: "darwin",
      timeoutMs: 1_000,
    });

    await expect(
      installer.stageVerifiedUpdate({
        version: "1.1.0-alpha.1",
        artifactPath,
      }),
    ).rejects.toThrowError("UPDATE_STAGED_EVIDENCE_MISMATCH");
    expect(() => installer.installPrepared()).toThrowError(
      "UPDATE_NOT_PREPARED",
    );
  });

  it("accepts the same build-metadata version grammar as the trust parser", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-update-version-"));
    directories.push(root);
    const artifactPath = join(root, "Village.zip");
    await writeFile(artifactPath, Buffer.from("PK\u0003\u0004fixture"));
    class FakeAutoUpdater extends EventEmitter {
      readonly setFeedURL = vi.fn();
      readonly checkForUpdates = vi.fn(() => {
        queueMicrotask(() => {
          this.emit(
            "update-downloaded",
            {},
            "",
            "1.1.0+build.7",
            new Date(),
            pathToFileURL(artifactPath).toString(),
          );
        });
      });
      readonly quitAndInstall = vi.fn();
    }
    const installer = new ElectronMacUpdateInstaller(new FakeAutoUpdater(), {
      platform: "darwin",
      timeoutMs: 1_000,
    });

    await expect(
      installer.stageVerifiedUpdate({
        version: "1.1.0+build.7",
        artifactPath,
      }),
    ).resolves.toBeUndefined();
  });

  it("reports late auto-updater errors through the bounded background callback", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-update-background-"));
    directories.push(root);
    const artifactPath = join(root, "Village.zip");
    await writeFile(artifactPath, Buffer.from("PK\u0003\u0004fixture"));
    class FakeAutoUpdater extends EventEmitter {
      readonly setFeedURL = vi.fn();
      readonly checkForUpdates = vi.fn(() => {
        queueMicrotask(() => {
          this.emit(
            "update-downloaded",
            {},
            "",
            "1.1.0-alpha.1",
            new Date(),
            pathToFileURL(artifactPath).toString(),
          );
        });
      });
      readonly quitAndInstall = vi.fn();
    }
    const autoUpdater = new FakeAutoUpdater();
    const onBackgroundError = vi.fn();
    const installer = new ElectronMacUpdateInstaller(autoUpdater, {
      platform: "darwin",
      timeoutMs: 1_000,
      onBackgroundError,
    });

    await installer.stageVerifiedUpdate({
      version: "1.1.0-alpha.1",
      artifactPath,
    });
    const error = new Error("seeded late updater failure");
    autoUpdater.emit("error", error);

    expect(onBackgroundError).toHaveBeenCalledOnce();
    expect(onBackgroundError).toHaveBeenCalledWith(error);
  });
});
