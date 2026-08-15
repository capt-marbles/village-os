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
  ritualStoreSchema,
  ritualStoreV2Schema,
  ritualTestReceiptSchema,
  type ApprovedRitualRevision,
  type RitualStore,
  type RitualLearningProposal,
  type RitualTestReceipt,
} from "@village/contracts";

export class RitualRepository {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  list(): Promise<readonly ApprovedRitualRevision[]> {
    return this.enqueue(async () => (await this.read()).rituals);
  }

  latestSnapshot(): Promise<{
    approved: ApprovedRitualRevision | null;
    receipt: RitualTestReceipt | null;
  }> {
    return this.enqueue(async () => {
      const store = await this.read();
      const approved = store.rituals.at(-1) ?? null;
      return {
        approved,
        receipt: approved
          ? (store.receipts.findLast(
              (receipt) =>
                receipt.ritualId === approved.ritualId &&
                receipt.ritualRevision === approved.ritualRevision,
            ) ?? null)
          : null,
      };
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
      const versionTwo = ritualStoreV2Schema.safeParse(raw);
      if (versionTwo.success) {
        return {
          schemaVersion: 3,
          rituals: versionTwo.data.rituals,
          receipts: versionTwo.data.receipts,
          learningProposals: [],
        };
      }
      const legacy = approvedRitualStoreSchema.safeParse(raw);
      if (!legacy.success) throw new Error("RITUAL_STORE_CORRUPT");
      return {
        schemaVersion: 3,
        rituals: legacy.data.rituals,
        receipts: [],
        learningProposals: [],
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
          schemaVersion: 3,
          rituals: [],
          receipts: [],
          learningProposals: [],
        };
      }
      throw new Error("RITUAL_STORE_CORRUPT", { cause: error });
    }
  }

  private async write(store: RitualStore): Promise<void> {
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
