import type { DeviceIdentity } from "./device-identity-vault.js";
import type { RuntimeIdentity } from "./runtime-identity.js";
import { deviceIdForPublicKey } from "./pairing-bootstrap.js";
import {
  ControlPlaneAutomationFence,
  ControlPlaneClient,
  ControlPlaneWorkflowCoordinator,
  FileAutomationSyncCursorStore,
  FileProtocolSequenceStore,
} from "./control-plane-client.js";
import { join } from "node:path";

interface DeviceIdentitySource {
  load(): Promise<DeviceIdentity>;
}

export interface RuntimeControlPlaneOptions {
  controlPlaneUrl: URL;
  userDataPath: string;
  identity: RuntimeIdentity;
  deviceIdentitySource: DeviceIdentitySource;
  connectionId?: string;
  request?: typeof fetch;
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
  };
}
