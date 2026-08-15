import type {
  DelegatedWorkflowAction,
  DelegatedWorkflowSnapshot,
} from "@village/ui";

export function assertDelegatedWorkflowActionAllowed(
  action: DelegatedWorkflowAction,
  snapshot: DelegatedWorkflowSnapshot,
): void {
  if (
    snapshot.state === "READY" &&
    (action === "RETRY" || action === "CANCEL")
  ) {
    throw new Error("FIXTURE_TASK_NOT_STARTED");
  }
}
