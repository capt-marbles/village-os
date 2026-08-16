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
  ritualRunReceiptSchema,
  ritualRunSchema,
  ritualStoreSchema,
  ritualStoreV2Schema,
  ritualStoreV3Schema,
  ritualTestReceiptSchema,
  validateRitualRunReceipt,
  type ApprovedRitualRevision,
  type RitualStore,
  type RitualLearningProposal,
  type RitualRun,
  type RitualRunReceipt,
  type RitualTestReceipt,
} from "@village/contracts";

export class RitualRepository {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly dependencies: {
      write?(store: RitualStore): Promise<void>;
    } = {},
  ) {}

  list(): Promise<readonly ApprovedRitualRevision[]> {
    return this.enqueue(async () => (await this.read()).rituals);
  }

  latestSnapshot(): Promise<{
    approved: ApprovedRitualRevision | null;
    receipt: RitualTestReceipt | null;
    run: RitualRun | null;
    runReceipt: RitualRunReceipt | null;
  }> {
    return this.enqueue(async () => {
      const store = await this.read();
      const approved = store.rituals.at(-1) ?? null;
      const receipt = approved
        ? (store.receipts.findLast(
            (entry) =>
              entry.ritualId === approved.ritualId &&
              entry.ritualRevision === approved.ritualRevision,
          ) ?? null)
        : null;
      const run = approved
        ? (store.runs.findLast(
            (entry) =>
              entry.ritualId === approved.ritualId &&
              entry.ritualRevision === approved.ritualRevision,
          ) ?? null)
        : null;
      const runReceipt = run
        ? (store.runReceipts.findLast((entry) => entry.runId === run.runId) ??
          null)
        : null;
      return { approved, receipt, run, runReceipt };
    });
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
      if (current.rituals.length >= 100) throw new Error("RITUAL_STORE_FULL");
      await this.write({
        ...current,
        rituals: [...current.rituals, ritual],
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
      const stored = current.receipts.find(
        (entry) => entry.receiptId === receipt.receiptId,
      );
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

  findReceipt(receiptId: string): Promise<RitualTestReceipt | null> {
    return this.enqueue(async () => {
      return (
        (await this.read()).receipts.find(
          (receipt) => receipt.receiptId === receiptId,
        ) ?? null
      );
    });
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
      const receipt = current.receipts.find(
        (entry) => entry.receiptId === proposal.receiptId,
      );
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
  ): Promise<void> {
    return this.enqueue(async () => {
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
      const stored = current.runReceipts.find(
        (entry) => entry.receiptId === receipt.receiptId,
      );
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
      const runs = [...current.runs];
      runs[runIndex] = run;
      await this.write({
        ...current,
        runs,
        runReceipts: [...current.runReceipts, receipt],
      });
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
      const versionThree = ritualStoreV3Schema.safeParse(raw);
      if (versionThree.success) {
        return {
          ...versionThree.data,
          schemaVersion: 4,
          runs: [],
          runReceipts: [],
        };
      }
      const versionTwo = ritualStoreV2Schema.safeParse(raw);
      if (versionTwo.success) {
        return {
          schemaVersion: 4,
          rituals: versionTwo.data.rituals,
          receipts: versionTwo.data.receipts,
          learningProposals: [],
          runs: [],
          runReceipts: [],
        };
      }
      const legacy = approvedRitualStoreSchema.safeParse(raw);
      if (!legacy.success) throw new Error("RITUAL_STORE_CORRUPT");
      return {
        schemaVersion: 4,
        rituals: legacy.data.rituals,
        receipts: [],
        learningProposals: [],
        runs: [],
        runReceipts: [],
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
          schemaVersion: 4,
          rituals: [],
          receipts: [],
          learningProposals: [],
          runs: [],
          runReceipts: [],
        };
      }
      throw new Error("RITUAL_STORE_CORRUPT", { cause: error });
    }
  }

  private async write(store: RitualStore): Promise<void> {
    if (this.dependencies.write) {
      await this.dependencies.write(ritualStoreSchema.parse(store));
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
      await writeFile(
        temporary,
        JSON.stringify(ritualStoreSchema.parse(store)),
        {
          mode: 0o600,
          flag: "wx",
        },
      );
      if (process.platform !== "win32") await chmod(temporary, 0o600);
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
  const protectedRunId = currentApproved
    ? runs.findLast(
        (run) =>
          run.ritualId === currentApproved.ritualId &&
          run.ritualRevision === currentApproved.ritualRevision,
      )?.runId
    : undefined;

  while (runs.length >= 100) {
    const index = runs.findIndex(
      (run) => isTerminalRun(run) && run.runId !== protectedRunId,
    );
    if (index < 0) return null;
    const [evicted] = runs.splice(index, 1);
    runReceipts = runReceipts.filter(
      (receipt) => receipt.runId !== evicted!.runId,
    );
  }
  return { runs, runReceipts };
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
