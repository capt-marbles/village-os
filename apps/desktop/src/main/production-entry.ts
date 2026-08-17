import { app } from "electron";
import {
  acceptRuntimePairingLink,
  runRitualBuilderApplication,
  runVillageApplication,
} from "./runtime.js";
import {
  activateRuntimeSurface,
  resolveRuntimeSurface,
} from "./runtime-surface.js";
import { claimVillageInstance } from "./single-instance.js";

let workspaceLaunch: ReturnType<typeof runVillageApplication> | undefined;

function openWorkspace() {
  workspaceLaunch ??= runVillageApplication();
  return workspaceLaunch;
}

function reportActivationFailure(error: unknown) {
  console.error("Village browser workspace activation blocked:", error);
}

const ownsInstance = claimVillageInstance(app);
if (ownsInstance) {
  const activateWorkspace = (arguments_: readonly string[]) =>
    activateRuntimeSurface(arguments_, {
      acceptPairingLink: acceptRuntimePairingLink,
      openWorkspace: () => void openWorkspace().catch(reportActivationFailure),
    });

  app.on("second-instance", (_event, commandLine) => {
    activateWorkspace(commandLine);
  });
  app.on("open-url", (event, url) => {
    if (activateWorkspace([url])) event.preventDefault();
  });
}

const launch = ownsInstance
  ? resolveRuntimeSurface(process.argv) === "RITUAL_BUILDER"
    ? runRitualBuilderApplication()
    : openWorkspace()
  : Promise.resolve();

void launch.catch((error: unknown) => {
  console.error("Village startup blocked:", error);
  app.exit(1);
});
