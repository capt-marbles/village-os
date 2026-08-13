import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  actionIdSchema,
  actionPhaseSchema,
  browserActionSchema,
  instantSchema,
  type BrowserAction,
} from "@village/contracts";

export interface ActionJournalEntry {
  actionId: string;
  leaseEpoch: number;
  phase: BrowserAction["phase"];
  mutationClass: BrowserAction["mutationClass"];
  recordedAt: string;
}

function validateEntry(candidate: unknown): ActionJournalEntry {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("ACTION_JOURNAL_CORRUPT");
  }
  const entry = candidate as Partial<ActionJournalEntry>;
  if (
    !actionIdSchema.safeParse(entry.actionId).success ||
    !Number.isInteger(entry.leaseEpoch) ||
    (entry.leaseEpoch ?? 0) < 1 ||
    !actionPhaseSchema.safeParse(entry.phase).success ||
    !browserActionSchema.shape.mutationClass.safeParse(entry.mutationClass)
      .success ||
    !instantSchema.safeParse(entry.recordedAt).success ||
    Object.keys(entry).some(
      (key) =>
        ![
          "actionId",
          "leaseEpoch",
          "phase",
          "mutationClass",
          "recordedAt",
        ].includes(key),
    )
  ) {
    throw new Error("ACTION_JOURNAL_CORRUPT");
  }
  return entry as ActionJournalEntry;
}

export class ActionJournal {
  constructor(private readonly path: string) {}

  async read(): Promise<ActionJournalEntry[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      if (raw.length > 1_048_576) throw new Error("ACTION_JOURNAL_CORRUPT");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed) || parsed.length > 10_000) {
        throw new Error("ACTION_JOURNAL_CORRUPT");
      }
      return parsed.map(validateEntry);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      if (
        error instanceof Error &&
        error.message === "ACTION_JOURNAL_CORRUPT"
      ) {
        throw error;
      }
      throw new Error("ACTION_JOURNAL_CORRUPT");
    }
  }

  async record(entry: ActionJournalEntry): Promise<void> {
    const next = [...(await this.read()), validateEntry(entry)];
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next), {
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }
}
