import { app, protocol, shell } from "electron";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SecretVault } from "../secrets/secret-vault.js";
import { createVillageAppWindow, defaultPreloadPath } from "./app-window.js";
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
import { installGlobalSecurityPolicy } from "./security.js";
import { verifyMacOsOwnerPresence } from "./step-up-auth.js";
import { createCodexAppServerProvider } from "../model-provider/codex-app-server.js";
import { ModelProviderAccountController } from "./model-provider-account.js";
import { PersonalAgentTaskController } from "./personal-agent-task.js";
import type { InternalDelegatedWorkflowOperations } from "./app-window.js";

registerVillageScheme(protocol);
installGlobalSecurityPolicy(app);
const pairingInbox = new PairingDeepLinkInbox();
app.on("open-url", (event, url) => {
  event.preventDefault();
  pairingInbox.accept(url);
});

function controlPlaneUrl(): URL {
  const configured = process.env.VILLAGE_CONTROL_PLANE_URL;
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
  },
): Promise<void> {
  installVillageProtocol(
    protocol,
    fileURLToPath(new URL("../renderer", import.meta.url)),
  );
  const preloadPath = defaultPreloadPath(app.getAppPath());
  let identity;
  if (!app.isPackaged) {
    identity = await resolveRuntimeIdentity({ isPackaged: false });
  } else if (pairedIdentitySource) {
    identity = await resolveRuntimeIdentity({
      isPackaged: true,
      pairedIdentitySource,
    });
  } else {
    const protector = new ElectronSafeStorageProtector();
    const identityDirectory = join(app.getPath("userData"), "identity");
    const runtimeStore = new SecretRuntimeIdentityStore(
      new SecretVault(join(identityDirectory, "runtime-vault.json"), protector),
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
      const pairingService = new PairingBootstrapService(
        new DeviceIdentityVault(
          join(identityDirectory, "device.json"),
          protector,
        ),
        new PairingClient(controlPlaneUrl().origin),
        runtimeStore,
        deviceIdForPublicKey,
        hostname().slice(0, 80) || "Village Mac",
      );
      identity = await createPairingWindow({
        preloadPath,
        service: pairingService,
        inbox: pairingInbox,
      });
    }
  }
  await createVillageAppWindow({
    ...identity,
    site: "LINKEDIN",
    initialUrl: "https://www.linkedin.com/login",
    userDataPath: app.getPath("userData"),
    preloadPath,
    modelProviderAccount: new ModelProviderAccountController(
      createCodexAppServerProvider(),
      (url) => shell.openExternal(url),
    ),
    personalAgentTask: new PersonalAgentTaskController(
      createCodexAppServerProvider(),
    ),
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
}

void app
  .whenReady()
  .then(() => {
    for (const argument of process.argv) pairingInbox.accept(argument);
    return startVillageRuntime();
  })
  .catch((error: unknown) => {
    console.error("Village startup blocked:", error);
    app.exit(1);
  });

app.on("window-all-closed", () => app.quit());
