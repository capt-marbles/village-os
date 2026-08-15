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
import { ContinuityMailboxClient } from "./continuity-mailbox-client.js";
import type { ContinuityRecipientKey } from "./continuity-recipient-key-vault.js";

interface DeviceIdentitySource {
  load(): Promise<DeviceIdentity>;
}

interface ContinuityRecipientKeySource {
  load(): Promise<ContinuityRecipientKey>;
  create(): Promise<ContinuityRecipientKey>;
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

export async function createRuntimeContinuityMailboxClient(
  options: RuntimeControlPlaneOptions,
): Promise<ContinuityMailboxClient> {
  const deviceIdentity = await loadPairedDeviceIdentity(options);
  return new ContinuityMailboxClient({
    baseUrl: options.controlPlaneUrl,
    privateKey: deviceIdentity.privateKey,
    sequences: new FileProtocolSequenceStore(
      join(options.userDataPath, "continuity", "sequences.json"),
    ),
    ...(options.request ? { request: options.request } : {}),
  });
}

export async function createRuntimeContinuityRecipient(
  options: RuntimeControlPlaneOptions & {
    recipientKeySource: ContinuityRecipientKeySource;
  },
): Promise<{
  enrolled: boolean;
  recipientKey: ContinuityRecipientKey;
  mailboxClient: ContinuityMailboxClient;
}> {
  let recipientKey: ContinuityRecipientKey;
  try {
    recipientKey = await options.recipientKeySource.load();
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
    recipientKey = await options.recipientKeySource.create();
  }
  const mailboxClient = await createRuntimeContinuityMailboxClient(options);
  const enrollment = await mailboxClient.enrollRecipientKey(
    {
      principalId: options.identity.principalId,
      deviceId: options.identity.deviceId,
      browserSessionId: options.identity.browserSessionId,
      site: "OWNED_FIXTURE",
    },
    recipientKey.publicJwk,
  );
  return { ...enrollment, recipientKey, mailboxClient };
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
  const deviceIdentity = await loadPairedDeviceIdentity(options);
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

async function loadPairedDeviceIdentity(options: RuntimeControlPlaneOptions) {
  const deviceIdentity = await options.deviceIdentitySource.load();
  const derivedDeviceId = await deviceIdForPublicKey(deviceIdentity.publicJwk);
  if (derivedDeviceId !== options.identity.deviceId) {
    throw new Error("PAIRED_DEVICE_KEY_MISMATCH");
  }
  return deviceIdentity;
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
