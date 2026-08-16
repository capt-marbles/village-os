import { app, protocol, session, shell } from "electron";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SecretVault } from "../secrets/secret-vault.js";
import {
  createVillageAppWindow,
  defaultPreloadPath,
  type VillageAppWindow,
} from "./app-window.js";
import { DeviceIdentityVault } from "./device-identity-vault.js";
import { ElectronSafeStorageProtector } from "./electron-safe-storage.js";
import {
  installVillageProtocol,
  registerVillageScheme,
} from "./local-app-protocol.js";
import {
  resolveRuntimeIdentity,
  type PairedRuntimeIdentitySource,
} from "./runtime-identity.js";
import { SecretRuntimeIdentityStore } from "./runtime-identity-store.js";
import {
  deviceIdForPublicKey,
  PairingBootstrapService,
} from "./pairing-bootstrap.js";
import { PairingClient } from "./pairing-client.js";
import { PairingDeepLinkInbox } from "./pairing-deep-link.js";
import { createPairingWindow } from "./pairing-window.js";
import {
  configureBrowserSession,
  installGlobalSecurityPolicy,
} from "./security.js";
import { verifyMacOsOwnerPresence } from "./step-up-auth.js";
import type { InternalDelegatedWorkflowOperations } from "./app-window.js";
import {
  createRuntimeModelProviderComposition,
  type RuntimeModelProviderComposition,
} from "./runtime-model-provider.js";
import {
  createRuntimeControlPlaneAutomationFence,
  createRuntimeFixtureContinuityRecipient,
} from "./runtime-control-plane.js";
import { ContinuityRecipientKeyVault } from "./continuity-recipient-key-vault.js";
import { startNonBlockingContinuityEnrollment } from "./runtime-continuity-enrollment.js";
import { RuntimeContinuityActivation } from "./runtime-continuity-activation.js";
import { LocalBrowserHost } from "../browser/local-browser-host.js";
import {
  ensureProtectedProfile,
  ProfileLock,
} from "../browser/profile-protection.js";
import {
  createRitualBuilderWindow,
  type RitualBuilderWindow,
} from "./ritual-builder-window.js";
import { RitualRepository } from "./ritual-repository.js";
import { RitualBuilderController } from "./ritual-builder-controller.js";
import { CodexStdioTransport } from "../model-provider/codex-app-server.js";
import { CodexRitualStewardProvider } from "../model-provider/ritual-steward.js";
import { ExaApiKeyStore } from "../research/exa-api-key-store.js";
import { ExaCredentialController } from "../research/exa-credential-controller.js";
import { ExaSearchProvider } from "../research/exa-search-provider.js";
import { installRitualBuilderMenu } from "./ritual-builder-menu.js";
import { LocalRitualRunExecutor } from "./ritual-run-executor.js";

registerVillageScheme(protocol);
installGlobalSecurityPolicy(app);
const pairingInbox = new PairingDeepLinkInbox();
let ritualBuilderWindow: RitualBuilderWindow | undefined;
let ritualBuilderLaunch: Promise<RitualBuilderWindow> | undefined;
app.on("open-url", (event, url) => {
  event.preventDefault();
  pairingInbox.accept(url);
});

export function resolveRuntimeControlPlaneUrl(storedOrigin?: string): URL {
  const configured = storedOrigin ?? process.env.VILLAGE_CONTROL_PLANE_URL;
  if (!configured) throw new Error("VILLAGE_CONTROL_PLANE_URL_REQUIRED");
  const url = new URL(configured);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("VILLAGE_CONTROL_PLANE_URL_UNSAFE");
  }
  return url;
}

export async function startVillageRuntime(
  pairedIdentitySource?: PairedRuntimeIdentitySource,
  internalComposition?: {
    /** Supplied only by the internal packaged proof harness. */
    delegatedWorkflow: InternalDelegatedWorkflowOperations;
    /** One owner for account, personal-task, and delegated provider access. */
    modelProviders?: RuntimeModelProviderComposition;
  },
): Promise<VillageAppWindow> {
  installVillageProtocol(
    protocol,
    fileURLToPath(new URL("../renderer", import.meta.url)),
  );
  const preloadPath = defaultPreloadPath(app.getAppPath());
  const userDataPath = app.getPath("userData");
  const identityDirectory = join(userDataPath, "identity");
  const packagedProtector = app.isPackaged
    ? new ElectronSafeStorageProtector()
    : undefined;
  let identity;
  if (!app.isPackaged) {
    identity = await resolveRuntimeIdentity({ isPackaged: false });
  } else if (pairedIdentitySource) {
    identity = await resolveRuntimeIdentity({
      isPackaged: true,
      pairedIdentitySource,
    });
  } else {
    const runtimeStore = new SecretRuntimeIdentityStore(
      new SecretVault(
        join(identityDirectory, "runtime-vault.json"),
        packagedProtector!,
      ),
    );
    try {
      identity = await resolveRuntimeIdentity({
        isPackaged: true,
        pairedIdentitySource: runtimeStore,
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !["PAIRED_RUNTIME_IDENTITY_REQUIRED", "SECRET_REVOKED"].includes(
          error.message,
        )
      ) {
        throw error;
      }
      if (!app.setAsDefaultProtocolClient("village-pair")) {
        throw new Error("PAIRING_DEEP_LINK_REGISTRATION_FAILED");
      }
      const pairingUrl = resolveRuntimeControlPlaneUrl();
      const pairingService = new PairingBootstrapService(
        new DeviceIdentityVault(
          join(identityDirectory, "device.json"),
          packagedProtector!,
        ),
        new PairingClient(pairingUrl.origin),
        runtimeStore,
        deviceIdForPublicKey,
        hostname().slice(0, 80) || "Village Mac",
        undefined,
        pairingUrl.origin,
      );
      identity = await createPairingWindow({
        preloadPath,
        service: pairingService,
        inbox: pairingInbox,
      });
    }
  }
  const modelProviders =
    internalComposition?.modelProviders ??
    createRuntimeModelProviderComposition((url) => shell.openExternal(url));
  let automationFence;
  let enrollContinuityRecipient: (() => Promise<unknown>) | undefined;
  if (app.isPackaged && !internalComposition) {
    const controlPlaneUrl = resolveRuntimeControlPlaneUrl(
      identity.controlPlaneOrigin,
    );
    const deviceIdentity = await new DeviceIdentityVault(
      join(identityDirectory, "device.json"),
      packagedProtector!,
    ).load();
    const deviceIdentitySource = { load: async () => deviceIdentity };
    automationFence = await createRuntimeControlPlaneAutomationFence({
      controlPlaneUrl,
      userDataPath,
      identity,
      deviceIdentitySource,
    });
    const recipientKeySource = new ContinuityRecipientKeyVault(
      join(identityDirectory, "continuity-recipient.json"),
      packagedProtector!,
    );
    enrollContinuityRecipient = async () => {
      const continuity = await createRuntimeFixtureContinuityRecipient({
        controlPlaneUrl,
        userDataPath,
        identity,
        deviceIdentitySource,
        recipientKeySource,
      });
      if (continuity.state === "NOT_CONFIGURED") return continuity;
      const fixtureBrowserSessionId = identity.fixtureBrowserSessionId!;
      const profile = await ensureProtectedProfile(
        LocalBrowserHost.profileRoot(userDataPath),
        {
          principalId: identity.principalId,
          deviceId: identity.deviceId,
          site: "OWNED_FIXTURE",
        },
      );
      const profileLock = await ProfileLock.acquire(profile.path);
      try {
        const fixtureSession = session.fromPath(profile.path, { cache: true });
        configureBrowserSession(fixtureSession);
        const activation = new RuntimeContinuityActivation({
          identity: {
            principalId: identity.principalId,
            deviceId: identity.deviceId,
            browserSessionId: fixtureBrowserSessionId,
            site: "OWNED_FIXTURE",
          },
          journalRoot: join(userDataPath, "continuity", "runtime"),
          devicePrivateKey: deviceIdentity.privateKey,
          recipientPrivateKey: continuity.recipientKey.privateKey,
          cookieStore: fixtureSession.cookies,
          mailbox: continuity.mailboxClient,
        });
        return await activation.synchronize();
      } finally {
        await profileLock.release();
      }
    };
  }
  const villageWindow = await createVillageAppWindow({
    ...identity,
    site: "LINKEDIN",
    initialUrl: "https://www.linkedin.com/login",
    userDataPath,
    preloadPath,
    modelProviderAccount: modelProviders.modelProviderAccount,
    personalAgentTask: modelProviders.personalAgentTask,
    ...(automationFence ? { automationFence } : {}),
    ...(internalComposition
      ? { delegatedWorkflow: internalComposition.delegatedWorkflow }
      : {}),
    verifyStepUp: () => verifyMacOsOwnerPresence(),
    // LinkedIn authentication is human-only: Village never persists a
    // LinkedIn credential reference. Keeping this required callback in the
    // production composition prevents future credential-capable sites from
    // silently skipping their vault cleanup.
    revokeCredentialReferences: async (binding) => {
      if (binding.site !== "LINKEDIN") {
        throw new Error("CREDENTIAL_REFERENCE_OWNER_REQUIRED");
      }
    },
  });
  return startNonBlockingContinuityEnrollment(
    villageWindow,
    enrollContinuityRecipient,
  );
}

export async function runVillageApplication(
  pairedIdentitySource?: PairedRuntimeIdentitySource,
  internalComposition?: Parameters<typeof startVillageRuntime>[1],
): Promise<VillageAppWindow> {
  await app.whenReady();
  for (const argument of process.argv) pairingInbox.accept(argument);
  app.on("window-all-closed", () => app.quit());
  const villageWindow = await startVillageRuntime(
    pairedIdentitySource,
    internalComposition,
  );
  installRitualBuilderMenu(async () => {
    await openRitualBuilderWindow();
  });
  return villageWindow;
}

export async function runRitualBuilderApplication(): Promise<RitualBuilderWindow> {
  await app.whenReady();
  installVillageProtocol(
    protocol,
    fileURLToPath(new URL("../renderer", import.meta.url)),
  );
  app.on("window-all-closed", () => app.quit());
  return openRitualBuilderWindow();
}

async function openRitualBuilderWindow(): Promise<RitualBuilderWindow> {
  if (ritualBuilderWindow && !ritualBuilderWindow.window.isDestroyed()) {
    ritualBuilderWindow.window.focus();
    return ritualBuilderWindow;
  }
  if (ritualBuilderLaunch) return ritualBuilderLaunch;
  ritualBuilderLaunch = createRitualBuilderSurface();
  try {
    ritualBuilderWindow = await ritualBuilderLaunch;
    ritualBuilderWindow.window.on("closed", () => {
      ritualBuilderWindow = undefined;
    });
    return ritualBuilderWindow;
  } finally {
    ritualBuilderLaunch = undefined;
  }
}

function createRitualBuilderSurface(): Promise<RitualBuilderWindow> {
  const exaApiKeyStore = new ExaApiKeyStore(
    new SecretVault(
      join(app.getPath("userData"), "research", "exa-vault.json"),
      new ElectronSafeStorageProtector(),
    ),
  );
  const exaCredentials = new ExaCredentialController(exaApiKeyStore);
  return createRitualBuilderWindow({
    preloadPath: join(
      app.getAppPath(),
      "dist",
      "preload",
      "ritual-builder-bridge.cjs",
    ),
    controller: new RitualBuilderController(
      new CodexRitualStewardProvider(() => new CodexStdioTransport()),
      new RitualRepository(
        join(app.getPath("userData"), "rituals", "approved.json"),
      ),
      {
        runExecutor: new LocalRitualRunExecutor({
          research: new ExaSearchProvider({ credentials: exaApiKeyStore }),
        }),
      },
    ),
    exaCredentials,
    openExaDashboard: () =>
      shell.openExternal("https://dashboard.exa.ai/api-keys"),
  });
}
