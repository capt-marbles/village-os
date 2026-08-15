import type { DeviceIdentity } from "./device-identity-vault.js";
import type { RuntimeIdentity } from "./runtime-identity.js";
import { actionIdSchema } from "@village/contracts";
import { randomBytes } from "node:crypto";
import { deviceIdForPublicKey } from "./pairing-bootstrap.js";
import {
  ControlPlaneAutomationFence,
  ControlPlaneClient,
  ControlPlaneWorkflowCoordinator,
  FileAutomationSyncCursorStore,
  FileProtocolSequenceStore,
  type CommandIdentity,
} from "./control-plane-client.js";
import { join } from "node:path";
import type { CoordinatorSnapshot } from "./delegated-workflow-controller.js";

interface DeviceIdentitySource {
  load(): Promise<DeviceIdentity>;
}

const villageIdAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function createRuntimeActionId(): string {
  let suffix = "";
  for (const byte of randomBytes(26)) {
    suffix += villageIdAlphabet[byte & 31];
  }
  return actionIdSchema.parse(`act_${suffix}`);
}

export interface RuntimeControlPlaneOptions {
  controlPlaneUrl: URL;
  userDataPath: string;
  identity: RuntimeIdentity;
  deviceIdentitySource: DeviceIdentitySource;
  connectionId?: string;
  request?: typeof fetch;
}

export function assertDistinctBrowserSessionIdentity(
  personalBrowserSessionId: string,
  fixtureBrowserSessionId: string,
): void {
  if (personalBrowserSessionId === fixtureBrowserSessionId) {
    throw new Error("PACKAGED_DELEGATED_WORKFLOW_FIXTURE_SESSION_NOT_DISTINCT");
  }
}

export async function createRuntimeControlPlaneAutomationFence(
  options: RuntimeControlPlaneOptions,
): Promise<ControlPlaneAutomationFence> {
  return (await createRuntimeControlPlaneComposition(options)).automationFence;
}

export async function createRuntimeControlPlaneComposition(
  options: RuntimeControlPlaneOptions,
): Promise<{
  automationFence: ControlPlaneAutomationFence;
  workflowCoordinator: ControlPlaneWorkflowCoordinator;
  connectOwnedFixture(
    identity: CommandIdentity,
    leaseEpoch: number,
  ): ReturnType<ControlPlaneClient["connect"]>;
}> {
  const deviceIdentity = await options.deviceIdentitySource.load();
  const derivedDeviceId = await deviceIdForPublicKey(deviceIdentity.publicJwk);
  if (derivedDeviceId !== options.identity.deviceId) {
    throw new Error("PAIRED_DEVICE_KEY_MISMATCH");
  }
  const stateDirectory = join(options.userDataPath, "control-plane");
  const client = new ControlPlaneClient(
    options.controlPlaneUrl.origin,
    options.connectionId ??
      `desktop_${crypto.randomUUID().replaceAll("-", "")}`,
    deviceIdentity.privateKey,
    new FileProtocolSequenceStore(join(stateDirectory, "sequences.json")),
    options.request,
  );
  const cursors = new FileAutomationSyncCursorStore(
    join(stateDirectory, "automation-sync-cursors.json"),
  );
  return {
    automationFence: new ControlPlaneAutomationFence(client, cursors),
    workflowCoordinator: new ControlPlaneWorkflowCoordinator(client, cursors),
    connectOwnedFixture: (identity: CommandIdentity, leaseEpoch: number) =>
      client.connect(
        identity,
        createRuntimeActionId(),
        "OWNED_FIXTURE",
        leaseEpoch,
      ),
  };
}

export async function createPairedWorkflowRuntimeComposition(
  options: RuntimeControlPlaneOptions,
): Promise<{
  automationFence: ControlPlaneAutomationFence;
  workflowCoordinator: ControlPlaneWorkflowCoordinator;
  initialSnapshot: CoordinatorSnapshot;
}> {
  const composition = await createRuntimeControlPlaneComposition(options);
  let state = await composition.automationFence.synchronize({
    principalId: options.identity.principalId,
    deviceId: options.identity.deviceId,
    browserSessionId: options.identity.browserSessionId,
  });
  if (state.workflow === null || state.connection === "ABSENT") {
    throw new Error("PAIRED_WORKFLOW_BINDING_UNAVAILABLE");
  }
  if (state.controller === "NONE" && !state.canceled) {
    await composition.connectOwnedFixture(
      {
        principalId: options.identity.principalId,
        deviceId: options.identity.deviceId,
        jobId: state.jobId,
        browserSessionId: options.identity.browserSessionId,
      },
      Math.max(1, state.leaseEpoch),
    );
    state = await composition.automationFence.synchronize({
      principalId: options.identity.principalId,
      deviceId: options.identity.deviceId,
      browserSessionId: options.identity.browserSessionId,
    });
    if (state.workflow === null || state.connection === "ABSENT") {
      throw new Error("PAIRED_WORKFLOW_BINDING_UNAVAILABLE");
    }
  }
  return {
    ...composition,
    initialSnapshot: {
      authenticated: true,
      principalId: options.identity.principalId,
      deviceId: options.identity.deviceId,
      jobId: state.jobId,
      browserSessionId: options.identity.browserSessionId,
      ...state.workflow,
      cursor: state.cursor,
      connection: state.connection,
      controller: state.controller,
      leaseEpoch: state.leaseEpoch,
      automationBlocked: state.automationBlocked,
      canceled: state.canceled,
    },
  };
}
