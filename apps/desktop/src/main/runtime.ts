import { app, protocol } from "electron";
import { createVillageAppWindow, defaultPreloadPath } from "./app-window.js";
import {
  installVillageProtocol,
  registerVillageScheme,
} from "./local-app-protocol.js";
import { installGlobalSecurityPolicy } from "./security.js";

registerVillageScheme(protocol);
installGlobalSecurityPolicy(app);

void app.whenReady().then(async () => {
  installVillageProtocol(
    protocol,
    new URL("../renderer", import.meta.url).pathname,
  );
  await createVillageAppWindow({
    principalId: "usr_01J00000000000000000000000",
    deviceId: "dev_01J00000000000000000000000",
    browserSessionId: "bsn_01J00000000000000000000000",
    site: "LINKEDIN",
    initialUrl: "https://www.linkedin.com/login",
    userDataPath: app.getPath("userData"),
    preloadPath: defaultPreloadPath(app.getAppPath()),
  });
});

app.on("window-all-closed", () => app.quit());
