import { app } from "electron";
import {
  acceptRuntimePairingLink,
  runRitualBuilderApplication,
  runVillageApplication,
} from "./runtime.js";
import { activateRuntimeSurface } from "./runtime-surface.js";
import { claimVillageInstance } from "./single-instance.js";

let workspaceLaunch: ReturnType<typeof runVillageApplication> | undefined;

function openBrowserWorkspace() {
  if (!workspaceLaunch) {
    workspaceLaunch = runVillageApplication();
    void workspaceLaunch.catch(() => {
      workspaceLaunch = undefined;
    });
  }
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
      openBrowserWorkspace: () =>
        void openBrowserWorkspace().catch(reportActivationFailure),
    });

  app.on("second-instance", (_event, commandLine) => {
    activateWorkspace(commandLine);
  });
  app.on("open-url", (event, url) => {
    if (activateWorkspace([url])) event.preventDefault();
  });
}

let launch: Promise<unknown> = Promise.resolve();
if (ownsInstance) {
  const initialWorkspaceActivated = activateRuntimeSurface(process.argv, {
    acceptPairingLink: acceptRuntimePairingLink,
    openBrowserWorkspace: () => {
      launch = openBrowserWorkspace();
    },
  });
  if (!initialWorkspaceActivated) launch = runRitualBuilderApplication();
}

void launch.catch((error: unknown) => {
  console.error("Village startup blocked:", error);
  app.exit(1);
});
