import { app, protocol } from "electron";
import { fileURLToPath } from "node:url";
import { createVillageAppWindow, defaultPreloadPath } from "./app-window.js";
import {
  installVillageProtocol,
  registerVillageScheme,
} from "./local-app-protocol.js";
import {
  resolveRuntimeIdentity,
  type PairedRuntimeIdentitySource,
} from "./runtime-identity.js";
import { installGlobalSecurityPolicy } from "./security.js";

registerVillageScheme(protocol);
installGlobalSecurityPolicy(app);

export async function startVillageRuntime(
  pairedIdentitySource?: PairedRuntimeIdentitySource,
): Promise<void> {
  const identity = await resolveRuntimeIdentity({
    isPackaged: app.isPackaged,
    ...(pairedIdentitySource ? { pairedIdentitySource } : {}),
  });
  installVillageProtocol(
    protocol,
    fileURLToPath(new URL("../renderer", import.meta.url)),
  );
  await createVillageAppWindow({
    ...identity,
    site: "LINKEDIN",
    initialUrl: "https://www.linkedin.com/login",
    userDataPath: app.getPath("userData"),
    preloadPath: defaultPreloadPath(app.getAppPath()),
  });
}

void app
  .whenReady()
  .then(() => startVillageRuntime())
  .catch((error: unknown) => {
    console.error("Village startup blocked:", error);
    app.exit(1);
  });

app.on("window-all-closed", () => app.quit());
