import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ActionJournal } from "../src/browser/action-journal.js";
import {
  DelegatedWorkflowController,
  type CoordinatorSnapshot,
  type OwnedFixtureRuntime,
} from "../src/main/delegated-workflow-controller.js";

const ids = {
  principalId: "prn_01J00000000000000000000000",
  deviceId: "dev_01J00000000000000000000000",
  jobId: "job_01J00000000000000000000000",
  browserSessionId: "brs_01J00000000000000000000000",
  effectId: "efx_01J00000000000000000000000",
  actionId: "act_01J00000000000000000000000",
};

const binding = {
  ...ids,
  objective: { kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1", version: 1 } as const,
  jobRevision: 1,
  logicalStep: "SET_DISPLAY_NAME" as const,
  leaseEpoch: 1,
};

function observation(
  value: "MATCH" | "MISMATCH" | "MISSING" | "INVALID" = "MISSING",
) {
  return {
    schemaVersion: 1 as const,
    source: "BROWSER_UNTRUSTED" as const,
    workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1" as const,
    workflowVersion: 1 as const,
    logicalStep: "SET_DISPLAY_NAME" as const,
    effectId: ids.effectId,
    predicateIds: ["setup-display-name-v1", "setup-human-gate-v1"],
    facts: [
      { id: "DISPLAY_NAME_MATCH" as const, value },
      { id: "HUMAN_GATE" as const, value: "NONE" as const },
    ],
  };
}

function snapshot(
  overrides: Partial<CoordinatorSnapshot> = {},
): CoordinatorSnapshot {
  return {
    authenticated: true,
    cursor: 1,
    connection: "ONLINE",
    controller: "AGENT",
    automationBlocked: false,
    canceled: false,
    completedEffects: [],
    ...binding,
    actionPhase: "ACCEPTED",
    outstandingAction: null,
    ...overrides,
  };
}

async function harness(
  options: {
    snapshots?: CoordinatorSnapshot[];
    fixture?: Partial<OwnedFixtureRuntime>;
    maxProviderTurns?: number;
    now?: () => number;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "village-u4-"));
  const snapshots = options.snapshots ?? [snapshot(), snapshot({ cursor: 2 })];
  let index = 0;
  const coordinator = {
    synchronize: vi.fn(
      async () => snapshots[Math.min(index++, snapshots.length - 1)]!,
    ),
    acceptAction: vi.fn(async (input: { actionId: string }) => ({
      ok: true as const,
      actionId: input.actionId,
      cursor: 2,
    })),
    recordReceipt: vi.fn(async () => ({ ok: true as const, cursor: 3 })),
    claimFreshLease: vi.fn(async () => ({
      ok: true as const,
      leaseEpoch: 2,
      cursor: 4,
    })),
  };
  let matched = false;
  const fixture = {
    observe: vi.fn(async () => observation(matched ? "MATCH" : "MISSING")),
    execute: vi.fn(async () => {
      matched = true;
      return { postcondition: "SATISFIED" as const };
    }),
    ...options.fixture,
  };
  const provider = vi.fn(async (context) => ({
    status: "action" as const,
    jobId: context.jobId,
    jobRevision: context.jobRevision,
    logicalStep: context.logicalStep,
    effectId: context.effectId,
    leaseEpoch: context.leaseEpoch,
    command: { capability: "REPLACE_DISPLAY_NAME" as const },
  }));
  const controller = new DelegatedWorkflowController({
    binding,
    coordinator,
    fixture,
    journal: new ActionJournal(join(root, "journal.json")),
    provider,
    createActionId: () => ids.actionId,
    createReceiptId: () => "rcp_01J00000000000000000000000",
    createCheckpointId: () => "chk_01J00000000000000000000000",
    now: options.now,
    budgets: {
      maxReconciliations: 2,
      maxProviderTurns: options.maxProviderTurns ?? 2,
      maxDurationMs: 1_000,
    },
  });
  return { controller, coordinator, fixture, provider, root };
}

describe("delegated workflow runtime", () => {
  it("accepts before dispatch and journals every local evidence phase", async () => {
    const { controller, coordinator, fixture } = await harness();
    await expect(controller.runOnce()).resolves.toMatchObject({
      status: "RECEIPTED",
    });
    expect(coordinator.acceptAction.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.execute.mock.invocationCallOrder[0]!,
    );
    expect(
      (await controller.journalEntries()).map((entry) => entry.phase),
    ).toEqual(["ACCEPTED", "DISPATCHED", "EFFECT_OBSERVED", "RECEIPTED"]);
  });

  it("rejects a provider result made stale by takeover without dispatch", async () => {
    const { controller, coordinator, fixture, provider } = await harness();
    let release!: () => void;
    provider.mockImplementationOnce(async (context) => {
      await new Promise<void>((resolve) => (release = resolve));
      return {
        status: "action",
        jobId: context.jobId,
        jobRevision: context.jobRevision,
        logicalStep: context.logicalStep,
        effectId: context.effectId,
        leaseEpoch: context.leaseEpoch,
        command: { capability: "REPLACE_DISPLAY_NAME" },
      };
    });
    const running = controller.runOnce();
    await vi.waitFor(() => expect(provider).toHaveBeenCalled());
    await expect(controller.takeover(10)).resolves.toEqual({
      status: "OWNER_CONTROL",
      outcome: "QUIESCED",
      coordinatorSynchronized: false,
    });
    release();
    await expect(running).resolves.toEqual({
      status: "WAITING_FOR_USER",
      reason: "STALE_PROVIDER_RESULT",
    });
    expect(coordinator.acceptAction).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("fences dispatch when coordinator synchronization is unavailable", async () => {
    const { controller, fixture, provider } = await harness({
      snapshots: [{ ...snapshot(), authenticated: false }],
    });
    await expect(controller.runOnce()).resolves.toEqual({
      status: "FENCED",
      reason: "COORDINATOR_UNAVAILABLE",
    });
    expect(provider).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("keeps valid owner edits and gates invalid required fields on hand-back", async () => {
    const valid = await harness({
      fixture: { observe: vi.fn(async () => observation("MISMATCH")) },
    });
    valid.controller.takeoverOffline();
    await expect(valid.controller.handBack()).resolves.toEqual({
      status: "OWNER_STATE_ACCEPTED",
      leaseEpoch: 2,
    });
    expect(valid.fixture.execute).not.toHaveBeenCalled();

    const invalid = await harness({
      fixture: { observe: vi.fn(async () => observation("INVALID")) },
    });
    invalid.controller.takeoverOffline();
    await expect(invalid.controller.handBack()).resolves.toEqual({
      status: "WAITING_FOR_USER",
      reason: "INVALID_OWNER_EDIT",
    });
    expect(invalid.coordinator.claimFreshLease).not.toHaveBeenCalled();
  });

  it("reconciles post-effect restart from live truth and never repeats the effect", async () => {
    const root = await mkdtemp(join(tmpdir(), "village-u4-restart-"));
    const journal = new ActionJournal(join(root, "journal.json"));
    await journal.record({
      actionId: ids.actionId,
      jobId: binding.jobId,
      browserSessionId: binding.browserSessionId,
      logicalStep: binding.logicalStep,
      effectId: binding.effectId,
      leaseEpoch: binding.leaseEpoch,
      mutationClass: "IDEMPOTENT",
      phase: "DISPATCHED",
      postcondition: "UNOBSERVED",
      recordedAt: "2026-08-13T12:00:00.000Z",
    });
    const coordinator = {
      synchronize: vi.fn(async () =>
        snapshot({
          outstandingAction: {
            actionId: ids.actionId,
            logicalStep: binding.logicalStep,
            effectId: ids.effectId,
            leaseEpoch: 1,
          },
          actionPhase: "DISPATCHED",
        }),
      ),
      acceptAction: vi.fn(),
      recordReceipt: vi.fn(async () => ({ ok: true as const, cursor: 3 })),
      claimFreshLease: vi.fn(),
    };
    const fixture = {
      observe: vi.fn(async () => observation("MATCH")),
      execute: vi.fn(),
    };
    const controller = new DelegatedWorkflowController({
      binding,
      coordinator,
      fixture,
      journal,
      provider: vi.fn(),
      createActionId: () => ids.actionId,
      createReceiptId: () => "rcp_01J00000000000000000000000",
      createCheckpointId: () => "chk_01J00000000000000000000000",
    });
    await expect(controller.reconcile()).resolves.toMatchObject({
      status: "RECEIPTED",
    });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("owner-gates ambiguous finalization, corrupted journals, and budget exhaustion", async () => {
    const ambiguous = await harness({
      snapshots: [
        snapshot({
          logicalStep: "FINALIZE_SETUP",
          effectId: "efx_01J00000000000000000000001",
        }),
      ],
    });
    await expect(ambiguous.controller.reconcile()).resolves.toEqual({
      status: "WAITING_FOR_USER",
      reason: "OUTCOME_UNKNOWN",
    });

    const exhausted = await harness({ maxProviderTurns: 0 });
    await expect(exhausted.controller.runOnce()).resolves.toEqual({
      status: "WAITING_FOR_USER",
      reason: "TURN_BUDGET_EXHAUSTED",
    });

    const corrupt = await harness();
    await writeFile(
      join(corrupt.root, "journal.json"),
      "{pageText:secret",
      "utf8",
    );
    await expect(corrupt.controller.reconcile()).resolves.toEqual({
      status: "WAITING_FOR_USER",
      reason: "JOURNAL_CORRUPT",
    });
  });

  it.each([
    ["revision", { jobRevision: 2 }],
    ["step", { logicalStep: "SELECT_ROLE" as const }],
    ["effect", { effectId: "efx_01J00000000000000000000001" }],
    ["lease", { leaseEpoch: 2 }],
  ])("rejects a provider result stale by %s", async (_label, changed) => {
    const { controller, fixture, coordinator } = await harness({
      snapshots: [snapshot(), snapshot({ cursor: 2, ...changed })],
    });
    await expect(controller.runOnce()).resolves.toEqual({
      status: "WAITING_FOR_USER",
      reason: "STALE_PROVIDER_RESULT",
    });
    expect(coordinator.acceptAction).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("consumes authenticated cancellation and challenge state before mutation", async () => {
    const canceled = await harness({
      snapshots: [snapshot({ canceled: true })],
    });
    await expect(canceled.controller.runOnce()).resolves.toEqual({
      status: "FENCED",
      reason: "CANCELED",
    });
    expect(canceled.provider).not.toHaveBeenCalled();

    const challengedObservation = {
      ...observation(),
      facts: [
        { id: "DISPLAY_NAME_MATCH" as const, value: "MISSING" as const },
        { id: "HUMAN_GATE" as const, value: "TWO_FACTOR" as const },
      ],
    };
    const challenged = await harness({
      fixture: { observe: vi.fn(async () => challengedObservation) },
    });
    await expect(challenged.controller.runOnce()).resolves.toEqual({
      status: "WAITING_FOR_USER",
      reason: "HUMAN_GATE_REQUIRED",
      gate: "TWO_FACTOR",
    });
    expect(challenged.provider).not.toHaveBeenCalled();
    expect(challenged.fixture.execute).not.toHaveBeenCalled();
  });

  it("durably owner-gates wall-clock exhaustion", async () => {
    let time = 0;
    const expired = await harness({ now: () => time });
    time = 1_001;
    await expect(expired.controller.runOnce()).resolves.toEqual({
      status: "WAITING_FOR_USER",
      reason: "TIME_BUDGET_EXHAUSTED",
    });
    expect(expired.provider).not.toHaveBeenCalled();
  });
});
