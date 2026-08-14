import type { DelegatedWorkflowSnapshot } from "@village/ui";
import type { WorkflowRuntimeResult } from "./delegated-workflow-controller.js";

const terminalProviderFailures = new Set<
  Extract<WorkflowRuntimeResult, { status: "WAITING_FOR_USER" }>["reason"]
>([
  "PROVIDER_UNAVAILABLE",
  "AUTHENTICATION_REQUIRED",
  "MALFORMED_PROVIDER_OUTPUT",
  "NO_SAFE_ACTION",
  "SITE_POLICY_DENIED",
  "TIME_BUDGET_EXHAUSTED",
  "TURN_BUDGET_EXHAUSTED",
]);

export function proofProjectionState(
  result: WorkflowRuntimeResult | undefined,
  terminal: boolean,
): DelegatedWorkflowSnapshot["state"] {
  if (terminal) return "RECEIPTED_SUCCESS";
  if (!result) return "WORKING";
  switch (result.status) {
    case "OWNER_CONTROL":
      return "OWNER_CONTROL";
    case "WAITING_FOR_USER":
      return terminalProviderFailures.has(result.reason)
        ? "FAILED"
        : "HUMAN_GATE";
    case "FENCED":
      return result.reason === "CANCELED" ? "CANCELLED" : "OFFLINE";
    case "RECEIPTED":
    case "OWNER_STATE_ACCEPTED":
      return "WORKING";
  }
}
