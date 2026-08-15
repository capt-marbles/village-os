import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  actionIdSchema,
  actionPhaseSchema,
  browserSessionIdSchema,
  effectIdSchema,
  instantSchema,
  jobIdSchema,
  mutationClassSchema,
  setupLogicalStepSchema,
  type BrowserAction,
} from "@village/contracts";

interface LegacyActionJournalEntry {
  actionId: string;
  leaseEpoch: number;
  phase: BrowserAction["phase"];
  mutationClass: BrowserAction["mutationClass"];
  recordedAt: string;
}

export interface WorkflowActionJournalEntry extends LegacyActionJournalEntry {
  jobId: string;
  browserSessionId: string;
  logicalStep:
    | "SET_DISPLAY_NAME"
    | "SELECT_ROLE"
    | "SET_PREFERRED_FOCUS"
    | "FINALIZE_SETUP";
  effectId: string;
  postcondition: "UNOBSERVED" | "SATISFIED" | "NOT_SATISFIED" | "UNKNOWN";
}

export type ActionJournalEntry =
  LegacyActionJournalEntry | WorkflowActionJournalEntry;

export function isWorkflowJournalEntry(
  entry: ActionJournalEntry,
): entry is WorkflowActionJournalEntry {
  return "effectId" in entry;
}

function validateEntry(candidate: unknown): ActionJournalEntry {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("ACTION_JOURNAL_CORRUPT");
  }
  const entry = candidate as Partial<WorkflowActionJournalEntry>;
  const workflowKeys = [
    "jobId",
    "browserSessionId",
    "logicalStep",
    "effectId",
    "postcondition",
  ] as const;
  const workflowFieldCount = workflowKeys.filter((key) => key in entry).length;
  const workflowEntryValid =
    workflowFieldCount === 0 ||
    (workflowFieldCount === workflowKeys.length &&
      jobIdSchema.safeParse(entry.jobId).success &&
      browserSessionIdSchema.safeParse(entry.browserSessionId).success &&
      setupLogicalStepSchema.safeParse(entry.logicalStep).success &&
      effectIdSchema.safeParse(entry.effectId).success &&
      ["UNOBSERVED", "SATISFIED", "NOT_SATISFIED", "UNKNOWN"].includes(
        entry.postcondition as string,
      ));
  if (
    !actionIdSchema.safeParse(entry.actionId).success ||
    !Number.isInteger(entry.leaseEpoch) ||
    (entry.leaseEpoch ?? 0) < 1 ||
    !actionPhaseSchema.safeParse(entry.phase).success ||
    !mutationClassSchema.safeParse(entry.mutationClass).success ||
    !instantSchema.safeParse(entry.recordedAt).success ||
    !workflowEntryValid ||
    Object.keys(entry).some(
      (key) =>
        ![
          "actionId",
          "leaseEpoch",
          "phase",
          "mutationClass",
          "recordedAt",
          ...workflowKeys,
        ].includes(key),
    )
  ) {
    throw new Error("ACTION_JOURNAL_CORRUPT");
  }
  return entry as ActionJournalEntry;
}

function validateWorkflowTransition(
  entries: readonly ActionJournalEntry[],
  next: WorkflowActionJournalEntry,
): void {
  const prior = entries.filter(
    (entry): entry is WorkflowActionJournalEntry =>
      isWorkflowJournalEntry(entry) && entry.actionId === next.actionId,
  );
  const last = prior.at(-1);
  if (
    last &&
    (last.jobId !== next.jobId ||
      last.browserSessionId !== next.browserSessionId ||
      last.logicalStep !== next.logicalStep ||
      last.effectId !== next.effectId ||
      last.leaseEpoch !== next.leaseEpoch ||
      last.mutationClass !== next.mutationClass)
  ) {
    throw new Error("ACTION_JOURNAL_BINDING_CONFLICT");
  }
  const allowed: Record<
    WorkflowActionJournalEntry["phase"],
    readonly WorkflowActionJournalEntry["phase"][]
  > = {
    ACCEPTED: ["DISPATCHED", "RECONCILIATION_REQUIRED"],
    DISPATCHED: ["EFFECT_OBSERVED", "RECONCILIATION_REQUIRED"],
    EFFECT_OBSERVED: ["RECEIPTED", "RECONCILIATION_REQUIRED"],
    RECEIPTED: [],
    RECONCILIATION_REQUIRED: ["DISPATCHED", "EFFECT_OBSERVED", "RECEIPTED"],
  };
  if (
    (!last &&
      ![
        "ACCEPTED",
        "DISPATCHED",
        "EFFECT_OBSERVED",
        "RECONCILIATION_REQUIRED",
      ].includes(next.phase)) ||
    (last && !allowed[last.phase].includes(next.phase))
  ) {
    throw new Error("ACTION_JOURNAL_PHASE_REGRESSION");
  }
  if (
    ((next.phase === "ACCEPTED" || next.phase === "DISPATCHED") &&
      next.postcondition !== "UNOBSERVED") ||
    (next.phase === "EFFECT_OBSERVED" && next.postcondition === "UNOBSERVED") ||
    (next.phase === "RECEIPTED" && next.postcondition !== "SATISFIED")
  ) {
    throw new Error("ACTION_JOURNAL_PHASE_REGRESSION");
  }
}

export class ActionJournal {
  private tail = Promise.resolve();

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
    const operation = this.tail.then(() => this.writeEntry(entry));
    this.tail = operation.catch(() => undefined);
    await operation;
  }

  private async writeEntry(entry: ActionJournalEntry): Promise<void> {
    const entries = await this.read();
    const validated = validateEntry(entry);
    if (isWorkflowJournalEntry(validated)) {
      validateWorkflowTransition(entries, validated);
    }
    const next = [...entries, validated].slice(-10_000);
    let serialized = JSON.stringify(next);
    while (Buffer.byteLength(serialized) > 1_048_576 && next.length > 1) {
      next.shift();
      serialized = JSON.stringify(next);
    }
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, serialized, {
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }
}
