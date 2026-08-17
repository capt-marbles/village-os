import { join } from "node:path";
import { FileProtocolSequenceStore } from "./control-plane-client.js";
import { ContinuityMailboxClient } from "./continuity-mailbox-client.js";
import type { ContinuityRecipientKey } from "./continuity-recipient-key-vault.js";
import {
  assertDistinctBrowserSessionIdentity,
  loadPairedDeviceIdentity,
  type RuntimeControlPlaneOptions,
} from "./runtime-control-plane.js";

interface ContinuityRecipientKeySource {
  load(): Promise<ContinuityRecipientKey>;
  create(): Promise<ContinuityRecipientKey>;
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

export async function createRuntimeFixtureContinuityRecipient(
  options: RuntimeControlPlaneOptions & {
    recipientKeySource: ContinuityRecipientKeySource;
  },
): Promise<
  | { state: "NOT_CONFIGURED" }
  | ({ state: "ENROLLED" } & Awaited<
      ReturnType<typeof createRuntimeContinuityRecipient>
    >)
> {
  const fixtureBrowserSessionId = options.identity.fixtureBrowserSessionId;
  if (!fixtureBrowserSessionId) return { state: "NOT_CONFIGURED" };
  assertDistinctBrowserSessionIdentity(
    options.identity.browserSessionId,
    fixtureBrowserSessionId,
  );
  const enrollment = await createRuntimeContinuityRecipient({
    ...options,
    identity: {
      ...options.identity,
      browserSessionId: fixtureBrowserSessionId,
    },
  });
  return { state: "ENROLLED", ...enrollment };
}
