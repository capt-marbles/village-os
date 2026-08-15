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
  ritualStoreSchema,
  ritualTestReceiptSchema,
  type ApprovedRitualRevision,
  type RitualStore,
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
              (receipt) => receipt.ritualId === approved.ritualId,
            ) ?? null)
          : null,
      };
    });
  }

  find(ritualId: string): Promise<ApprovedRitualRevision | null> {
    return this.enqueue(async () => {
      return (
        (await this.read()).rituals.find(
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
        (entry) => entry.ritualId === ritual.ritualId,
      );
      if (stored && JSON.stringify(stored) === JSON.stringify(ritual)) return;
      if (stored) throw new Error("RITUAL_CONFLICT");
      const rituals = current.rituals.filter(
        (stored) => stored.ritualId !== ritual.ritualId,
      );
      if (rituals.length >= 100) throw new Error("RITUAL_STORE_FULL");
      rituals.push(ritual);
      await this.write({ ...current, rituals });
    });
  }

  saveReceipt(candidate: RitualTestReceipt): Promise<void> {
    return this.enqueue(async () => {
      const receipt = ritualTestReceiptSchema.parse(candidate);
      const current = await this.read();
      const ritual = current.rituals.find(
        (entry) => entry.ritualId === receipt.ritualId,
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
      const legacy = approvedRitualStoreSchema.safeParse(raw);
      if (!legacy.success) throw new Error("RITUAL_STORE_CORRUPT");
      return { schemaVersion: 2, rituals: legacy.data.rituals, receipts: [] };
    } catch (error) {
      if (error instanceof Error && error.message === "RITUAL_STORE_CORRUPT") {
        throw error;
      }
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { schemaVersion: 2, rituals: [], receipts: [] };
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
