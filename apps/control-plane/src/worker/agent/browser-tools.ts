import {
  authorizeSiteCommand,
  resolveActionReconciliation,
  type BrowserCommand,
  type BrowserObservation,
  type Site,
} from "@village/contracts";

/**
 * The sole cloud-side ingress for model-requested browser actions. Provider
 * output never becomes authority: it must parse as the closed command grammar
 * and pass the selected site's policy before reaching the local host.
 */
export function authorizeAgentBrowserTool(site: Site, candidate: unknown) {
  if (site === "LINKEDIN") {
    return { ok: false, code: "SITE_CAPABILITY_DENIED" } as const;
  }
  return authorizeSiteCommand(site, candidate);
}

export function nextOwnedFixtureAction(
  observation: BrowserObservation,
): BrowserCommand | { wait: "NO_SAFE_ACTION" } {
  const gate = observation.facts.find((fact) => fact.id === "HUMAN_GATE");
  if (gate?.id !== "HUMAN_GATE" || gate.value !== "NONE") {
    const reason =
      gate?.id === "HUMAN_GATE" && gate.value !== "NONE"
        ? gate.value
        : "UNKNOWN_CHALLENGE";
    return {
      capability: "REQUEST_HUMAN_GATE",
      reason,
    };
  }
  const auth = observation.facts.find((fact) => fact.id === "AUTH_STATE");
  if (auth?.id === "AUTH_STATE" && auth.value === "POSSIBLY_AUTHENTICATED") {
    return {
      capability: "VERIFY_AUTHENTICATION",
      predicateVersion: "fixture-authenticated-v1",
    };
  }
  const action = observation.facts.find(
    (fact) => fact.id === "APPROVED_ACTION_AVAILABLE",
  );
  return action?.id === "APPROVED_ACTION_AVAILABLE" && action.value
    ? {
        capability: "REPLACE_DISPLAY_NAME",
      }
    : { wait: "NO_SAFE_ACTION" };
}

export function reconcileOwnedFixtureSubmit(
  postcondition: "SATISFIED" | "NOT_SATISFIED" | "UNKNOWN",
) {
  return resolveActionReconciliation("NON_IDEMPOTENT", postcondition);
}
