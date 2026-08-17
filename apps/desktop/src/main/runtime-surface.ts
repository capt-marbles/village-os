export function activateRuntimeSurface(
  arguments_: readonly string[],
  actions: {
    acceptPairingLink(value: string): boolean;
    openBrowserWorkspace(): void;
  },
): boolean {
  let pairingAccepted = false;
  for (const argument of arguments_) {
    pairingAccepted = actions.acceptPairingLink(argument) || pairingAccepted;
  }
  if (!arguments_.includes("--browser-workspace") && !pairingAccepted) {
    return false;
  }
  actions.openBrowserWorkspace();
  return true;
}
