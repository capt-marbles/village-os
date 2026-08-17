import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DesktopUpdateService,
  loadPackagedUpdateTrustPolicy,
  startNonBlockingDesktopUpdate,
  startPackagedDesktopUpdates,
  type UpdateArtifactVerifier,
  type UpdateInstaller,
} from "../src/main/update-runtime.js";
import {
  VILLAGE_UPDATE_ARTIFACT_BASE_URL,
  VILLAGE_UPDATE_ENDPOINT,
  type UpdateTrustPolicy,
} from "../src/main/updater.js";

const directories: string[] = [];
const signerSha256 =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const artifactUrl = `${VILLAGE_UPDATE_ARTIFACT_BASE_URL}village-1.1.0-alpha.1-arm64.zip`;
const artifactBytes = Buffer.from("PK\u0003\u0004signed-village-update");

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function response(body: BodyInit | null, init: ResponseInit = {}): Response {
  return new Response(body, init);
}

async function createService(
  overrides: {
    fetch?: typeof fetch;
    verifier?: UpdateArtifactVerifier;
    installer?: UpdateInstaller;
    manifestTimeoutMs?: number;
    artifactTimeoutMs?: number;
  } = {},
) {
  const stagingRoot = await mkdtemp(join(tmpdir(), "village-updater-"));
  directories.push(stagingRoot);
  const policy: UpdateTrustPolicy = {
    productId: "com.village.desktop",
    channel: "alpha",
    endpoint: VILLAGE_UPDATE_ENDPOINT,
    signerSha256,
  };
  const installer = overrides.installer ?? {
    stageVerifiedUpdate: vi.fn(async () => undefined),
    installPrepared: vi.fn(),
  };
  const verifier = overrides.verifier ?? {
    inspect: vi.fn(async () => ({
      productId: "com.village.desktop",
      version: "1.1.0-alpha.1",
      signerSha256,
    })),
  };
  const fetcher =
    overrides.fetch ??
    vi.fn(async (url: string | URL) => {
      const value = url.toString();
      if (value === VILLAGE_UPDATE_ENDPOINT) {
        return response(
          JSON.stringify({
            productId: "com.village.desktop",
            channel: "alpha",
            version: "1.1.0-alpha.1",
            artifactUrl,
            sha512: "unused-in-red-test",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return response(artifactBytes, {
        status: 200,
        headers: { "content-length": String(artifactBytes.byteLength) },
      });
    });
  return {
    service: new DesktopUpdateService({
      policy,
      currentVersion: "1.0.0",
      stagingRoot,
      fetch: fetcher,
      verifier,
      installer,
      ...(overrides.manifestTimeoutMs === undefined
        ? {}
        : { manifestTimeoutMs: overrides.manifestTimeoutMs }),
      ...(overrides.artifactTimeoutMs === undefined
        ? {}
        : { artifactTimeoutMs: overrides.artifactTimeoutMs }),
    }),
    fetcher,
    installer,
    verifier,
    stagingRoot,
  };
}

describe("desktop update runtime", () => {
  it("downloads once, validates actual artifact evidence, and stages only the verified update", async () => {
    const sha512 = await import("node:crypto").then(({ createHash }) =>
      createHash("sha512").update(artifactBytes).digest("hex"),
    );
    let stagedBytes: Buffer | undefined;
    let stagedPath: string | undefined;
    const installer: UpdateInstaller = {
      stageVerifiedUpdate: vi.fn(async ({ artifactPath }) => {
        stagedPath = artifactPath;
        stagedBytes = await readFile(artifactPath);
      }),
      installPrepared: vi.fn(),
    };
    const { service, fetcher, verifier } = await createService({
      installer,
      fetch: vi.fn(async (url: string | URL) => {
        if (url.toString() === VILLAGE_UPDATE_ENDPOINT) {
          return response(
            JSON.stringify({
              productId: "com.village.desktop",
              channel: "alpha",
              version: "1.1.0-alpha.1",
              artifactUrl,
              sha512,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return response(artifactBytes, {
          status: 200,
          headers: { "content-length": String(artifactBytes.byteLength) },
        });
      }),
    });

    const [first, second] = await Promise.all([
      service.checkAndStage(),
      service.checkAndStage(),
    ]);

    expect(first).toEqual({ status: "PREPARED", version: "1.1.0-alpha.1" });
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(verifier.inspect).toHaveBeenCalledTimes(1);
    expect(installer.stageVerifiedUpdate).toHaveBeenCalledTimes(1);
    expect(stagedBytes).toEqual(artifactBytes);
    await expect(readFile(stagedPath!)).resolves.toEqual(artifactBytes);
  });

  it("rejects redirects and never gives the installer an unvalidated artifact", async () => {
    const installer: UpdateInstaller = {
      stageVerifiedUpdate: vi.fn(async () => undefined),
      installPrepared: vi.fn(),
    };
    const { service } = await createService({
      installer,
      fetch: vi.fn(async () =>
        response(null, {
          status: 302,
          headers: { location: "https://attacker.invalid/manifest.json" },
        }),
      ),
    });

    await expect(service.checkAndStage()).resolves.toEqual({
      status: "REJECTED",
      code: "MANIFEST_REDIRECT_DENIED",
    });
    expect(installer.stageVerifiedUpdate).not.toHaveBeenCalled();
  });

  it("classifies an artifact network failure without leaking it as a manifest failure", async () => {
    const sha512 = "a".repeat(128);
    const { service, installer } = await createService({
      fetch: vi.fn(async (url: string | URL) => {
        if (url.toString() === VILLAGE_UPDATE_ENDPOINT) {
          return response(
            JSON.stringify({
              productId: "com.village.desktop",
              channel: "alpha",
              version: "1.1.0-alpha.1",
              artifactUrl,
              sha512,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new TypeError("seeded network detail must not escape");
      }),
    });

    await expect(service.checkAndStage()).resolves.toEqual({
      status: "FAILED",
      code: "ARTIFACT_UNAVAILABLE",
      retriable: true,
    });
    expect(installer.stageVerifiedUpdate).not.toHaveBeenCalled();
  });

  it("classifies an artifact stream failure as retriable artifact unavailability", async () => {
    const sha512 = "a".repeat(128);
    const brokenArtifact = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("seeded stream detail must not escape"));
      },
    });
    const { service, installer } = await createService({
      fetch: vi.fn(async (url: string | URL) => {
        if (url.toString() === VILLAGE_UPDATE_ENDPOINT) {
          return response(
            JSON.stringify({
              productId: "com.village.desktop",
              channel: "alpha",
              version: "1.1.0-alpha.1",
              artifactUrl,
              sha512,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return response(brokenArtifact, { status: 200 });
      }),
    });

    await expect(service.checkAndStage()).resolves.toEqual({
      status: "FAILED",
      code: "ARTIFACT_UNAVAILABLE",
      retriable: true,
    });
    expect(installer.stageVerifiedUpdate).not.toHaveBeenCalled();
  });

  it("keeps the request deadline active while the artifact body is stalled", async () => {
    const sha512 = "a".repeat(128);
    const { service, installer } = await createService({
      artifactTimeoutMs: 5,
      fetch: vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (url.toString() === VILLAGE_UPDATE_ENDPOINT) {
          return response(
            JSON.stringify({
              productId: "com.village.desktop",
              channel: "alpha",
              version: "1.1.0-alpha.1",
              artifactUrl,
              sha512,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const stalled = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              controller.error(new Error("seeded timeout detail"));
            });
          },
        });
        return response(stalled, { status: 200 });
      }),
    });

    await expect(service.checkAndStage()).resolves.toEqual({
      status: "FAILED",
      code: "ARTIFACT_UNAVAILABLE",
      retriable: true,
    });
    expect(installer.stageVerifiedUpdate).not.toHaveBeenCalled();
  });

  it("rejects a manifest version that differs from the signed bundle version", async () => {
    const sha512 = await import("node:crypto").then(({ createHash }) =>
      createHash("sha512").update(artifactBytes).digest("hex"),
    );
    const { service, installer } = await createService({
      verifier: {
        inspect: vi.fn(async () => ({
          productId: "com.village.desktop",
          version: "1.0.1",
          signerSha256,
        })),
      },
      fetch: vi.fn(async (url: string | URL) => {
        if (url.toString() === VILLAGE_UPDATE_ENDPOINT) {
          return response(
            JSON.stringify({
              productId: "com.village.desktop",
              channel: "alpha",
              version: "1.1.0-alpha.1",
              artifactUrl,
              sha512,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return response(artifactBytes, { status: 200 });
      }),
    });

    await expect(service.checkAndStage()).resolves.toEqual({
      status: "REJECTED",
      code: "ARTIFACT_VERSION_MISMATCH",
    });
    expect(installer.stageVerifiedUpdate).not.toHaveBeenCalled();
  });

  it("classifies local staging failures without blaming the manifest", async () => {
    const sha512 = await import("node:crypto").then(({ createHash }) =>
      createHash("sha512").update(artifactBytes).digest("hex"),
    );
    const { service, stagingRoot, installer } = await createService({
      fetch: vi.fn(async (url: string | URL) => {
        if (url.toString() === VILLAGE_UPDATE_ENDPOINT) {
          return response(
            JSON.stringify({
              productId: "com.village.desktop",
              channel: "alpha",
              version: "1.1.0-alpha.1",
              artifactUrl,
              sha512,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return response(artifactBytes, { status: 200 });
      }),
    });
    await rm(stagingRoot, { recursive: true, force: true });
    await writeFile(stagingRoot, "not a directory");

    await expect(service.checkAndStage()).resolves.toEqual({
      status: "FAILED",
      code: "UPDATE_STAGING_FAILED",
      retriable: false,
    });
    expect(installer.stageVerifiedUpdate).not.toHaveBeenCalled();
  });

  it("retains the verified artifact when the platform installer settles late", async () => {
    const sha512 = await import("node:crypto").then(({ createHash }) =>
      createHash("sha512").update(artifactBytes).digest("hex"),
    );
    let stagedPath: string | undefined;
    const { service } = await createService({
      installer: {
        stageVerifiedUpdate: vi.fn(async ({ artifactPath }) => {
          stagedPath = artifactPath;
          throw new Error("seeded platform timeout");
        }),
        installPrepared: vi.fn(),
      },
      fetch: vi.fn(async (url: string | URL) => {
        if (url.toString() === VILLAGE_UPDATE_ENDPOINT) {
          return response(
            JSON.stringify({
              productId: "com.village.desktop",
              channel: "alpha",
              version: "1.1.0-alpha.1",
              artifactUrl,
              sha512,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return response(artifactBytes, { status: 200 });
      }),
    });

    await expect(service.checkAndStage()).resolves.toEqual({
      status: "FAILED",
      code: "UPDATE_STAGING_FAILED",
      retriable: false,
    });
    await expect(readFile(stagedPath!)).resolves.toEqual(artifactBytes);
  });

  it("removes interrupted candidate directories before starting a new check", async () => {
    const sha512 = await import("node:crypto").then(({ createHash }) =>
      createHash("sha512").update(artifactBytes).digest("hex"),
    );
    const { service, stagingRoot } = await createService({
      fetch: vi.fn(async (url: string | URL) => {
        if (url.toString() === VILLAGE_UPDATE_ENDPOINT) {
          return response(
            JSON.stringify({
              productId: "com.village.desktop",
              channel: "alpha",
              version: "1.1.0-alpha.1",
              artifactUrl,
              sha512,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return response(artifactBytes, { status: 200 });
      }),
    });
    await mkdir(join(stagingRoot, "candidate-interrupted"));
    await writeFile(
      join(stagingRoot, "candidate-interrupted", "partial.zip"),
      artifactBytes,
    );

    await expect(service.checkAndStage()).resolves.toEqual({
      status: "PREPARED",
      version: "1.1.0-alpha.1",
    });
    const candidates = (await readdir(stagingRoot)).filter((entry) =>
      entry.startsWith("candidate-"),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates).not.toContain("candidate-interrupted");
  });

  it("keeps install behind the prepared-state boundary", async () => {
    const { service, installer } = await createService();
    expect(() => service.installPrepared()).toThrowError("UPDATE_NOT_PREPARED");
    expect(installer.installPrepared).not.toHaveBeenCalled();
  });

  it("loads a signer pin only from packaged metadata and rejects malformed pins", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "village-package-"));
    directories.push(appRoot);
    await writeFile(
      join(appRoot, "package.json"),
      JSON.stringify({
        name: "@village/desktop",
        villageUpdateSignerSha256: signerSha256,
      }),
    );
    await expect(loadPackagedUpdateTrustPolicy(appRoot)).resolves.toEqual({
      productId: "com.village.desktop",
      channel: "alpha",
      endpoint: VILLAGE_UPDATE_ENDPOINT,
      signerSha256,
    });

    await writeFile(
      join(appRoot, "package.json"),
      JSON.stringify({
        name: "@village/desktop",
        villageUpdateSignerSha256: null,
      }),
    );
    await expect(
      loadPackagedUpdateTrustPolicy(appRoot),
    ).resolves.toBeUndefined();

    await writeFile(
      join(appRoot, "package.json"),
      JSON.stringify({
        name: "@village/desktop",
        villageUpdateSignerSha256: "runtime-env-is-not-a-trust-pin",
      }),
    );
    await expect(loadPackagedUpdateTrustPolicy(appRoot)).rejects.toThrowError(
      "PACKAGED_UPDATE_TRUST_INVALID",
    );
  });

  it("keeps startup non-blocking and reports only a bounded local failure code", async () => {
    let resolveCheck!: (value: {
      status: "REJECTED";
      code: "SIGNER_MISMATCH";
    }) => void;
    const check = new Promise<{
      status: "REJECTED";
      code: "SIGNER_MISMATCH";
    }>((resolve) => {
      resolveCheck = resolve;
    });
    const window = { reportLocalDiagnostic: vi.fn() };
    const service = {
      checkAndStage: vi.fn(() => check),
      installPrepared: vi.fn(),
    };

    expect(startNonBlockingDesktopUpdate(window, service, vi.fn())).toBe(
      window,
    );
    expect(window.reportLocalDiagnostic).not.toHaveBeenCalled();
    resolveCheck({ status: "REJECTED", code: "SIGNER_MISMATCH" });
    await vi.waitFor(() => {
      expect(window.reportLocalDiagnostic).toHaveBeenCalledWith({
        component: "UPDATER",
        code: "UPDATE_SIGNER_MISMATCH",
        retriable: false,
      });
    });
  });

  it("installs a prepared update only after main-process owner confirmation", async () => {
    const window = { reportLocalDiagnostic: vi.fn() };
    const service = {
      checkAndStage: vi.fn(async () => ({
        status: "PREPARED" as const,
        version: "1.1.0-alpha.1",
      })),
      installPrepared: vi.fn(),
    };
    const confirmInstall = vi.fn(async () => true);

    startNonBlockingDesktopUpdate(window, service, confirmInstall);

    await vi.waitFor(() => expect(confirmInstall).toHaveBeenCalledTimes(1));
    expect(service.installPrepared).toHaveBeenCalledTimes(1);
  });

  it("does not create an updater when the package has no compiled signer pin", async () => {
    const window = { reportLocalDiagnostic: vi.fn() };
    const createService = vi.fn();

    expect(
      startPackagedDesktopUpdates(window, {
        loadPolicy: async () => undefined,
        createService,
        confirmInstall: vi.fn(),
      }),
    ).toBe(window);

    await vi.waitFor(() => expect(createService).not.toHaveBeenCalled());
    expect(window.reportLocalDiagnostic).not.toHaveBeenCalled();
  });
});
