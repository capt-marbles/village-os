import { parsePairingDeepLink } from "./pairing-deep-link.js";

export type RuntimeSurface = "WORKSPACE" | "RITUAL_BUILDER";

export function resolveRuntimeSurface(
  arguments_: readonly string[],
): RuntimeSurface {
  return arguments_.includes("--browser-workspace") ||
    arguments_.some((argument) => parsePairingDeepLink(argument) !== null)
    ? "WORKSPACE"
    : "RITUAL_BUILDER";
}

export function activateRuntimeSurface(
  arguments_: readonly string[],
  actions: {
    acceptPairingLink(value: string): unknown;
    openWorkspace(): unknown;
  },
): boolean {
  if (resolveRuntimeSurface(arguments_) !== "WORKSPACE") return false;
  for (const argument of arguments_) {
    if (parsePairingDeepLink(argument)) actions.acceptPairingLink(argument);
  }
  actions.openWorkspace();
  return true;
}
