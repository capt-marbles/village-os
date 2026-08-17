import {
  app,
  autoUpdater,
  dialog,
  Notification,
  protocol,
  session,
  shell,
} from "electron";
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
  ensureVillageProtocolInstalled,
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
import {
  completePendingSessionErasure,
  PendingSessionErasureStore,
} from "./pending-session-erasure.js";
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
  assertMacOsProfileEncryptionAvailable,
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
import { RitualScheduler } from "./ritual-scheduler.js";
import { createRitualShutdownHandler } from "./ritual-runtime-shutdown.js";
import {
  DesktopUpdateService,
  desktopUpdateFetch,
  loadPackagedUpdateTrustPolicy,
  startPackagedDesktopUpdates,
} from "./update-runtime.js";
import {
  ElectronMacUpdateInstaller,
  MacOsUpdateArtifactVerifier,
} from "./macos-update-adapter.js";

registerVillageScheme(protocol);
installGlobalSecurityPolicy(app);
const pairingInbox = new PairingDeepLinkInbox();
let ritualBuilderWindow: RitualBuilderWindow | undefined;
let ritualBuilderLaunch: Promise<RitualBuilderWindow> | undefined;
let ritualServicesLaunch: Promise<RitualRuntimeServices> | undefined;
let ritualServices: RitualRuntimeServices | undefined;
interface RitualRuntimeServices {
  controller: RitualBuilderController;
  scheduler: RitualScheduler;
  exaCredentials: ExaCredentialController;
}
app.on(
  "before-quit",
  createRitualShutdownHandler(
    app,
    () => ritualServices,
    () => {
      ritualServices = undefined;
      ritualServicesLaunch = undefined;
    },
  ),
);

export function acceptRuntimePairingLink(value: string): boolean {
  return pairingInbox.accept(value);
}

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
    /** Supplied only by the internal packaged proof harness. */
    profileProtection?: import("../browser/profile-protection.js").MacProfileProtection;
  },
): Promise<VillageAppWindow> {
  ensureVillageProtocolInstalled(
    protocol,
    fileURLToPath(new URL("../renderer", import.meta.url)),
  );
  const preloadPath = defaultPreloadPath(app.getAppPath());
  const userDataPath = app.getPath("userData");
  const pendingSessionErasure = new PendingSessionErasureStore(
    join(userDataPath, "session-erasure"),
  );
  await completePendingSessionErasure(
    pendingSessionErasure,
    LocalBrowserHost.profileRoot(userDataPath),
  );
  const identityDirectory = join(userDataPath, "identity");
  const packagedProtector = app.isPackaged
    ? new ElectronSafeStorageProtector()
    : undefined;
  if (packagedProtector) {
    assertMacOsProfileEncryptionAvailable(
      await packagedProtector.availability(),
      true,
    );
  }
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
      deliverNotification: async () => {
        if (!Notification.isSupported()) {
          throw new Error("LOCAL_NOTIFICATION_UNAVAILABLE");
        }
        new Notification({
          title: "Village needs your attention",
          body: "Open Village on this Mac to continue the active Ritual.",
        }).show();
      },
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
    ...(internalComposition?.profileProtection
      ? { profileProtection: internalComposition.profileProtection }
      : {}),
    verifyStepUp: () => verifyMacOsOwnerPresence(),
    stageSessionErasure: (binding) => pendingSessionErasure.stage(binding),
    restartAfterSessionErasure: () => {
      app.relaunch();
      setImmediate(() => app.quit());
    },
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
  const updateAwareWindow =
    app.isPackaged && !internalComposition
      ? startPackagedDesktopUpdates(villageWindow, {
          loadPolicy: () => loadPackagedUpdateTrustPolicy(app.getAppPath()),
          createService: (policy) =>
            new DesktopUpdateService({
              policy,
              currentVersion: app.getVersion(),
              stagingRoot: join(userDataPath, "updates"),
              fetch: desktopUpdateFetch,
              verifier: new MacOsUpdateArtifactVerifier(),
              installer: new ElectronMacUpdateInstaller(autoUpdater, {
                onBackgroundError: () => {
                  villageWindow.reportLocalDiagnostic({
                    component: "UPDATER",
                    code: "UPDATE_INSTALLER_BACKGROUND_ERROR",
                    retriable: false,
                  });
                },
              }),
            }),
          confirmInstall: async (version) => {
            const result = await dialog.showMessageBox({
              type: "info",
              buttons: ["Restart and update", "Later"],
              defaultId: 0,
              cancelId: 1,
              noLink: true,
              title: "Village update ready",
              message: `Village ${version} is ready to install.`,
              detail:
                "Village verified the update package and signer. Choose Later to skip it for now; Village will check again next time it starts.",
            });
            return result.response === 0;
          },
        })
      : villageWindow;
  return startNonBlockingContinuityEnrollment(
    updateAwareWindow,
    enrollContinuityRecipient,
  );
}

export async function runVillageApplication(
  pairedIdentitySource?: PairedRuntimeIdentitySource,
  internalComposition?: Parameters<typeof startVillageRuntime>[1],
): Promise<VillageAppWindow> {
  await app.whenReady();
  await ensureRitualServices();
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
  await ensureRitualServices();
  ensureVillageProtocolInstalled(
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

async function createRitualBuilderSurface(): Promise<RitualBuilderWindow> {
  const services = await ensureRitualServices();
  return createRitualBuilderWindow({
    preloadPath: join(
      app.getAppPath(),
      "dist",
      "preload",
      "ritual-builder-bridge.cjs",
    ),
    controller: services.controller,
    exaCredentials: services.exaCredentials,
    openExaDashboard: () =>
      shell.openExternal("https://dashboard.exa.ai/api-keys"),
  });
}

async function ensureRitualServices(): Promise<RitualRuntimeServices> {
  if (ritualServices) return ritualServices;
  if (ritualServicesLaunch) return ritualServicesLaunch;
  ritualServicesLaunch = createRitualServices();
  try {
    ritualServices = await ritualServicesLaunch;
    ritualServices.scheduler.start();
    return ritualServices;
  } finally {
    ritualServicesLaunch = undefined;
  }
}

async function createRitualServices(): Promise<RitualRuntimeServices> {
  const exaApiKeyStore = new ExaApiKeyStore(
    new SecretVault(
      join(app.getPath("userData"), "research", "exa-vault.json"),
      new ElectronSafeStorageProtector(),
    ),
  );
  const exaCredentials = new ExaCredentialController(exaApiKeyStore);
  const repository = new RitualRepository(
    join(app.getPath("userData"), "rituals", "approved.json"),
  );
  let scheduler: RitualScheduler | undefined;
  const controller = new RitualBuilderController(
    new CodexRitualStewardProvider(() => new CodexStdioTransport()),
    repository,
    {
      runExecutor: new LocalRitualRunExecutor({
        research: new ExaSearchProvider({ credentials: exaApiKeyStore }),
      }),
      onScheduleChanged: () => scheduler?.wake(),
    },
  );
  scheduler = new RitualScheduler(repository, controller);
  return {
    controller,
    scheduler,
    exaCredentials,
  };
}
