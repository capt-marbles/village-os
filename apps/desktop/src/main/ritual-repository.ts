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
  type ApprovedRitualRevision,
  type ApprovedRitualStore,
} from "@village/contracts";

export class RitualRepository {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  list(): Promise<readonly ApprovedRitualRevision[]> {
    return this.enqueue(async () => (await this.read()).rituals);
  }

  latest(): Promise<ApprovedRitualRevision | null> {
    return this.enqueue(async () => (await this.read()).rituals.at(-1) ?? null);
  }

  save(candidate: ApprovedRitualRevision): Promise<void> {
    return this.enqueue(async () => {
      const ritual = approvedRitualRevisionSchema.parse(candidate);
      const current = await this.read();
      const stored = current.rituals.find(
        (entry) => entry.ritualId === ritual.ritualId,
      );
      if (stored && JSON.stringify(stored) === JSON.stringify(ritual)) return;
      const rituals = current.rituals.filter(
        (stored) => stored.ritualId !== ritual.ritualId,
      );
      if (rituals.length >= 100) throw new Error("RITUAL_STORE_FULL");
      rituals.push(ritual);
      await this.write(
        approvedRitualStoreSchema.parse({ schemaVersion: 1, rituals }),
      );
    });
  }

  private async read(): Promise<ApprovedRitualStore> {
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
      const parsed = approvedRitualStoreSchema.safeParse(
        JSON.parse(await readFile(this.path, "utf8")),
      );
      if (!parsed.success) throw new Error("RITUAL_STORE_CORRUPT");
      return parsed.data;
    } catch (error) {
      if (error instanceof Error && error.message === "RITUAL_STORE_CORRUPT") {
        throw error;
      }
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { schemaVersion: 1, rituals: [] };
      }
      throw new Error("RITUAL_STORE_CORRUPT", { cause: error });
    }
  }

  private async write(store: ApprovedRitualStore): Promise<void> {
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
      await writeFile(temporary, JSON.stringify(store), {
        mode: 0o600,
        flag: "wx",
      });
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
