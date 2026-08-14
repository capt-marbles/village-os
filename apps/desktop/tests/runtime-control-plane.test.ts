import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automationSyncRequestSchema } from "@village/contracts";
import { generateDeviceSigningKey } from "../src/main/device-identity.js";
import { exportPublicDeviceJwk } from "../src/main/device-identity.js";
import { deviceIdForPublicKey } from "../src/main/pairing-bootstrap.js";
import {
  assertDistinctBrowserSessionIdentity,
  createPairedWorkflowRuntimeComposition,
  createRuntimeControlPlaneAutomationFence,
  createRuntimeControlPlaneComposition,
} from "../src/main/runtime-control-plane.js";

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
    };
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        cursor: 7,
        jobId: "job_01J00000000000000000000009",
        controller: "AGENT",
        connection: "ONLINE",
        leaseEpoch: 3,
        automationBlocked: false,
        canceled: false,
        workflow: {
          objective: {
            kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
            version: 1,
          },
          jobRevision: 2,
          logicalStep: "SELECT_ROLE",
          effectId: "efx_01J00000000000000000000009",
          completedEffects: [
            {
              logicalStep: "SET_DISPLAY_NAME",
              effectId: "efx_01J00000000000000000000008",
            },
          ],
          actionPhase: "ACCEPTED",
          outstandingAction: null,
        },
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
      cursor: 7,
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
      leaseEpoch: 3,
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
  });
});
