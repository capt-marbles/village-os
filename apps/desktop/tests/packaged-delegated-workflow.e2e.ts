import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setupLogicalStepSchema,
  type SetupModelProviderContext,
} from "@village/contracts";
import { LocalOwnedFixtureService } from "../../../packages/test-auth-site/src/local-service.js";
import { ActionJournal } from "../src/browser/action-journal.js";
import {
  DelegatedWorkflowController,
  type CoordinatorSnapshot,
  type SetupLogicalStep,
} from "../src/main/delegated-workflow-controller.js";
import { assertPackagedDelegatedWorkflowRun } from "../../../scripts/verify-delegated-workflow.mjs";

const temporaryDirectories = new Set<string>();
afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

const identity = {
  principalId: "prn_01J00000000000000000000000",
  deviceId: "dev_01J00000000000000000000000",
  jobId: "job_01J00000000000000000000000",
  browserSessionId: "brs_01J00000000000000000000000",
};
const steps = setupLogicalStepSchema.options;
const effectIds = [
  "efx_01J00000000000000000000000",
  "efx_01J00000000000000000000001",
  "efx_01J00000000000000000000002",
  "efx_01J00000000000000000000003",
] as const;
const idAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function nextTestId(prefix: "act" | "rcp" | "chk", sequence: number): string {
  return `${prefix}_01J0000000000000000000000${idAlphabet[sequence % idAlphabet.length]}`;
}

interface DeterministicCoordinatorStore {
  cursor: number;
  stepIndex: number;
  leaseEpoch: number;
  controller: "AGENT" | "USER";
  canceled: boolean;
  loseNextReceipt: boolean;
  outstanding: CoordinatorSnapshot["outstandingAction"];
  completedEffects: { logicalStep: SetupLogicalStep; effectId: string }[];
}

function deterministicCoordinator(
  store: DeterministicCoordinatorStore = {
    cursor: 1,
    stepIndex: 0,
    leaseEpoch: 1,
    controller: "AGENT",
    canceled: false,
    loseNextReceipt: false,
    outstanding: null,
    completedEffects: [],
  },
) {
  const snapshot = (): CoordinatorSnapshot => ({
    authenticated: true,
    cursor: store.cursor,
    connection: "ONLINE",
    controller: store.controller,
    automationBlocked: store.controller === "USER" || store.canceled,
    canceled: store.canceled,
    completedEffects: [...store.completedEffects],
    ...identity,
    objective: { kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1", version: 1 },
    jobRevision: 1,
    logicalStep: steps[Math.min(store.stepIndex, steps.length - 1)]!,
    effectId: effectIds[Math.min(store.stepIndex, effectIds.length - 1)]!,
    leaseEpoch: store.leaseEpoch,
    actionPhase: "ACCEPTED",
    outstandingAction: store.outstanding,
  });
  return {
    synchronize: vi.fn(async () => snapshot()),
    acceptAction: vi.fn(
      async (input: {
        actionId: string;
        logicalStep: SetupLogicalStep;
        effectId: string;
        command: { capability: string };
      }) => {
        store.outstanding = {
          actionId: input.actionId,
          logicalStep: input.logicalStep,
          effectId: input.effectId,
          leaseEpoch: store.leaseEpoch,
          capability: input.command.capability as never,
        };
        return {
          ok: true as const,
          actionId: input.actionId,
          cursor: ++store.cursor,
        };
      },
    ),
    recordReceipt: vi.fn(
      async ({
        checkpoint,
      }: {
        checkpoint: { currentStep: SetupLogicalStep; currentEffectId: string };
      }) => {
        store.completedEffects.push({
          logicalStep: checkpoint.currentStep,
          effectId: checkpoint.currentEffectId,
        });
        store.outstanding = null;
        if (store.stepIndex < steps.length - 1) store.stepIndex += 1;
        store.cursor += 1;
        if (store.loseNextReceipt) {
          store.loseNextReceipt = false;
          throw new Error("SIMULATED_RECEIPT_RESPONSE_LOSS");
        }
        return { ok: true as const, cursor: store.cursor };
      },
    ),
    recordOwnerProgress: vi.fn(async () => {
      store.completedEffects.push({
        logicalStep: steps[store.stepIndex]!,
        effectId: effectIds[store.stepIndex]!,
      });
      if (store.stepIndex < steps.length - 1) store.stepIndex += 1;
      return { ok: true as const, cursor: ++store.cursor };
    }),
    claimFreshLease: vi.fn(async () => {
      store.controller = "AGENT";
      store.leaseEpoch += 1;
      return {
        ok: true as const,
        leaseEpoch: store.leaseEpoch,
        cursor: ++store.cursor,
      };
    }),
    takeover: vi.fn(async () => {
      store.controller = "USER";
      store.leaseEpoch += 1;
      return {
        ok: true as const,
        leaseEpoch: store.leaseEpoch,
        cursor: ++store.cursor,
      };
    }),
    cancel: () => {
      store.canceled = true;
      store.cursor += 1;
    },
    loseNextReceipt: () => {
      store.loseNextReceipt = true;
    },
    restart: () => deterministicCoordinator(store),
    current: snapshot,
  };
}

async function deterministicWorkflowHarness(variantId = "setup-stacked") {
  const root = await mkdtemp(join(tmpdir(), "village-u7-"));
  temporaryDirectories.add(root);
  let coordinator = deterministicCoordinator();
  const service = new LocalOwnedFixtureService(
    { ...identity, sessionKind: "OWNED_FIXTURE" },
    {
      variantId,
      effectGrants: steps.map((logicalStep, index) => ({
        logicalStep,
        effectId: effectIds[index]!,
      })),
      createFinalizationId: () => "local-finalization-u7",
    },
  );
  let sequence = 0;
  const journal = new ActionJournal(join(root, "journal.json"));
  const fixture = {
    observe: async (binding) =>
      service.observe({
        ...identity,
        sessionKind: "OWNED_FIXTURE",
        logicalStep: binding.logicalStep,
        effectId: binding.effectId,
      }),
    execute: async (input) => {
      const result = await service.execute({
        ...identity,
        sessionKind: "OWNED_FIXTURE",
        logicalStep: input.logicalStep,
        effectId: input.effectId,
        capability: input.command.capability,
      });
      return { postcondition: result.postcondition ?? "UNKNOWN" };
    },
  };
  const createProvider = () => async (context: SetupModelProviderContext) => ({
    status: "action" as const,
    jobId: context.jobId,
    jobRevision: context.jobRevision,
    logicalStep: context.logicalStep,
    effectId: context.effectId,
    leaseEpoch: context.leaseEpoch,
    command: context.allowedActions[0]!,
  });
  let provider = createProvider();
  const createController = () =>
    new DelegatedWorkflowController({
      binding: coordinator.current(),
      coordinator,
      fixture,
      journal,
      provider,
      createActionId: () => nextTestId("act", sequence++),
      createReceiptId: () => nextTestId("rcp", sequence++),
      createCheckpointId: () => nextTestId("chk", sequence++),
    });
  return {
    controller: createController(),
    restartDesktop: createController,
    restartCoordinator: () => {
      coordinator = coordinator.restart();
      return createController();
    },
    restartProvider: () => {
      provider = createProvider();
      return createController();
    },
    coordinator,
    service,
  };
}

describe("packaged delegated workflow evidence gates", () => {
  it("rejects a packaged run without a visible exact-once terminal state", () => {
    expect(() =>
      assertPackagedDelegatedWorkflowRun(
        {
          status: "PASS",
          provider: "DETERMINISTIC",
          readyLabel: "Ready for delegated setup",
          terminal: { state: "RECEIPTED_SUCCESS" },
          finalizationEffects: 1,
          fixtureSurfaceVisible: true,
        },
        "DETERMINISTIC",
      ),
    ).not.toThrow();
    expect(() =>
      assertPackagedDelegatedWorkflowRun(
        {
          status: "PASS",
          provider: "DETERMINISTIC",
          readyLabel: "Ready for delegated setup",
          terminal: { state: "RECEIPTED_SUCCESS" },
          finalizationEffects: 2,
          fixtureSurfaceVisible: true,
        },
        "DETERMINISTIC",
      ),
    ).toThrow("DELEGATED_WORKFLOW_FINALIZATION_NOT_EXACTLY_ONCE");
  });

  it("composes the four-step fixture with one durable finalization", async () => {
    const { controller, service } = await deterministicWorkflowHarness();
    for (const logicalStep of steps) {
      const result = await controller.runOnce();
      expect(result.status, `${logicalStep}: ${JSON.stringify(result)}`).toBe(
        "RECEIPTED",
      );
      expect((await controller.journalEntries()).at(-1)).toMatchObject({
        logicalStep,
        phase: "RECEIPTED",
      });
    }
    await expect(
      service.attempts({
        ...identity,
        sessionKind: "OWNED_FIXTURE",
        effectId: effectIds[3],
      }),
    ).resolves.toMatchObject({ count: 1 });
  });

  it("fences Human Gates and authenticated observer cancellation before mutation", async () => {
    const gated = await deterministicWorkflowHarness("challenge-two-factor");
    await expect(gated.controller.runOnce()).resolves.toMatchObject({
      status: "WAITING_FOR_USER",
      reason: "HUMAN_GATE_REQUIRED",
      gate: "TWO_FACTOR",
    });
    expect(gated.coordinator.acceptAction).not.toHaveBeenCalled();

    const canceled = await deterministicWorkflowHarness();
    canceled.coordinator.cancel();
    await expect(canceled.controller.runOnce()).resolves.toEqual({
      status: "FENCED",
      reason: "CANCELED",
    });
    expect(canceled.coordinator.acceptAction).not.toHaveBeenCalled();
  });

  it("survives owner takeover, hand-back, provider/desktop restart, and lost receipt without duplicate finalization", async () => {
    const owner = await deterministicWorkflowHarness();
    await expect(owner.controller.takeover(20)).resolves.toMatchObject({
      status: "OWNER_CONTROL",
      outcome: "QUIESCED",
    });
    await owner.service.applyOwnerState(
      {
        ...identity,
        sessionKind: "OWNED_FIXTURE",
        logicalStep: "SET_DISPLAY_NAME",
        effectId: effectIds[0],
      },
      {
        displayName: "Village Operator",
        role: "OPERATOR",
        preferredFocus: "RELIABILITY",
      },
    );
    await expect(owner.controller.handBack()).resolves.toMatchObject({
      status: "OWNER_STATE_ACCEPTED",
    });
    expect(owner.coordinator.recordOwnerProgress).toHaveBeenCalledTimes(1);

    const interrupted = await deterministicWorkflowHarness();
    let controller = interrupted.controller;
    await expect(controller.runOnce()).resolves.toMatchObject({
      status: "RECEIPTED",
    });
    controller = interrupted.restartDesktop();
    await expect(controller.runOnce()).resolves.toMatchObject({
      status: "RECEIPTED",
    });
    controller = interrupted.restartCoordinator();
    await expect(controller.runOnce()).resolves.toMatchObject({
      status: "RECEIPTED",
    });
    controller = interrupted.restartProvider();
    interrupted.coordinator.loseNextReceipt();
    await expect(controller.runOnce()).resolves.toEqual({
      status: "FENCED",
      reason: "COORDINATOR_UNAVAILABLE",
    });
    await expect(
      interrupted.service.attempts({
        ...identity,
        sessionKind: "OWNED_FIXTURE",
        effectId: effectIds[3],
      }),
    ).resolves.toMatchObject({ count: 1 });
    controller = interrupted.restartDesktop();
    await expect(controller.reconcile()).resolves.toMatchObject({
      status: "RECEIPTED",
      effectId: effectIds[3],
    });
    await expect(
      interrupted.service.attempts({
        ...identity,
        sessionKind: "OWNED_FIXTURE",
        effectId: effectIds[3],
      }),
    ).resolves.toMatchObject({ count: 1 });
  });
});
