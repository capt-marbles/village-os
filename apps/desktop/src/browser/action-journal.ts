import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ActionJournalEntry {
  actionId: string;
  leaseEpoch: number;
  phase:
    | "ACCEPTED"
    | "DISPATCHED"
    | "EFFECT_OBSERVED"
    | "RECEIPTED"
    | "RECONCILIATION_REQUIRED";
  mutationClass: "READ_ONLY" | "IDEMPOTENT" | "NON_IDEMPOTENT";
  recordedAt: string;
}

function validateEntry(candidate: unknown): ActionJournalEntry {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("ACTION_JOURNAL_CORRUPT");
  }
  const entry = candidate as Partial<ActionJournalEntry>;
  const phases = new Set([
    "ACCEPTED",
    "DISPATCHED",
    "EFFECT_OBSERVED",
    "RECEIPTED",
    "RECONCILIATION_REQUIRED",
  ]);
  const mutations = new Set(["READ_ONLY", "IDEMPOTENT", "NON_IDEMPOTENT"]);
  if (
    typeof entry.actionId !== "string" ||
    !/^act_[0-9A-HJKMNP-TV-Z]{26}$/.test(entry.actionId) ||
    !Number.isInteger(entry.leaseEpoch) ||
    (entry.leaseEpoch ?? 0) < 1 ||
    !phases.has(entry.phase ?? "") ||
    !mutations.has(entry.mutationClass ?? "") ||
    typeof entry.recordedAt !== "string" ||
    Number.isNaN(Date.parse(entry.recordedAt)) ||
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
