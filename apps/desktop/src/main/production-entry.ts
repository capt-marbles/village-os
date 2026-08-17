import { app, dialog } from "electron";
import {
  isProfileProtectionFailure,
  profileProtectionFailureCopy,
} from "../browser/profile-protection.js";
import {
  acceptRuntimePairingLink,
  runRitualBuilderApplication,
  runVillageApplication,
} from "./runtime.js";
import { createProductionActivationCoordinator } from "./production-activation.js";
import { claimVillageInstance } from "./single-instance.js";

function reportActivationFailure(error: unknown) {
  console.error("Village browser workspace activation blocked:", error);
}

const activation = createProductionActivationCoordinator({
  acceptPairingLink: acceptRuntimePairingLink,
  runSteward: runRitualBuilderApplication,
  runBrowserWorkspace: runVillageApplication,
  reportActivationFailure,
});

const ownsInstance = claimVillageInstance(app);
if (ownsInstance) {
  app.on("second-instance", (_event, commandLine) => {
    activation.activateExistingInstance(commandLine);
  });
  app.on("open-url", (event, url) => {
    activation.activateOpenUrl(event, url);
  });
}

const launch: Promise<unknown> = ownsInstance
  ? activation.initialLaunch(process.argv)
  : Promise.resolve();

void launch.catch((error: unknown) => {
  const code =
    error instanceof Error ? error.message : "UNKNOWN_STARTUP_FAILURE";
  if (isProfileProtectionFailure(error)) {
    dialog.showErrorBox(
      profileProtectionFailureCopy.title,
      profileProtectionFailureCopy.message,
    );
  }
  console.error("Village startup blocked:", code);
  app.exit(1);
});
