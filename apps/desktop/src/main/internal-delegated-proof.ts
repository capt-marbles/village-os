import {
  OWNED_FIXTURE_ORIGIN,
  setupLogicalStepSchema,
  type SetupModelProviderContext,
} from "@village/contracts";
import type { DelegatedWorkflowSnapshot } from "@village/ui";
import { app, type Session } from "electron";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ActionJournal } from "../browser/action-journal.js";
import { FixtureCdpAdapter } from "../browser/cdp-adapter.js";
import { LocalBrowserHost } from "../browser/local-browser-host.js";
import type { BoundedSetupModelProvider } from "../model-provider/codex-app-server.js";
import {
  DelegatedWorkflowController,
  type CoordinatorSnapshot,
  type SetupLogicalStep,
  type WorkflowRuntimeResult,
} from "./delegated-workflow-controller.js";
import { DesktopDelegatedWorkflow } from "./desktop-delegated-workflow.js";
import { installFixtureSessionHandler } from "./fixture-session-handler.js";
import { createInternalProofId } from "./internal-proof-ids.js";

const identity = Object.freeze({
  principalId: "prn_01J00000000000000000000000",
  deviceId: "dev_01J00000000000000000000000",
  jobId: "job_01J00000000000000000000000",
  browserSessionId: "brs_01J00000000000000000000000",
});
const objective = Object.freeze({
  kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1" as const,
  version: 1 as const,
});
const steps = setupLogicalStepSchema.options;
const effectIds = [
  "efx_01J00000000000000000000000",
  "efx_01J00000000000000000000001",
  "efx_01J00000000000000000000002",
  "efx_01J00000000000000000000003",
] as const;

type FixtureService = {
  observe(input: Record<string, unknown>): Promise<unknown>;
  execute(input: Record<string, unknown>): Promise<{ postcondition?: unknown }>;
  attempts(input: Record<string, unknown>): Promise<{ count: number }>;
};

interface InternalProofCoordinatorState {
  version: 1;
  cursor: number;
  stepIndex: number;
  leaseEpoch: number;
  controller: "AGENT" | "USER";
  canceled: boolean;
  actionPhase: CoordinatorSnapshot["actionPhase"];
  outstanding: CoordinatorSnapshot["outstandingAction"];
  completedEffects: {
    logicalStep: SetupLogicalStep;
    effectId: string;
  }[];
  lastEffectActor: "AGENT" | "OWNER" | null;
  lastDurableUpdateAt: string;
}

function initialCoordinatorState(): InternalProofCoordinatorState {
  return {
    version: 1,
    cursor: 1,
    stepIndex: 0,
    leaseEpoch: 1,
    controller: "AGENT",
    canceled: false,
    actionPhase: "ACCEPTED",
    outstanding: null,
    completedEffects: [],
    lastEffectActor: null,
    lastDurableUpdateAt: new Date().toISOString(),
  };
}

function parseCoordinatorState(
  candidate: unknown,
): InternalProofCoordinatorState {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("INTERNAL_PROOF_COORDINATOR_STATE_CORRUPT");
  }
  const state = candidate as Partial<InternalProofCoordinatorState>;
  if (
    state.version !== 1 ||
    !Number.isInteger(state.cursor) ||
    (state.cursor ?? 0) < 1 ||
    !Number.isInteger(state.stepIndex) ||
    (state.stepIndex ?? -1) < 0 ||
    (state.stepIndex ?? steps.length) >= steps.length ||
    !Number.isInteger(state.leaseEpoch) ||
    (state.leaseEpoch ?? 0) < 1 ||
    !["AGENT", "USER"].includes(String(state.controller)) ||
    typeof state.canceled !== "boolean" ||
    ![
      "ACCEPTED",
      "DISPATCHED",
      "EFFECT_OBSERVED",
      "RECEIPTED",
      "RECONCILIATION_REQUIRED",
    ].includes(String(state.actionPhase)) ||
    !Array.isArray(state.completedEffects) ||
    !state.completedEffects.every(
      (effect) =>
        setupLogicalStepSchema.safeParse(effect.logicalStep).success &&
        effectIds.includes(effect.effectId as (typeof effectIds)[number]),
    ) ||
    !["AGENT", "OWNER", null].includes(state.lastEffectActor ?? null) ||
    typeof state.lastDurableUpdateAt !== "string"
  ) {
    throw new Error("INTERNAL_PROOF_COORDINATOR_STATE_CORRUPT");
  }
  return state as InternalProofCoordinatorState;
}

class InternalProofCoordinator {
  private lastStopReason: string | null = null;
  private interruptReceipt = false;

  private constructor(
    private readonly statePath: string,
    private readonly state: InternalProofCoordinatorState,
    interruptAfterEffectBeforeReceipt: boolean,
  ) {
    this.interruptReceipt = interruptAfterEffectBeforeReceipt;
  }

  static async open(
    statePath: string,
    interruptAfterEffectBeforeReceipt: boolean,
  ): Promise<InternalProofCoordinator> {
    let state = initialCoordinatorState();
    try {
      state = parseCoordinatorState(
        JSON.parse(await readFile(statePath, "utf8")),
      );
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }
    return new InternalProofCoordinator(
      statePath,
      state,
      interruptAfterEffectBeforeReceipt,
    );
  }

  private get cursor() {
    return this.state.cursor;
  }

  private get stepIndex() {
    return this.state.stepIndex;
  }

  private get leaseEpoch() {
    return this.state.leaseEpoch;
  }

  private get controller() {
    return this.state.controller;
  }

  private get canceled() {
    return this.state.canceled;
  }

  private get actionPhase() {
    return this.state.actionPhase;
  }

  private get outstanding() {
    return this.state.outstanding;
  }

  private get completedEffects() {
    return this.state.completedEffects;
  }

  private get lastEffectActor() {
    return this.state.lastEffectActor;
  }

  snapshot(): CoordinatorSnapshot {
    const index = Math.min(this.stepIndex, steps.length - 1);
    return {
      authenticated: true,
      cursor: this.cursor,
      connection: "ONLINE",
      controller: this.controller,
      automationBlocked: this.controller === "USER" || this.canceled,
      canceled: this.canceled,
      completedEffects: [...this.completedEffects],
      ...identity,
      objective,
      jobRevision: 1,
      logicalStep: steps[index]!,
      effectId: effectIds[index]!,
      leaseEpoch: this.leaseEpoch,
      actionPhase: this.actionPhase,
      outstandingAction: this.outstanding,
    };
  }

  async synchronize() {
    return this.snapshot();
  }

  async acceptAction(input: {
    actionId: string;
    logicalStep: SetupLogicalStep;
    effectId: string;
    command: { capability: string };
  }) {
    const current = this.snapshot();
    if (
      current.controller !== "AGENT" ||
      current.automationBlocked ||
      input.logicalStep !== current.logicalStep ||
      input.effectId !== current.effectId
    ) {
      return { ok: false as const, code: "STALE_WORKFLOW_BINDING" };
    }
    this.state.actionPhase = "ACCEPTED";
    this.state.outstanding = {
      actionId: input.actionId,
      logicalStep: input.logicalStep,
      effectId: input.effectId,
      leaseEpoch: this.leaseEpoch,
      capability: input.command.capability as never,
    };
    return {
      ok: true as const,
      actionId: input.actionId,
      cursor: await this.commit(),
    };
  }

  async recordReceipt(input: {
    receipt: Record<string, unknown>;
    checkpoint: Record<string, unknown>;
  }) {
    const currentStep = input.checkpoint.currentStep as SetupLogicalStep;
    const currentEffectId = String(input.checkpoint.currentEffectId);
    if (this.interruptReceipt && currentStep === "FINALIZE_SETUP") {
      this.interruptReceipt = false;
      this.state.actionPhase = "RECONCILIATION_REQUIRED";
      await this.commit();
      throw new Error("SIMULATED_POST_EFFECT_RECEIPT_INTERRUPTION");
    }
    this.completedEffects.push({
      logicalStep: currentStep,
      effectId: currentEffectId,
    });
    this.state.lastEffectActor = "AGENT";
    this.state.actionPhase = "RECEIPTED";
    this.state.outstanding = null;
    this.advance();
    return { ok: true as const, cursor: await this.commit() };
  }

  async recordOwnerProgress() {
    const current = this.snapshot();
    this.completedEffects.push({
      logicalStep: current.logicalStep,
      effectId: current.effectId,
    });
    this.state.lastEffectActor = "OWNER";
    this.state.actionPhase = "RECEIPTED";
    this.state.outstanding = null;
    this.advance();
    return { ok: true as const, cursor: await this.commit() };
  }

  async takeover() {
    this.state.controller = "USER";
    this.state.leaseEpoch += 1;
    return {
      ok: true as const,
      leaseEpoch: this.leaseEpoch,
      cursor: await this.commit(),
    };
  }

  async claimFreshLease() {
    this.state.controller = "AGENT";
    this.state.leaseEpoch += 1;
    return {
      ok: true as const,
      leaseEpoch: this.leaseEpoch,
      cursor: await this.commit(),
    };
  }

  async cancel(): Promise<void> {
    this.state.canceled = true;
    await this.commit();
  }

  projection(result?: WorkflowRuntimeResult): DelegatedWorkflowSnapshot {
    this.lastStopReason =
      result?.status === "WAITING_FOR_USER" || result?.status === "FENCED"
        ? result.reason
        : null;
    const snapshot = this.snapshot();
    const terminal = this.completedEffects.length === steps.length;
    const state = projectionState(result, terminal);
    return {
      workflowKind: objective.kind,
      state,
      logicalStep: snapshot.logicalStep,
      controller: state === "OWNER_CONTROL" ? "USER" : snapshot.controller,
      connection: "ONLINE",
      actionPhase: snapshot.actionPhase,
      lastEffectActor: this.lastEffectActor,
      humanGate:
        result?.status === "WAITING_FOR_USER" && result.gate
          ? result.gate
          : null,
      inputOwner: state === "OWNER_CONTROL" ? "OWNER" : "NONE",
      lastDurableUpdateAt: this.state.lastDurableUpdateAt,
    };
  }

  stopReason(): string | null {
    return this.lastStopReason;
  }

  private advance(): void {
    if (this.stepIndex < steps.length - 1) {
      this.state.stepIndex += 1;
      this.state.actionPhase = "ACCEPTED";
    }
  }

  private async commit(): Promise<number> {
    this.state.cursor += 1;
    this.state.lastDurableUpdateAt = new Date().toISOString();
    const directory = dirname(this.statePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state), {
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, this.statePath);
    return this.state.cursor;
  }
}

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

function projectionState(
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

function fixtureUrl(snapshot: CoordinatorSnapshot): string {
  const url = new URL("/setup", OWNED_FIXTURE_ORIGIN);
  url.searchParams.set("logicalStep", snapshot.logicalStep);
  url.searchParams.set("effectId", snapshot.effectId);
  return url.href;
}

export async function createInternalDelegatedProof(options: {
  userDataPath: string;
  providerMode: "DETERMINISTIC" | "CHATGPT_ACCOUNT";
  modelProvider?: BoundedSetupModelProvider;
  variantId?: string;
  interruptAfterEffectBeforeReceipt?: boolean;
  abruptlyExitAfterFinalEffect?: () => void;
  delayProviderAfterFirstStepMs?: number;
}) {
  const fixtureRoot = join(
    process.resourcesPath,
    "internal-proof/node_modules/@village/test-auth-site/dist",
  );
  const [{ LocalOwnedFixtureService }, { createOwnedFixtureRequestHandler }] =
    await Promise.all([
      import(pathToFileURL(join(fixtureRoot, "local-service.js")).href),
      import(pathToFileURL(join(fixtureRoot, "request-handler.js")).href),
    ]);
  const binding = { ...identity, sessionKind: "OWNED_FIXTURE" as const };
  const service = (await LocalOwnedFixtureService.open(binding, {
    variantId: options.variantId ?? "setup-stacked",
    effectGrants: steps.map((logicalStep, index) => ({
      logicalStep,
      effectId: effectIds[index]!,
    })),
    createFinalizationId: () => "local-finalization-packaged-proof",
    stateFilePath: join(
      options.userDataPath,
      "internal-proof/fixture-state.json",
    ),
  })) as FixtureService;
  const handler = createOwnedFixtureRequestHandler({ service, binding }) as (
    request: Request,
  ) => Promise<Response>;
  const coordinator = await InternalProofCoordinator.open(
    join(options.userDataPath, "internal-proof/coordinator-state.json"),
    options.interruptAfterEffectBeforeReceipt === true,
  );
  let fixtureHost: LocalBrowserHost | undefined;
  let adapter: FixtureCdpAdapter | undefined;
  const provider =
    options.providerMode === "CHATGPT_ACCOUNT"
      ? options.modelProvider
      : undefined;
  if (options.providerMode === "CHATGPT_ACCOUNT" && !provider) {
    throw new Error("SHARED_MODEL_PROVIDER_REQUIRED");
  }
  const controller = new DelegatedWorkflowController({
    binding: coordinator.snapshot(),
    coordinator,
    automationFence: {
      synchronize: async () => {
        const current = coordinator.snapshot();
        return {
          ok: true,
          cursor: current.cursor,
          jobId: current.jobId,
          controller: current.controller,
          connection: current.connection,
          leaseEpoch: current.leaseEpoch,
          automationBlocked: current.automationBlocked,
          canceled: current.canceled,
          workflow: null,
        };
      },
    },
    fixture: {
      captureOwnerState: async () => {
        if (!adapter) throw new Error("FIXTURE_BROWSER_UNAVAILABLE");
        return adapter.captureOwnerState();
      },
      observe: async () => {
        if (!adapter) throw new Error("FIXTURE_BROWSER_UNAVAILABLE");
        return adapter.observeSetup();
      },
      execute: async (input) => {
        if (!adapter) throw new Error("FIXTURE_BROWSER_UNAVAILABLE");
        const postcondition = await adapter.performSetupAction(input.command);
        if (
          input.logicalStep === "FINALIZE_SETUP" &&
          options.abruptlyExitAfterFinalEffect
        ) {
          options.abruptlyExitAfterFinalEffect();
          throw new Error("ABRUPT_PROOF_EXIT_DID_NOT_TERMINATE");
        }
        return { postcondition };
      },
    },
    journal: new ActionJournal(
      join(options.userDataPath, "internal-proof/journal.json"),
    ),
    provider: provider
      ? async (context: SetupModelProviderContext) =>
          provider.nextSetupAction(context, { timeoutMs: 30_000 })
      : async (context: SetupModelProviderContext) => {
          if (
            context.logicalStep !== "SET_DISPLAY_NAME" &&
            options.delayProviderAfterFirstStepMs
          ) {
            await new Promise((resolve) =>
              setTimeout(resolve, options.delayProviderAfterFirstStepMs),
            );
          }
          return {
            status: "action" as const,
            jobId: context.jobId,
            jobRevision: context.jobRevision,
            logicalStep: context.logicalStep,
            effectId: context.effectId,
            leaseEpoch: context.leaseEpoch,
            command: context.allowedActions[0]!,
          };
        },
    createActionId: () => createInternalProofId("act"),
    createReceiptId: () => createInternalProofId("rcp"),
    createCheckpointId: () => createInternalProofId("chk"),
  });
  const initial = coordinator.projection();
  initial.state = "READY";
  const workflow = new DesktopDelegatedWorkflow(initial, controller, {
    providerConnected: () => true,
    createFixtureHost: async () => {
      fixtureHost = await LocalBrowserHost.create({
        ...identity,
        site: "OWNED_FIXTURE",
        profileRoot: LocalBrowserHost.profileRoot(options.userDataPath),
        initialUrl: fixtureUrl(coordinator.snapshot()),
        prepareSession: async (browserSession: Session) =>
          installFixtureSessionHandler(browserSession.protocol, handler),
      });
      adapter = new FixtureCdpAdapter(
        "OWNED_FIXTURE",
        fixtureHost.view.webContents.debugger,
      );
      return fixtureHost;
    },
    readCanonicalSnapshot: async (result) => {
      const projection = coordinator.projection(result);
      if (fixtureHost && !fixtureHost.view.webContents.isDestroyed()) {
        const target = fixtureUrl(coordinator.snapshot());
        if (fixtureHost.view.webContents.getURL() !== target) {
          await fixtureHost.view.webContents.loadURL(target);
        }
      }
      return projection;
    },
  });
  return {
    delegatedWorkflow: workflow,
    evidence: async () => ({
      snapshot: workflow.snapshot(),
      finalizationEffects: (
        await service.attempts({
          ...binding,
          effectId: effectIds[3],
        })
      ).count,
      stopReason: coordinator.stopReason(),
      leaseEpoch: coordinator.snapshot().leaseEpoch,
      cursor: coordinator.snapshot().cursor,
      completedEffectCount: coordinator.snapshot().completedEffects.length,
    }),
    cancelFromObserver: async () => {
      await coordinator.cancel();
      return workflow.cancel();
    },
    close: async () => {
      adapter?.detach();
    },
  };
}

export function internalProofIdentitySource() {
  return { load: async () => ({ ...identity }) };
}

export function internalProofUserDataPath(): string {
  return app.getPath("userData");
}
