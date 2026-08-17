import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  automationSyncRequestSchema,
  signedCommandEnvelopeSchema,
} from "@village/contracts";
import { generateDeviceSigningKey } from "../src/main/device-identity.js";
import { exportPublicDeviceJwk } from "../src/main/device-identity.js";
import { deviceIdForPublicKey } from "../src/main/pairing-bootstrap.js";
import {
  assertDistinctBrowserSessionIdentity,
  createPairedWorkflowRuntimeComposition,
  createRuntimeControlPlaneAutomationFence,
  createRuntimeControlPlaneComposition,
} from "../src/main/runtime-control-plane.js";
import {
  createRuntimeContinuityMailboxClient,
  createRuntimeContinuityRecipient,
  createRuntimeFixtureContinuityRecipient,
} from "../src/main/runtime-continuity-composition.js";

describe("packaged runtime control-plane composition", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("rejects an owned fixture that reuses the personal browser session", () => {
    expect(() =>
      assertDistinctBrowserSessionIdentity(
        "brs_01J00000000000000000000000",
        "brs_01J00000000000000000000000",
      ),
    ).toThrow("PACKAGED_DELEGATED_WORKFLOW_FIXTURE_SESSION_NOT_DISTINCT");
  });

  it("loads the paired device key and resumes signed synchronization after restart", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "village-runtime-cp-"));
    temporaryDirectories.push(userDataPath);
    const keys = await generateDeviceSigningKey();
    const publicJwk = await exportPublicDeviceJwk(keys.publicKey);
    const identity = {
      principalId: "prn_01J00000000000000000000000",
      deviceId: await deviceIdForPublicKey(publicJwk),
      browserSessionId: "brs_01J00000000000000000000000",
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          cursor: 4,
          jobId: "job_01J00000000000000000000000",
          controller: "AGENT",
          connection: "ONLINE",
          leaseEpoch: 2,
          automationBlocked: false,
          canceled: false,
          workflow: null,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          cursor: 6,
          jobId: "job_01J00000000000000000000000",
          controller: "NONE",
          connection: "ONLINE",
          leaseEpoch: 3,
          automationBlocked: true,
          canceled: true,
          workflow: null,
        }),
      );
    const deviceIdentitySource = {
      load: vi.fn(async () => ({
        privateKey: keys.privateKey,
        publicKey: keys.publicKey,
        publicJwk,
        protectionBackend: "keychain",
      })),
    };

    const firstProcess = await createRuntimeControlPlaneAutomationFence({
      controlPlaneUrl: new URL("https://village.test"),
      userDataPath,
      identity,
      deviceIdentitySource,
      connectionId: "desktop-first",
      request,
    });
    await expect(firstProcess.synchronize(identity)).resolves.toMatchObject({
      cursor: 4,
      automationBlocked: false,
    });

    const restartedProcess = await createRuntimeControlPlaneAutomationFence({
      controlPlaneUrl: new URL("https://village.test"),
      userDataPath,
      identity,
      deviceIdentitySource,
      connectionId: "desktop-restarted",
      request,
    });
    await expect(restartedProcess.synchronize(identity)).resolves.toMatchObject(
      { cursor: 6, canceled: true },
    );

    const firstEnvelope = automationSyncRequestSchema.parse(
      JSON.parse((request.mock.calls[0]![1] as RequestInit).body as string),
    );
    const restartedEnvelope = automationSyncRequestSchema.parse(
      JSON.parse((request.mock.calls[1]![1] as RequestInit).body as string),
    );
    expect(firstEnvelope).toMatchObject({
      cursor: 0,
      sequence: 1,
      connectionId: "desktop-first",
    });
    expect(restartedEnvelope).toMatchObject({
      cursor: 4,
      sequence: 2,
      connectionId: "desktop-restarted",
    });
    expect(
      JSON.parse(
        await readFile(
          join(userDataPath, "control-plane/automation-sync-cursors.json"),
          "utf8",
        ),
      ),
    ).toEqual({ [identity.browserSessionId]: 6 });
  });

  it("binds the continuity mailbox client to the paired device identity", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "village-runtime-cp-"));
    temporaryDirectories.push(userDataPath);
    const keys = await generateDeviceSigningKey();
    const publicJwk = await exportPublicDeviceJwk(keys.publicKey);
    const identity = {
      principalId: "prn_01J00000000000000000000000",
      deviceId: await deviceIdForPublicKey(publicJwk),
      browserSessionId: "brs_01J00000000000000000000002",
    };
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, revision: null }),
    );
    const client = await createRuntimeContinuityMailboxClient({
      controlPlaneUrl: new URL("https://village.test"),
      userDataPath,
      identity,
      deviceIdentitySource: {
        load: async () => ({
          privateKey: keys.privateKey,
          publicKey: keys.publicKey,
          publicJwk,
          protectionBackend: "keychain",
        }),
      },
      request,
    });
    await client.fetchAfter(
      {
        principalId: identity.principalId,
        grantId: "cgr_01J00000000000000000000000",
        sourceDeviceId: "dev_01J00000000000000000000001",
        destinationDeviceId: identity.deviceId,
        sourceBrowserSessionId: "brs_01J00000000000000000000001",
        destinationBrowserSessionId: identity.browserSessionId,
        site: "OWNED_FIXTURE",
      },
      0,
    );
    expect(String(request.mock.calls[0]![0])).toContain(
      "/api/site-session-continuity/grants/cgr_01J00000000000000000000000/fetch",
    );
  });

  it("creates and enrolls a protected recipient key for the paired fixture session", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "village-runtime-cp-"));
    temporaryDirectories.push(userDataPath);
    const signingKeys = await generateDeviceSigningKey();
    const publicJwk = await exportPublicDeviceJwk(signingKeys.publicKey);
    const identity = {
      principalId: "prn_01J00000000000000000000000",
      deviceId: await deviceIdForPublicKey(publicJwk),
      browserSessionId: "brs_01J00000000000000000000002",
    };
    const recipientKeys = (await crypto.subtle.generateKey("X25519", true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const exportedRecipient = await crypto.subtle.exportKey(
      "jwk",
      recipientKeys.publicKey,
    );
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        ok: true,
        enrolled: true,
        deviceId: identity.deviceId,
        browserSessionId: identity.browserSessionId,
      }),
    );
    const recipientKeySource = {
      load: vi.fn(async () => {
        const error = new Error("missing") as Error & { code: string };
        error.code = "ENOENT";
        throw error;
      }),
      create: vi.fn(async () => ({
        privateKey: recipientKeys.privateKey,
        publicKey: recipientKeys.publicKey,
        publicJwk: {
          kty: "OKP" as const,
          crv: "X25519" as const,
          x: exportedRecipient.x!,
        },
        protectionBackend: "keychain",
      })),
    };

    const result = await createRuntimeContinuityRecipient({
      controlPlaneUrl: new URL("https://village.test"),
      userDataPath,
      identity,
      deviceIdentitySource: {
        load: async () => ({
          privateKey: signingKeys.privateKey,
          publicKey: signingKeys.publicKey,
          publicJwk,
          protectionBackend: "keychain",
        }),
      },
      recipientKeySource,
      request,
    });

    expect(result.enrolled).toBe(true);
    expect(result.recipientKey.publicJwk.x).toBe(exportedRecipient.x);
    expect(recipientKeySource.create).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not provision continuity for an older pairing without a fixture session", async () => {
    const recipientKeySource = {
      load: vi.fn(),
      create: vi.fn(),
    };
    await expect(
      createRuntimeFixtureContinuityRecipient({
        controlPlaneUrl: new URL("https://village.test"),
        userDataPath: "/unused",
        identity: {
          principalId: "prn_01J00000000000000000000000",
          deviceId: "dev_01J00000000000000000000000",
          browserSessionId: "brs_01J00000000000000000000000",
        },
        deviceIdentitySource: { load: vi.fn() },
        recipientKeySource,
      }),
    ).resolves.toEqual({ state: "NOT_CONFIGURED" });
    expect(recipientKeySource.load).not.toHaveBeenCalled();
    expect(recipientKeySource.create).not.toHaveBeenCalled();
  });

  it("enrolls the fixture session without exposing the personal session", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "village-runtime-cp-"));
    temporaryDirectories.push(userDataPath);
    const signingKeys = await generateDeviceSigningKey();
    const publicJwk = await exportPublicDeviceJwk(signingKeys.publicKey);
    const deviceId = await deviceIdForPublicKey(publicJwk);
    const recipientKeys = (await crypto.subtle.generateKey("X25519", true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const exportedRecipient = await crypto.subtle.exportKey(
      "jwk",
      recipientKeys.publicKey,
    );
    const personalBrowserSessionId = "brs_01J00000000000000000000003";
    const fixtureBrowserSessionId = "brs_01J00000000000000000000004";
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.browserSessionId).toBe(fixtureBrowserSessionId);
      expect(JSON.stringify(body)).not.toContain(personalBrowserSessionId);
      return Response.json({
        ok: true,
        enrolled: true,
        deviceId,
        browserSessionId: fixtureBrowserSessionId,
      });
    });

    const result = await createRuntimeFixtureContinuityRecipient({
      controlPlaneUrl: new URL("https://village.test"),
      userDataPath,
      identity: {
        principalId: "prn_01J00000000000000000000000",
        deviceId,
        browserSessionId: personalBrowserSessionId,
        fixtureBrowserSessionId,
      },
      deviceIdentitySource: {
        load: async () => ({
          privateKey: signingKeys.privateKey,
          publicKey: signingKeys.publicKey,
          publicJwk,
          protectionBackend: "keychain",
        }),
      },
      recipientKeySource: {
        load: async () => ({
          privateKey: recipientKeys.privateKey,
          publicKey: recipientKeys.publicKey,
          publicJwk: {
            kty: "OKP",
            crv: "X25519",
            x: exportedRecipient.x!,
          },
          protectionBackend: "keychain",
        }),
        create: vi.fn(),
      },
      request,
    });

    expect(result).toMatchObject({ state: "ENROLLED", enrolled: true });
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects a device key that does not belong to the paired identity", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "village-runtime-cp-"));
    temporaryDirectories.push(userDataPath);
    const keys = await generateDeviceSigningKey();
    const publicJwk = await exportPublicDeviceJwk(keys.publicKey);

    await expect(
      createRuntimeControlPlaneAutomationFence({
        controlPlaneUrl: new URL("https://village.test"),
        userDataPath,
        identity: {
          principalId: "prn_01J00000000000000000000000",
          deviceId: "dev_01J00000000000000000000000",
          browserSessionId: "brs_01J00000000000000000000000",
        },
        deviceIdentitySource: {
          load: async () => ({
            privateKey: keys.privateKey,
            publicKey: keys.publicKey,
            publicJwk,
            protectionBackend: "keychain",
          }),
        },
        connectionId: "desktop-mismatch",
      }),
    ).rejects.toThrow("PAIRED_DEVICE_KEY_MISMATCH");
  });

  it("exposes the production workflow coordinator beside the shared automation fence", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "village-runtime-cp-"));
    temporaryDirectories.push(userDataPath);
    const keys = await generateDeviceSigningKey();
    const publicJwk = await exportPublicDeviceJwk(keys.publicKey);
    const composition = await createRuntimeControlPlaneComposition({
      controlPlaneUrl: new URL("https://village.test"),
      userDataPath,
      identity: {
        principalId: "prn_01J00000000000000000000000",
        deviceId: await deviceIdForPublicKey(publicJwk),
        browserSessionId: "brs_01J00000000000000000000000",
      },
      deviceIdentitySource: {
        load: async () => ({
          privateKey: keys.privateKey,
          publicKey: keys.publicKey,
          publicJwk,
          protectionBackend: "keychain",
        }),
      },
      request: vi.fn<typeof fetch>(),
    });

    expect(composition.automationFence).toBeDefined();
    expect(composition.workflowCoordinator).toBeDefined();
  });

  it("bootstraps the delegated workflow binding from authenticated coordinator state", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "village-runtime-cp-"));
    temporaryDirectories.push(userDataPath);
    const keys = await generateDeviceSigningKey();
    const publicJwk = await exportPublicDeviceJwk(keys.publicKey);
    const identity = {
      principalId: "prn_01J00000000000000000000000",
      deviceId: await deviceIdForPublicKey(publicJwk),
      browserSessionId: "brs_01J00000000000000000000009",
      controlPlaneOrigin: "https://village.test",
    };
    const workflow = {
      objective: {
        kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1" as const,
        version: 1 as const,
      },
      jobRevision: 2,
      logicalStep: "SELECT_ROLE" as const,
      effectId: "efx_01J00000000000000000000009",
      completedEffects: [
        {
          logicalStep: "SET_DISPLAY_NAME" as const,
          effectId: "efx_01J00000000000000000000008",
        },
      ],
      actionPhase: "ACCEPTED" as const,
      outstandingAction: null,
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          cursor: 2,
          jobId: "job_01J00000000000000000000009",
          controller: "NONE",
          connection: "ONLINE",
          leaseEpoch: 0,
          automationBlocked: true,
          canceled: false,
          workflow,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ ok: true, leaseEpoch: 1, eventSequence: 3 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          cursor: 3,
          jobId: "job_01J00000000000000000000009",
          controller: "AGENT",
          connection: "ONLINE",
          leaseEpoch: 1,
          automationBlocked: false,
          canceled: false,
          workflow,
        }),
      );

    const composition = await createPairedWorkflowRuntimeComposition({
      controlPlaneUrl: new URL("https://village.test"),
      userDataPath,
      identity,
      deviceIdentitySource: {
        load: async () => ({
          privateKey: keys.privateKey,
          publicKey: keys.publicKey,
          publicJwk,
          protectionBackend: "keychain",
        }),
      },
      connectionId: "desktop-paired-workflow",
      request,
    });

    expect(composition.initialSnapshot).toEqual({
      authenticated: true,
      cursor: 3,
      principalId: identity.principalId,
      deviceId: identity.deviceId,
      jobId: "job_01J00000000000000000000009",
      browserSessionId: identity.browserSessionId,
      objective: {
        kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
        version: 1,
      },
      jobRevision: 2,
      logicalStep: "SELECT_ROLE",
      effectId: "efx_01J00000000000000000000009",
      leaseEpoch: 1,
      connection: "ONLINE",
      controller: "AGENT",
      automationBlocked: false,
      canceled: false,
      completedEffects: [
        {
          logicalStep: "SET_DISPLAY_NAME",
          effectId: "efx_01J00000000000000000000008",
        },
      ],
      actionPhase: "ACCEPTED",
      outstandingAction: null,
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(String(request.mock.calls[1]![0])).toBe(
      `https://village.test/api/browser-sessions/${identity.browserSessionId}/connect`,
    );
    expect(
      signedCommandEnvelopeSchema.parse(
        JSON.parse((request.mock.calls[1]![1] as RequestInit).body as string),
      ),
    ).toMatchObject({
      principalId: identity.principalId,
      deviceId: identity.deviceId,
      browserSessionId: identity.browserSessionId,
      jobId: "job_01J00000000000000000000009",
      leaseEpoch: 1,
      command: { capability: "SESSION_OPEN", site: "OWNED_FIXTURE" },
    });
  });
});
