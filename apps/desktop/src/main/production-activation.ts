import { activateRuntimeSurface } from "./runtime-surface.js";

export interface BrowserWorkspaceLifecycle {
  window: {
    once(event: "closed", listener: () => void): unknown;
  };
}

interface ProductionActivationDependencies {
  acceptPairingLink(value: string): boolean;
  runSteward(): Promise<unknown>;
  runBrowserWorkspace(): Promise<BrowserWorkspaceLifecycle>;
  reportActivationFailure(error: unknown): void;
}

interface PreventableEvent {
  preventDefault(): void;
}

export interface ProductionActivationCoordinator {
  initialLaunch(arguments_: readonly string[]): Promise<unknown>;
  activateExistingInstance(arguments_: readonly string[]): void;
  activateOpenUrl(event: PreventableEvent, url: string): void;
}

export function createProductionActivationCoordinator(
  dependencies: ProductionActivationDependencies,
): ProductionActivationCoordinator {
  let workspaceLaunch: Promise<BrowserWorkspaceLifecycle> | undefined;

  const clearWorkspaceLaunch = (launch: Promise<BrowserWorkspaceLifecycle>) => {
    if (workspaceLaunch === launch) workspaceLaunch = undefined;
  };

  const openBrowserWorkspace = () => {
    if (workspaceLaunch) return workspaceLaunch;
    const launch = dependencies.runBrowserWorkspace();
    workspaceLaunch = launch;
    void launch.then(
      (workspace) => {
        workspace.window.once("closed", () => clearWorkspaceLaunch(launch));
      },
      () => clearWorkspaceLaunch(launch),
    );
    return launch;
  };

  const activateWorkspace = (
    arguments_: readonly string[],
    onWorkspace: () => void,
  ) =>
    activateRuntimeSurface(arguments_, {
      acceptPairingLink: dependencies.acceptPairingLink,
      openBrowserWorkspace: onWorkspace,
    });

  return {
    initialLaunch: (arguments_) => {
      let launch: Promise<BrowserWorkspaceLifecycle> | undefined;
      const workspaceActivated = activateWorkspace(arguments_, () => {
        launch = openBrowserWorkspace();
      });
      return workspaceActivated ? launch! : dependencies.runSteward();
    },
    activateExistingInstance: (arguments_) => {
      activateWorkspace(arguments_, () => {
        void openBrowserWorkspace().catch(dependencies.reportActivationFailure);
      });
    },
    activateOpenUrl: (event, url) => {
      if (
        activateWorkspace([url], () => {
          void openBrowserWorkspace().catch(
            dependencies.reportActivationFailure,
          );
        })
      ) {
        event.preventDefault();
      }
    },
  };
}
