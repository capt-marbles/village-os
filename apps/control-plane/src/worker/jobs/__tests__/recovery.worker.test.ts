import { describe, expect, it } from "vitest";
import type { BrowserAction, BrowserControlState } from "@village/contracts";
import { reconcileBrowserRecovery } from "../reconciler.js";

const state: BrowserControlState = {
  principalId: "prn_01J00000000000000000000000",
  deviceId: "dev_01J00000000000000000000000",
  jobId: "job_01J00000000000000000000000",
  browserSessionId: "brs_01J00000000000000000000000",
  controller: "AGENT",
  connection: "ONLINE",
  leaseEpoch: 4,
  leaseExpiresAt: "2026-08-12T18:00:00.000Z",
  lastAcceptedSequence: 9,
  automationBlocked: false,
  takeover: "NONE",
  profile: "PRESENT",
};

function action(
  actionId: string,
  mutationClass: BrowserAction["mutationClass"],
  postcondition: BrowserAction["postcondition"],
): BrowserAction {
  return {
    actionId: actionId as BrowserAction["actionId"],
    browserSessionId: state.browserSessionId,
    phase: "DISPATCHED",
    mutationClass,
    acceptedAt: "2026-08-12T17:59:00.000Z",
    updatedAt: "2026-08-12T17:59:01.000Z",
    postcondition,
  };
}

describe("browser recovery reconciliation", () => {
  it("fences an expired lease and selects exactly one deterministic idempotent continuation", () => {
    const first = action(
      "act_01J00000000000000000000001",
      "IDEMPOTENT",
      "NOT_SATISFIED",
    );
    const second = {
      ...action(
        "act_01J00000000000000000000002",
        "IDEMPOTENT",
        "NOT_SATISFIED",
      ),
      acceptedAt: "2026-08-12T17:59:30.000Z",
    };

    expect(
      reconcileBrowserRecovery({
        state,
        actions: [second, first],
        now: "2026-08-12T18:00:01.000Z",
      }),
    ).toMatchObject({
      control: {
        controller: "NONE",
        leaseEpoch: 5,
        leaseExpiresAt: null,
        automationBlocked: true,
        takeover: "RECONCILING",
      },
      continuation: {
        status: "RETRY_ALLOWED",
        actionId: first.actionId,
      },
      actions: [
        { actionId: first.actionId, disposition: "RETRY_ALLOWED" },
        { actionId: second.actionId, disposition: "RETRY_ALLOWED" },
      ],
    });
  });

  it("never retries an orphaned non-idempotent effect whose postcondition is unknown", () => {
    const unknownEffect = action(
      "act_01J00000000000000000000003",
      "NON_IDEMPOTENT",
      "UNKNOWN",
    );

    expect(
      reconcileBrowserRecovery({
        state,
        actions: [unknownEffect],
        now: "2026-08-12T18:00:01.000Z",
      }),
    ).toMatchObject({
      continuation: {
        status: "WAITING_FOR_USER",
        actionId: unknownEffect.actionId,
      },
      actions: [
        {
          actionId: unknownEffect.actionId,
          phase: "RECONCILIATION_REQUIRED",
          disposition: "WAITING_FOR_USER",
        },
      ],
    });
  });

  it("leaves a receipted action alone and does not mint a new continuation", () => {
    const receipted = {
      ...action(
        "act_01J00000000000000000000004",
        "NON_IDEMPOTENT",
        "SATISFIED",
      ),
      phase: "RECEIPTED" as const,
    };
    const result = reconcileBrowserRecovery({
      state: { ...state, leaseExpiresAt: "2026-08-12T18:01:00.000Z" },
      actions: [receipted],
      now: "2026-08-12T18:00:01.000Z",
    });

    expect(result.control).toEqual({
      ...state,
      leaseExpiresAt: "2026-08-12T18:01:00.000Z",
    });
    expect(result.continuation).toEqual({ status: "NONE" });
    expect(result.actions).toEqual([
      {
        actionId: receipted.actionId,
        phase: "RECEIPTED",
        disposition: "RECEIPTED",
      },
    ]);
  });

  it("retries a non-idempotent action accepted before dispatch because no effect began", () => {
    const accepted = {
      ...action(
        "act_01J00000000000000000000005",
        "NON_IDEMPOTENT",
        "UNOBSERVED",
      ),
      phase: "ACCEPTED" as const,
    };

    expect(
      reconcileBrowserRecovery({
        state,
        actions: [accepted],
        now: "2026-08-12T18:00:01.000Z",
      }),
    ).toMatchObject({
      continuation: { status: "RETRY_ALLOWED", actionId: accepted.actionId },
      actions: [
        {
          actionId: accepted.actionId,
          phase: "ACCEPTED",
          disposition: "RETRY_ALLOWED",
        },
      ],
    });
  });

  it("converts a locally observed effect with a satisfied postcondition into a receipt", () => {
    const observed = {
      ...action(
        "act_01J00000000000000000000006",
        "NON_IDEMPOTENT",
        "SATISFIED",
      ),
      phase: "EFFECT_OBSERVED" as const,
    };
    const result = reconcileBrowserRecovery({
      state,
      actions: [observed],
      now: "2026-08-12T18:00:01.000Z",
    });

    expect(result.continuation).toEqual({ status: "NONE" });
    expect(result.actions).toEqual([
      {
        actionId: observed.actionId,
        phase: "RECEIPTED",
        disposition: "RECEIPTED",
      },
    ]);
  });
});
