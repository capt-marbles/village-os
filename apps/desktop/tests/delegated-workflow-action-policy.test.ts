import { delegatedWorkflowReadySnapshot } from "@village/ui";
import { describe, expect, it } from "vitest";
import { assertDelegatedWorkflowActionAllowed } from "../src/main/delegated-workflow-action-policy.js";

describe("delegated workflow action policy", () => {
  it("allows Start but rejects Retry and Cancel before owner start", () => {
    expect(() =>
      assertDelegatedWorkflowActionAllowed(
        "START",
        delegatedWorkflowReadySnapshot,
      ),
    ).not.toThrow();
    for (const action of ["RETRY", "CANCEL"] as const) {
      expect(() =>
        assertDelegatedWorkflowActionAllowed(
          action,
          delegatedWorkflowReadySnapshot,
        ),
      ).toThrow("FIXTURE_TASK_NOT_STARTED");
    }
  });

  it("allows recovery actions after a failed start", () => {
    const failed = {
      ...delegatedWorkflowReadySnapshot,
      state: "FAILED" as const,
    };
    expect(() =>
      assertDelegatedWorkflowActionAllowed("RETRY", failed),
    ).not.toThrow();
    expect(() =>
      assertDelegatedWorkflowActionAllowed("CANCEL", failed),
    ).not.toThrow();
  });
});
