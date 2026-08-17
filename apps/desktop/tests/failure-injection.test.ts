import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ActionJournal,
  isWorkflowJournalEntry,
  type WorkflowActionJournalEntry,
} from "../src/browser/action-journal.js";
import { LocalActionExecutor } from "../src/browser/local-action-executor.js";

const roots: string[] = [];
const accepted: WorkflowActionJournalEntry = {
  actionId: "act_01J00000000000000000000000",
  leaseEpoch: 1,
  phase: "ACCEPTED",
  mutationClass: "NON_IDEMPOTENT",
  recordedAt: "2026-08-17T10:00:00.000Z",
  jobId: "job_01J00000000000000000000000",
  browserSessionId: "brs_01J00000000000000000000000",
  logicalStep: "FINALIZE_SETUP",
  effectId: "efx_01J00000000000000000000000",
  postcondition: "UNOBSERVED",
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function journalFixture(): Promise<{
  path: string;
  journal: ActionJournal;
}> {
  const root = await mkdtemp(join(tmpdir(), "village-failure-injection-"));
  roots.push(root);
  const path = join(root, "action-journal.json");
  return { path, journal: new ActionJournal(path) };
}

describe("desktop failure injection matrix", () => {
  it("distinguishes a crash before dispatch from a crash after dispatch", async () => {
    const fixture = await journalFixture();
    await fixture.journal.record(accepted);

    const beforeDispatch = (await new ActionJournal(fixture.path).read()).at(
      -1,
    );
    expect(beforeDispatch).toMatchObject({
      phase: "ACCEPTED",
      postcondition: "UNOBSERVED",
    });
    expect(beforeDispatch && isWorkflowJournalEntry(beforeDispatch)).toBe(true);

    await fixture.journal.record({
      ...accepted,
      phase: "DISPATCHED",
      recordedAt: "2026-08-17T10:00:01.000Z",
    });
    const afterDispatch = (await new ActionJournal(fixture.path).read()).at(-1);
    expect(afterDispatch).toMatchObject({
      phase: "DISPATCHED",
      mutationClass: "NON_IDEMPOTENT",
      postcondition: "UNOBSERVED",
    });
  });

  it("keeps automation fenced after an in-flight timeout until a newer lease is reconciled", async () => {
    let settle!: (result: "UNKNOWN") => void;
    const executor = new LocalActionExecutor({ leaseEpoch: 4 });
    const inFlight = executor.execute({
      actionId: accepted.actionId,
      leaseEpoch: 4,
      mutationClass: "NON_IDEMPOTENT",
      run: () => new Promise((resolve) => (settle = resolve)),
    });

    await expect(executor.beginOnlineTakeover(5, 0)).resolves.toEqual({
      status: "OUTCOME_UNKNOWN",
      actionId: accepted.actionId,
    });
    await expect(
      executor.execute({
        actionId: "act_01J00000000000000000000001",
        leaseEpoch: 5,
        mutationClass: "IDEMPOTENT",
        run: async () => "SATISFIED",
      }),
    ).rejects.toThrow("AUTOMATION_BLOCKED");
    settle("UNKNOWN");
    await expect(inFlight).resolves.toBe("UNKNOWN");
    expect(() => executor.reconcileAgentLease(5)).toThrow("STALE_LEASE_EPOCH");
    executor.reconcileAgentLease(6);
    await expect(
      executor.execute({
        actionId: "act_01J00000000000000000000001",
        leaseEpoch: 6,
        mutationClass: "IDEMPOTENT",
        run: async () => "SATISFIED",
      }),
    ).resolves.toBe("SATISFIED");
  });

  it("turns a corrupt restart journal into a bounded owner-recovery code", async () => {
    const fixture = await journalFixture();
    const sensitivePageText = "private-page-text-must-not-enter-the-error";
    await writeFile(fixture.path, `{not-json:${sensitivePageText}`, "utf8");

    const error = await new ActionJournal(fixture.path)
      .read()
      .catch((caught: unknown) => caught);
    expect(error).toEqual(new Error("ACTION_JOURNAL_CORRUPT"));
    expect(String(error)).not.toContain(sensitivePageText);
  });
});
