import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import {
  approvedRitualRevisionSchema,
  approvedRitualStoreSchema,
  ritualLearningProposalSchema,
  ritualLearningDecisionSchema,
  ritualLearningDecisionRequestSchema,
  ritualInitialWorkspaceSnapshotSchema,
  ritualWorkspaceSnapshotSchema,
  ritualRunReceiptSchema,
  ritualRunSchema,
  ritualScheduleSchema,
  ritualStoreSchema,
  ritualStoreV2Schema,
  ritualStoreV3Schema,
  ritualStoreV4Schema,
  ritualStoreV5Schema,
  ritualDefinitionOf,
  ritualTestReceiptSchema,
  validateRitualRunReceipt,
  type ApprovedRitualRevision,
  type RitualStore,
  type RitualLearningProposal,
  type RitualLearningDecisionRequest,
  type RitualLearningReceipt,
  type RitualInboxItem,
  type RitualRun,
  type RitualRunReceipt,
  type RitualSchedule,
  type RitualTestReceipt,
  type RitualLatestSnapshot,
  type RitualCatalog,
  type RitualInitialWorkspaceSnapshot,
  type RitualWorkspaceSnapshot,
} from "@village/contracts";
import {
  findLatestLearningReceipt,
  findLearningReceipt,
  inboxFromStore,
  projectAutomationSnapshot,
  projectCatalog,
  projectLatestSnapshot,
} from "./ritual-snapshot-projections.js";

const MAX_PERSISTED_STORE_BYTES = 768 * 1_024;

export class RitualRepository {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly dependencies: {
      write?(store: RitualStore): Promise<void>;
      now?(): string;
    } = {},
  ) {}

  list(): Promise<readonly ApprovedRitualRevision[]> {
    return this.enqueue(async () => (await this.read()).rituals);
  }

  catalog(): Promise<RitualCatalog> {
    return this.enqueue(async () => projectCatalog(await this.read()));
  }

  initialWorkspaceSnapshot(): Promise<RitualInitialWorkspaceSnapshot> {
    return this.enqueue(async () => {
      const store = await this.read();
      const approved = store.rituals.at(-1) ?? null;
      return ritualInitialWorkspaceSnapshotSchema.parse({
        ...projectLatestSnapshot(store, approved),
        ...projectAutomationSnapshot(store, approved),
        rituals: projectCatalog(store),
      });
    });
  }

  workspaceSnapshotFor(
    ritualId: string,
  ): Promise<RitualWorkspaceSnapshot | null> {
    return this.enqueue(async () => {
      const store = await this.read();
      const approved =
        store.rituals.findLast((ritual) => ritual.ritualId === ritualId) ??
        null;
      return approved
        ? ritualWorkspaceSnapshotSchema.parse({
            ...projectLatestSnapshot(store, approved),
            ...projectAutomationSnapshot(store, approved),
          })
        : null;
    });
  }

  findRevision(
    ritualId: string,
    ritualRevision: number,
  ): Promise<ApprovedRitualRevision | null> {
    return this.enqueue(async () => {
      return (
        (await this.read()).rituals.find(
          (ritual) =>
            ritual.ritualId === ritualId &&
            ritual.ritualRevision === ritualRevision,
        ) ?? null
      );
    });
  }

  latestSnapshot(): Promise<RitualLatestSnapshot> {
    return this.enqueue(async () => {
      const store = await this.read();
      const approved = store.rituals.at(-1) ?? null;
      return projectLatestSnapshot(store, approved);
    });
  }

  snapshotFor(ritualId: string): Promise<RitualLatestSnapshot | null> {
    return this.enqueue(async () => {
      const store = await this.read();
      const approved = store.rituals.findLast(
        (ritual) => ritual.ritualId === ritualId,
      );
      return approved ? projectLatestSnapshot(store, approved) : null;
    });
  }

  automationSnapshot(): Promise<{
    approved: ApprovedRitualRevision | null;
    schedule: RitualSchedule | null;
    inbox: readonly RitualInboxItem[];
  }> {
    return this.enqueue(async () => {
      const store = await this.read();
      const approved = store.rituals.at(-1) ?? null;
      return projectAutomationSnapshot(store, approved);
    });
  }

  automationSnapshotFor(ritualId: string): Promise<{
    approved: ApprovedRitualRevision | null;
    schedule: RitualSchedule | null;
    inbox: readonly RitualInboxItem[];
  }> {
    return this.enqueue(async () => {
      const store = await this.read();
      const approved =
        store.rituals.findLast((ritual) => ritual.ritualId === ritualId) ??
        null;
      return projectAutomationSnapshot(store, approved);
    });
  }

  listSchedules(): Promise<readonly RitualSchedule[]> {
    return this.enqueue(async () => (await this.read()).schedules);
  }

  saveSchedule(
    candidate: RitualSchedule,
    options?: { expectedUpdatedAt: string | null },
  ): Promise<void> {
    return this.enqueue(async () => {
      const schedule = ritualScheduleSchema.parse(candidate);
      const current = await this.read();
      const latest = current.rituals.findLast(
        (ritual) => ritual.ritualId === schedule.ritualId,
      );
      if (!latest || latest.ritualRevision !== schedule.ritualRevision) {
        throw new Error("STALE_RITUAL_SCHEDULE");
      }
      const index = current.schedules.findIndex(
        (entry) =>
          entry.ritualId === schedule.ritualId &&
          entry.ritualRevision === schedule.ritualRevision,
      );
      const stored = current.schedules[index];
      if (
        options &&
        (stored?.updatedAt ?? null) !== options.expectedUpdatedAt
      ) {
        throw new Error("RITUAL_SCHEDULE_BUSY");
      }
      if (index < 0) {
        if (current.schedules.length >= 100) {
          throw new Error("RITUAL_SCHEDULE_STORE_FULL");
        }
        await this.write({
          ...current,
          schedules: [...current.schedules, schedule],
        });
        return;
      }
      const schedules = [...current.schedules];
      schedules[index] = schedule;
      await this.write({ ...current, schedules });
    });
  }

  claimScheduleOccurrence(candidate: {
    ritualId: RitualSchedule["ritualId"];
    ritualRevision: number;
    expectedDueAt: string;
    runId: RitualRun["runId"];
    nextRunAt: string;
    claimedAt: string;
  }): Promise<RitualSchedule | null> {
    return this.enqueue(async () => {
      const current = await this.read();
      const index = current.schedules.findIndex(
        (entry) =>
          entry.ritualId === candidate.ritualId &&
          entry.ritualRevision === candidate.ritualRevision,
      );
      const schedule = current.schedules[index];
      if (!schedule) return null;
      if (schedule.pendingOccurrence) return schedule;
      if (
        schedule.state !== "ENABLED" ||
        schedule.nextRunAt !== candidate.expectedDueAt ||
        Date.parse(schedule.nextRunAt) > Date.parse(candidate.claimedAt)
      ) {
        return null;
      }
      const claimed = ritualScheduleSchema.parse({
        ...schedule,
        nextRunAt: candidate.nextRunAt,
        pendingOccurrence: {
          runId: candidate.runId,
          dueAt: schedule.nextRunAt,
        },
        updatedAt: candidate.claimedAt,
      });
      const schedules = [...current.schedules];
      schedules[index] = claimed;
      await this.write({ ...current, schedules });
      return claimed;
    });
  }

  acknowledgeScheduleOccurrence(
    runId: RitualRun["runId"],
    acknowledgedAt: string,
  ): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.read();
      const index = current.schedules.findIndex(
        (schedule) => schedule.pendingOccurrence?.runId === runId,
      );
      const schedule = current.schedules[index];
      if (!schedule?.pendingOccurrence) return;
      const schedules = [...current.schedules];
      schedules[index] = ritualScheduleSchema.parse({
        ...schedule,
        pendingOccurrence: null,
        lastTriggeredAt: schedule.pendingOccurrence.dueAt,
        updatedAt: acknowledgedAt,
      });
      await this.write({ ...current, schedules });
    });
  }

  listInbox(): Promise<readonly RitualInboxItem[]> {
    return this.enqueue(async () => inboxFromStore(await this.read()));
  }

  find(ritualId: string): Promise<ApprovedRitualRevision | null> {
    return this.enqueue(async () => {
      return (
        (await this.read()).rituals.findLast(
          (ritual) => ritual.ritualId === ritualId,
        ) ?? null
      );
    });
  }

  save(candidate: ApprovedRitualRevision): Promise<void> {
    return this.enqueue(async () => {
      const ritual = approvedRitualRevisionSchema.parse(candidate);
      const current = await this.read();
      const stored = current.rituals.find(
        (entry) =>
          entry.ritualId === ritual.ritualId &&
          entry.ritualRevision === ritual.ritualRevision,
      );
      if (stored && JSON.stringify(stored) === JSON.stringify(ritual)) return;
      if (stored) throw new Error("RITUAL_CONFLICT");
      const latest = current.rituals.findLast(
        (entry) => entry.ritualId === ritual.ritualId,
      );
      if (latest && ritual.ritualRevision !== latest.ritualRevision + 1) {
        throw new Error("STALE_RITUAL_REVISION");
      }
      assertLearningLineage(current, ritual, latest);
      assertRestoreLineage(current, ritual, latest);
      if (current.rituals.length >= 100) throw new Error("RITUAL_STORE_FULL");
      const restoredSchedule = ritual.restoredFromRevision
        ? current.schedules.find(
            (schedule) =>
              schedule.ritualId === ritual.ritualId &&
              schedule.ritualRevision === latest?.ritualRevision,
          )
        : undefined;
      await this.write({
        ...current,
        rituals: [...current.rituals, ritual],
        schedules: current.schedules.map((schedule) => {
          if (schedule === restoredSchedule) {
            return ritualScheduleSchema.parse({
              ...schedule,
              ritualRevision: ritual.ritualRevision,
              state: "PAUSED",
              pendingOccurrence: null,
              updatedAt: ritual.approvedAt,
            });
          }
          return schedule.ritualId === ritual.ritualId &&
            schedule.ritualRevision !== ritual.ritualRevision &&
            schedule.state === "ENABLED"
            ? ritualScheduleSchema.parse({
                ...schedule,
                state: "PAUSED",
                pendingOccurrence: null,
                updatedAt: ritual.approvedAt,
              })
            : schedule;
        }),
      });
    });
  }

  saveReceipt(candidate: RitualTestReceipt): Promise<void> {
    return this.enqueue(async () => {
      const receipt = ritualTestReceiptSchema.parse(candidate);
      const current = await this.read();
      const ritual = current.rituals.find(
        (entry) =>
          entry.ritualId === receipt.ritualId &&
          entry.ritualRevision === receipt.ritualRevision,
      );
      if (!ritual || ritual.ritualRevision !== receipt.ritualRevision) {
        throw new Error("STALE_RITUAL_TEST_RUN");
      }
      const storedReceipt = findLearningReceipt(current, receipt.receiptId);
      if (storedReceipt?.mode === "RUN") {
        throw new Error("RITUAL_RECEIPT_CONFLICT");
      }
      const stored = storedReceipt?.mode === "TEST" ? storedReceipt : null;
      if (stored && JSON.stringify(stored) === JSON.stringify(receipt)) return;
      if (stored) throw new Error("RITUAL_RECEIPT_CONFLICT");
      if (current.receipts.length >= 100) {
        throw new Error("RITUAL_RECEIPT_STORE_FULL");
      }
      await this.write({
        ...current,
        receipts: [...current.receipts, receipt],
      });
    });
  }

  findLearningProposal(
    proposalId: string,
  ): Promise<RitualLearningProposal | null> {
    return this.enqueue(async () => {
      return (
        (await this.read()).learningProposals.find(
          (proposal) => proposal.proposalId === proposalId,
        ) ?? null
      );
    });
  }

  findReceipt(receiptId: string): Promise<RitualLearningReceipt | null> {
    return this.enqueue(async () => {
      const store = await this.read();
      return findLearningReceipt(store, receiptId);
    });
  }

  latestReceiptFor(
    ritualId: string,
    ritualRevision: number,
  ): Promise<RitualLearningReceipt | null> {
    return this.enqueue(async () =>
      findLatestLearningReceipt(await this.read(), ritualId, ritualRevision),
    );
  }

  saveLearningProposal(candidate: RitualLearningProposal): Promise<void> {
    return this.enqueue(async () => {
      const proposal = ritualLearningProposalSchema.parse(candidate);
      const current = await this.read();
      const ritual = current.rituals.find(
        (entry) =>
          entry.ritualId === proposal.ritualId &&
          entry.ritualRevision === proposal.fromRevision,
      );
      const receipt = findLearningReceipt(current, proposal.receiptId);
      if (
        !ritual ||
        !receipt ||
        receipt.ritualId !== ritual.ritualId ||
        receipt.ritualRevision !== ritual.ritualRevision
      ) {
        throw new Error("STALE_RITUAL_LEARNING_PROPOSAL");
      }
      const stored = current.learningProposals.find(
        (entry) => entry.proposalId === proposal.proposalId,
      );
      if (stored && JSON.stringify(stored) === JSON.stringify(proposal)) return;
      if (stored) throw new Error("RITUAL_LEARNING_PROPOSAL_CONFLICT");
      if (current.learningProposals.length >= 100) {
        throw new Error("RITUAL_LEARNING_PROPOSAL_STORE_FULL");
      }
      await this.write({
        ...current,
        learningProposals: [...current.learningProposals, proposal],
      });
    });
  }

  decideLearning(candidate: RitualLearningDecisionRequest): Promise<void> {
    return this.enqueue(async () => {
      const request = ritualLearningDecisionRequestSchema.parse(candidate);
      const current = await this.read();
      const proposal = current.learningProposals.find(
        (entry) => entry.proposalId === request.proposalId,
      );
      const latest = current.rituals.findLast(
        (entry) => entry.ritualId === request.ritualId,
      );
      const latestProposal = current.learningProposals.findLast(
        (entry) =>
          entry.ritualId === request.ritualId &&
          entry.fromRevision === request.expectedFromRevision,
      );
      if (
        !proposal ||
        latestProposal?.proposalId !== proposal.proposalId ||
        proposal.ritualId !== request.ritualId ||
        proposal.fromRevision !== request.expectedFromRevision ||
        latest?.ritualRevision !== request.expectedFromRevision
      ) {
        throw new Error("STALE_RITUAL_LEARNING_DECISION");
      }
      const decision = ritualLearningDecisionSchema.parse({
        schemaVersion: 1,
        proposalId: proposal.proposalId,
        ritualId: proposal.ritualId,
        fromRevision: proposal.fromRevision,
        decision: request.decision,
        decidedAt: this.dependencies.now?.() ?? new Date().toISOString(),
      });
      const stored = current.learningDecisions.find(
        (entry) => entry.proposalId === decision.proposalId,
      );
      if (
        stored &&
        stored.ritualId === decision.ritualId &&
        stored.fromRevision === decision.fromRevision &&
        stored.decision === decision.decision
      ) {
        return;
      }
      if (stored) throw new Error("RITUAL_LEARNING_DECISION_CONFLICT");
      if (current.learningDecisions.length >= 100) {
        throw new Error("RITUAL_LEARNING_DECISION_STORE_FULL");
      }
      await this.write({
        ...current,
        learningDecisions: [...current.learningDecisions, decision],
      });
    });
  }

  findRunWithApprovedRevision(runId: string): Promise<{
    run: RitualRun;
    approved: ApprovedRitualRevision;
  } | null> {
    return this.enqueue(async () => {
      const store = await this.read();
      const run = store.runs.find((entry) => entry.runId === runId);
      if (!run) return null;
      const approved = store.rituals.find(
        (entry) =>
          entry.ritualId === run.ritualId &&
          entry.ritualRevision === run.ritualRevision,
      );
      return approved ? { run, approved } : null;
    });
  }

  findNonterminalRun(
    ritualId: string,
    ritualRevision: number,
  ): Promise<RitualRun | null> {
    return this.enqueue(async () => {
      return (
        (await this.read()).runs.findLast(
          (run) =>
            run.ritualId === ritualId &&
            run.ritualRevision === ritualRevision &&
            !isTerminalRun(run),
        ) ?? null
      );
    });
  }

  saveRun(candidate: RitualRun): Promise<void> {
    return this.enqueue(async () => {
      const run = ritualRunSchema.parse(candidate);
      if (run.status === "COMPLETED" || run.status === "NEEDS_REVIEW") {
        throw new Error("RITUAL_RUN_ATOMIC_COMPLETION_REQUIRED");
      }
      const current = await this.read();
      const ritual = current.rituals.find(
        (entry) =>
          entry.ritualId === run.ritualId &&
          entry.ritualRevision === run.ritualRevision,
      );
      if (!ritual) throw new Error("STALE_RITUAL_RUN");
      const index = current.runs.findIndex(
        (entry) => entry.runId === run.runId,
      );
      const stored = current.runs[index];
      if (stored && JSON.stringify(stored) === JSON.stringify(run)) return;
      if (stored) {
        assertRunSuccessor(stored, run);
        const runs = [...current.runs];
        runs[index] = run;
        await this.write({ ...current, runs });
        return;
      }
      const retained = evictTerminalRunsForNewRun(current);
      if (!retained) throw new Error("RITUAL_RUN_STORE_FULL");
      await this.write({
        ...current,
        runs: [...retained.runs, run],
        runReceipts: retained.runReceipts,
      });
    });
  }

  completeRun(
    candidateRun: RitualRun,
    candidateReceipt: RitualRunReceipt,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this.enqueue(async () => {
      throwIfRunCanceled(options.signal);
      const run = ritualRunSchema.parse(candidateRun);
      const receipt = ritualRunReceiptSchema.parse(candidateReceipt);
      validateRitualRunReceipt(run, receipt);
      const current = await this.read();
      const ritual = current.rituals.find(
        (entry) =>
          entry.ritualId === run.ritualId &&
          entry.ritualRevision === run.ritualRevision,
      );
      const runIndex = current.runs.findIndex(
        (entry) => entry.runId === run.runId,
      );
      const storedRun = current.runs[runIndex];
      if (!ritual || !storedRun) {
        throw new Error("STALE_RITUAL_RUN_RECEIPT");
      }
      const storedReceipt = findLearningReceipt(current, receipt.receiptId);
      if (storedReceipt?.mode === "TEST") {
        throw new Error("RITUAL_RECEIPT_CONFLICT");
      }
      const stored = storedReceipt?.mode === "RUN" ? storedReceipt : null;
      const storedForRun = current.runReceipts.find(
        (entry) => entry.runId === run.runId,
      );
      if (
        JSON.stringify(storedRun) === JSON.stringify(run) &&
        stored &&
        JSON.stringify(stored) === JSON.stringify(receipt)
      ) {
        return;
      }
      if (storedForRun) throw new Error("RITUAL_RUN_RECEIPT_CONFLICT");
      assertRunSuccessor(storedRun, run);
      if (stored) throw new Error("RITUAL_RUN_RECEIPT_CONFLICT");
      if (current.runReceipts.length >= 100) {
        throw new Error("RITUAL_RUN_RECEIPT_STORE_FULL");
      }
      throwIfRunCanceled(options.signal);
      const runs = [...current.runs];
      runs[runIndex] = run;
      await this.write(
        {
          ...current,
          runs,
          runReceipts: [...current.runReceipts, receipt],
        },
        run.runId,
        options.signal,
      );
    });
  }

  private async read(): Promise<RitualStore> {
    try {
      const metadata = await lstat(this.path);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        metadata.size > 1_048_576 ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
      ) {
        throw new Error("RITUAL_STORE_CORRUPT");
      }
      const raw = JSON.parse(await readFile(this.path, "utf8"));
      const current = ritualStoreSchema.safeParse(raw);
      if (current.success) return current.data;
      const versionFive = ritualStoreV5Schema.safeParse(raw);
      if (versionFive.success) {
        return {
          ...versionFive.data,
          schemaVersion: 6,
          learningDecisions: [],
        };
      }
      const versionFour = ritualStoreV4Schema.safeParse(raw);
      if (versionFour.success) {
        return {
          ...versionFour.data,
          schemaVersion: 6,
          schedules: [],
          learningDecisions: [],
        };
      }
      const versionThree = ritualStoreV3Schema.safeParse(raw);
      if (versionThree.success) {
        return {
          ...versionThree.data,
          schemaVersion: 6,
          runs: [],
          runReceipts: [],
          schedules: [],
          learningDecisions: [],
        };
      }
      const versionTwo = ritualStoreV2Schema.safeParse(raw);
      if (versionTwo.success) {
        return {
          schemaVersion: 6,
          rituals: versionTwo.data.rituals,
          receipts: versionTwo.data.receipts,
          learningProposals: [],
          runs: [],
          runReceipts: [],
          schedules: [],
          learningDecisions: [],
        };
      }
      const legacy = approvedRitualStoreSchema.safeParse(raw);
      if (!legacy.success) throw new Error("RITUAL_STORE_CORRUPT");
      return {
        schemaVersion: 6,
        rituals: legacy.data.rituals,
        receipts: [],
        learningProposals: [],
        runs: [],
        runReceipts: [],
        schedules: [],
        learningDecisions: [],
      };
    } catch (error) {
      if (error instanceof Error && error.message === "RITUAL_STORE_CORRUPT") {
        throw error;
      }
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return {
          schemaVersion: 6,
          rituals: [],
          receipts: [],
          learningProposals: [],
          runs: [],
          runReceipts: [],
          schedules: [],
          learningDecisions: [],
        };
      }
      throw new Error("RITUAL_STORE_CORRUPT", { cause: error });
    }
  }

  private async write(
    store: RitualStore,
    protectedRunId?: RitualRun["runId"],
    signal?: AbortSignal,
  ): Promise<void> {
    const retained = retainStoreWithinByteBudget(
      ritualStoreSchema.parse(store),
      protectedRunId,
    );
    if (this.dependencies.write) {
      // An injected writer is the atomic commit point. Cancellation after the
      // call begins observes the terminal result it commits.
      throwIfRunCanceled(signal);
      await this.dependencies.write(retained);
      return;
    }
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = await lstat(directory);
    if (
      directoryMetadata.isSymbolicLink() ||
      !directoryMetadata.isDirectory()
    ) {
      throw new Error("RITUAL_STORE_UNSAFE_PATH");
    }
    if (process.platform !== "win32") await chmod(directory, 0o700);
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(retained), {
        mode: 0o600,
        flag: "wx",
      });
      if (process.platform !== "win32") await chmod(temporary, 0o600);
      // rename is the filesystem commit point. Before it begins cancellation
      // wins and the catch path removes the uncommitted temporary file.
      throwIfRunCanceled(signal);
      await rename(temporary, this.path);
      if (process.platform !== "win32") await chmod(this.path, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function throwIfRunCanceled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("RITUAL_RUN_CANCELED");
}

function retainStoreWithinByteBudget(
  store: RitualStore,
  explicitlyProtectedRunId?: RitualRun["runId"],
): RitualStore {
  let retained = store;
  const lineageProtectedRunIds = learningLineageRunIds(store);
  while (
    Buffer.byteLength(JSON.stringify(retained), "utf8") >
    MAX_PERSISTED_STORE_BYTES
  ) {
    const currentApproved = retained.rituals.at(-1);
    const latestApprovedRunId = currentApproved
      ? retained.runs.findLast(
          (run) =>
            run.ritualId === currentApproved.ritualId &&
            run.ritualRevision === currentApproved.ritualRevision,
        )?.runId
      : undefined;
    const index = retained.runs.findIndex(
      (run) =>
        isTerminalRun(run) &&
        run.runId !== explicitlyProtectedRunId &&
        run.runId !== latestApprovedRunId &&
        !lineageProtectedRunIds.has(run.runId),
    );
    if (index < 0) throw new Error("RITUAL_STORE_FULL");
    const runs = [...retained.runs];
    const [evicted] = runs.splice(index, 1);
    retained = {
      ...retained,
      runs,
      runReceipts: retained.runReceipts.filter(
        (receipt) => receipt.runId !== evicted!.runId,
      ),
    };
  }
  return retained;
}

function isTerminalRun(run: RitualRun): boolean {
  return ["COMPLETED", "NEEDS_REVIEW", "FAILED", "CANCELED"].includes(
    run.status,
  );
}

function evictTerminalRunsForNewRun(store: RitualStore): {
  runs: RitualRun[];
  runReceipts: RitualRunReceipt[];
} | null {
  let runs = [...store.runs];
  let runReceipts = [...store.runReceipts];
  const currentApproved = store.rituals.at(-1);
  const lineageProtectedRunIds = learningLineageRunIds(store);
  const protectedRunId = currentApproved
    ? runs.findLast(
        (run) =>
          run.ritualId === currentApproved.ritualId &&
          run.ritualRevision === currentApproved.ritualRevision,
      )?.runId
    : undefined;

  while (runs.length >= 100) {
    const index = runs.findIndex(
      (run) =>
        isTerminalRun(run) &&
        run.runId !== protectedRunId &&
        !lineageProtectedRunIds.has(run.runId),
    );
    if (index < 0) return null;
    const [evicted] = runs.splice(index, 1);
    runReceipts = runReceipts.filter(
      (receipt) => receipt.runId !== evicted!.runId,
    );
  }
  return { runs, runReceipts };
}

function learningLineageRunIds(store: RitualStore): ReadonlySet<string> {
  const protectedReceiptIds = new Set([
    ...store.learningProposals.map((proposal) => proposal.receiptId),
    ...store.rituals.flatMap((ritual) =>
      ritual.basedOnReceiptId ? [ritual.basedOnReceiptId] : [],
    ),
  ]);
  return new Set(
    store.runReceipts
      .filter((receipt) => protectedReceiptIds.has(receipt.receiptId))
      .map((receipt) => receipt.runId),
  );
}

function assertLearningLineage(
  store: RitualStore,
  ritual: ApprovedRitualRevision,
  prior: ApprovedRitualRevision | undefined,
): void {
  if (!ritual.learningProposalId || !ritual.basedOnReceiptId) return;
  const proposal = store.learningProposals.find(
    (entry) => entry.proposalId === ritual.learningProposalId,
  );
  const receipt = findLearningReceipt(store, ritual.basedOnReceiptId);
  if (
    !prior ||
    !proposal ||
    store.learningDecisions.some(
      (decision) => decision.proposalId === ritual.learningProposalId,
    ) ||
    proposal.receiptId !== ritual.basedOnReceiptId ||
    proposal.ritualId !== prior.ritualId ||
    proposal.fromRevision !== prior.ritualRevision ||
    receipt?.ritualId !== prior.ritualId ||
    receipt.ritualRevision !== prior.ritualRevision
  ) {
    throw new Error("STALE_RITUAL_LEARNING_REVISION");
  }
}

function assertRestoreLineage(
  store: RitualStore,
  ritual: ApprovedRitualRevision,
  prior: ApprovedRitualRevision | undefined,
): void {
  if (ritual.restoredFromRevision === undefined) return;
  const source = store.rituals.find(
    (entry) =>
      entry.ritualId === ritual.ritualId &&
      entry.ritualRevision === ritual.restoredFromRevision,
  );
  if (
    !prior ||
    !source ||
    prior.ritualRevision + 1 !== ritual.ritualRevision ||
    JSON.stringify(ritualDefinitionOf(source)) ===
      JSON.stringify(ritualDefinitionOf(prior)) ||
    JSON.stringify(ritualDefinitionOf(source)) !==
      JSON.stringify(ritualDefinitionOf(ritual))
  ) {
    throw new Error("STALE_RITUAL_RESTORE_REVISION");
  }
}

function assertRunSuccessor(stored: RitualRun, candidate: RitualRun): void {
  if (
    ["COMPLETED", "NEEDS_REVIEW", "FAILED", "CANCELED"].includes(
      stored.status,
    ) ||
    candidate.revision !== stored.revision + 1 ||
    candidate.createdAt !== stored.createdAt ||
    candidate.ritualId !== stored.ritualId ||
    candidate.ritualRevision !== stored.ritualRevision ||
    candidate.executionProvider !== stored.executionProvider ||
    JSON.stringify(candidate.permissions) !==
      JSON.stringify(stored.permissions) ||
    JSON.stringify(
      candidate.steps.map(({ stepKey, title, actor, approval }) => ({
        stepKey,
        title,
        actor,
        approval,
      })),
    ) !==
      JSON.stringify(
        stored.steps.map(({ stepKey, title, actor, approval }) => ({
          stepKey,
          title,
          actor,
          approval,
        })),
      )
  ) {
    throw new Error("RITUAL_RUN_CONFLICT");
  }
}
