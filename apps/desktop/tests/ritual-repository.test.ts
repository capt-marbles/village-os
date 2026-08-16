import { chmod, lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveRitualLearningProposal,
  createRitualRun,
  createRitualRunReceipt,
  reduceRitualRun,
} from "@village/contracts";
import { describe, expect, it } from "vitest";
import { RitualRepository } from "../src/main/ritual-repository.js";

const approved = {
  schemaVersion: 1 as const,
  ritualId: "rtl_01J00000000000000000000000",
  ritualRevision: 1 as const,
  status: "APPROVED" as const,
  approvedDraftId: "rtd_01J00000000000000000000000",
  approvedDraftRevision: 3,
  name: "Pipeline review",
  purpose: "Review my sales pipeline and prepare the next follow-ups.",
  trigger: { kind: "ON_DEMAND" as const, summary: "Whenever I ask" },
  steps: [
    {
      stepKey: "prepare-review",
      title: "Prepare the review",
      description: "Gather the bounded information needed for the review.",
      actor: { kind: "STEWARD" as const, role: "Steward" },
      approval: "OWNER_REQUIRED" as const,
    },
  ],
  permissions: ["Read only connected pipeline records"],
  completion: "A reviewable follow-up list is ready.",
  reviewPolicy: {
    ownerReview: "EVERY_RUN" as const,
    learning: "PROPOSE_ONLY" as const,
  },
  approvedAt: "2026-08-15T16:03:00.000Z",
};

const receipt = {
  schemaVersion: 1 as const,
  receiptId: "rcp_01J00000000000000000000000",
  runId: "rrn_01J00000000000000000000000",
  ritualId: approved.ritualId,
  ritualRevision: 1,
  mode: "TEST" as const,
  outcome: "NEEDS_REVIEW" as const,
  summary: "Customer A should receive the first response.",
  evidence: ["The supplied deadline is Friday."],
  uncertainties: ["Commercial impact was not supplied."],
  sampleDigest: "a".repeat(64),
  sampleCharacterCount: 42,
  externalEffects: [] as const,
  recordedAt: "2026-08-15T18:03:00.000Z",
};

const learningProposal = {
  status: "proposal" as const,
  proposalId: "rlp_01J00000000000000000000000",
  ritualId: approved.ritualId,
  fromRevision: 1,
  receiptId: receipt.receiptId,
  ownerFeedback: "Keep future results to three concise bullets.",
  stewardMessage: "I propose a more concise expected result.",
  rationale: "The owner asked for a shorter review.",
  proposedDefinition: {
    name: approved.name,
    purpose: approved.purpose,
    trigger: approved.trigger,
    steps: approved.steps,
    permissions: approved.permissions,
    completion: "Three concise follow-up bullets are ready for review.",
    reviewPolicy: approved.reviewPolicy,
  },
};

function runFor(runId: string) {
  return createRitualRun({
    approved,
    request: {
      schemaVersion: 1,
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
    },
    runId,
    createdAt: "2026-08-16T12:00:00.000Z",
  });
}

function terminalRunFor(runId: string) {
  let run = runFor(runId);
  run = reduceRitualRun(run, approved, {
    type: "START",
    occurredAt: "2026-08-16T12:00:01.000Z",
  });
  run = reduceRitualRun(run, approved, {
    type: "APPROVE_STEP",
    stepKey: approved.steps[0]!.stepKey,
    occurredAt: "2026-08-16T12:00:02.000Z",
  });
  run = reduceRitualRun(run, approved, {
    type: "COMPLETE_STEP",
    stepKey: approved.steps[0]!.stepKey,
    occurredAt: "2026-08-16T12:00:03.000Z",
  });
  return reduceRitualRun(run, approved, {
    type: "COMPLETE_RUN",
    outcome: "NEEDS_REVIEW",
    occurredAt: "2026-08-16T12:00:04.000Z",
  });
}

function runReceiptFor(
  run: ReturnType<typeof terminalRunFor>,
  receiptId: string,
) {
  return createRitualRunReceipt({
    approved,
    run,
    receiptId,
    summary: "The fixture completed the approved orchestration steps.",
    recordedAt: "2026-08-16T12:00:04.000Z",
  });
}

function runId(index: number): `rrn_${string}` {
  return `rrn_${String(index).padStart(26, "0")}`;
}

function receiptId(index: number): `rcp_${string}` {
  return `rcp_${String(index).padStart(26, "0")}`;
}

describe("RitualRepository", () => {
  it("atomically saves and restores an approved Ritual with private permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-rituals-"));
    const path = join(directory, "rituals.json");
    const repository = new RitualRepository(path);

    await repository.save(approved);

    expect(await repository.list()).toEqual([approved]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: 4,
      rituals: [approved],
      receipts: [],
      learningProposals: [],
      runs: [],
      runReceipts: [],
    });
    if (process.platform !== "win32") {
      expect((await lstat(path)).mode & 0o077).toBe(0);
      expect((await lstat(directory)).mode & 0o077).toBe(0);
    }
  });

  it("migrates an existing v1 store and restores only bounded Test Run Receipts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-rituals-"));
    const path = join(directory, "rituals.json");
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 1, rituals: [approved] }),
      { mode: 0o600 },
    );
    const repository = new RitualRepository(path);

    await repository.saveReceipt(receipt);

    expect(await repository.latestSnapshot()).toEqual({
      approved,
      receipt,
      run: null,
      runReceipt: null,
    });
    const stored = await readFile(path, "utf8");
    expect(JSON.parse(stored)).toEqual({
      schemaVersion: 4,
      rituals: [approved],
      receipts: [receipt],
      learningProposals: [],
      runs: [],
      runReceipts: [],
    });
    expect(stored).not.toContain("Customer A needs an answer before Friday");
  });

  it("rejects Receipts for unknown or stale Ritual revisions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-rituals-"));
    const repository = new RitualRepository(join(directory, "rituals.json"));
    await repository.save(approved);

    await expect(
      repository.saveReceipt({ ...receipt, ritualRevision: 2 }),
    ).rejects.toThrow("STALE_RITUAL_TEST_RUN");
    await expect(
      repository.saveReceipt({
        ...receipt,
        ritualId: "rtl_01J00000000000000000000001",
      }),
    ).rejects.toThrow("STALE_RITUAL_TEST_RUN");
  });

  it("replaces the same Ritual idempotently and fails closed on corrupt state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-rituals-"));
    const path = join(directory, "rituals.json");
    const repository = new RitualRepository(path);
    await repository.save(approved);
    await repository.save(approved);
    expect(await repository.list()).toHaveLength(1);
    await expect(
      repository.save({ ...approved, name: "Conflicting replacement" }),
    ).rejects.toThrow("RITUAL_CONFLICT");

    await writeFile(path, '{"schemaVersion":1,"rituals":[{"bad":true}]}');
    if (process.platform !== "win32") await chmod(path, 0o600);
    await expect(repository.list()).rejects.toThrow("RITUAL_STORE_CORRUPT");
  });

  it("saves identical Receipts idempotently and rejects conflicting ids", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-rituals-"));
    const repository = new RitualRepository(join(directory, "rituals.json"));
    await repository.save(approved);

    await repository.saveReceipt(receipt);
    await repository.saveReceipt(receipt);
    expect(await repository.latestSnapshot()).toEqual({
      approved,
      receipt,
      run: null,
      runReceipt: null,
    });

    await expect(
      repository.saveReceipt({ ...receipt, summary: "Conflicting result" }),
    ).rejects.toThrow("RITUAL_RECEIPT_CONFLICT");
  });

  it("preserves revision history and restores a Receipt-bound learning proposal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-rituals-"));
    const repository = new RitualRepository(join(directory, "rituals.json"));
    await repository.save(approved);
    await repository.saveReceipt(receipt);
    await repository.saveLearningProposal(learningProposal);

    expect(
      await repository.findLearningProposal(learningProposal.proposalId),
    ).toEqual(learningProposal);

    const revision = approveRitualLearningProposal(approved, learningProposal, {
      schemaVersion: 1,
      proposalId: learningProposal.proposalId,
      ritualId: approved.ritualId,
      expectedFromRevision: 1,
      approvedAt: "2026-08-15T18:04:00.000Z",
    });
    await repository.save(revision);

    expect(await repository.list()).toEqual([approved, revision]);
    expect(await repository.find(approved.ritualId)).toEqual(revision);
    expect(await repository.latestSnapshot()).toEqual({
      approved: revision,
      receipt: null,
      run: null,
      runReceipt: null,
    });
  });

  it("preserves earlier Rituals and restores the most recently approved one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-rituals-"));
    const repository = new RitualRepository(join(directory, "rituals.json"));
    const second = {
      ...approved,
      ritualId: "rtl_01J00000000000000000000001",
      approvedDraftId: "rtd_01J00000000000000000000001",
      name: "Inbox priorities",
      purpose: "Review my inbox and identify the replies that matter most.",
      approvedAt: "2026-08-15T17:03:00.000Z",
    };

    await repository.save(approved);
    await repository.save(second);

    expect(await repository.list()).toEqual([approved, second]);
    expect(await repository.latestSnapshot()).toEqual({
      approved: second,
      receipt: null,
      run: null,
      runReceipt: null,
    });
  });

  it("persists an active Run before effects and restores its terminal Receipt after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-rituals-"));
    const path = join(directory, "rituals.json");
    const repository = new RitualRepository(path);
    await repository.save(approved);
    let run = createRitualRun({
      approved,
      request: {
        schemaVersion: 1,
        ritualId: approved.ritualId,
        ritualRevision: approved.ritualRevision,
      },
      runId: "rrn_01J00000000000000000000001",
      createdAt: "2026-08-16T12:00:00.000Z",
    });
    await repository.saveRun(run);
    run = reduceRitualRun(run, approved, {
      type: "START",
      occurredAt: "2026-08-16T12:00:01.000Z",
    });
    await repository.saveRun(run);

    const reopened = new RitualRepository(path);
    expect(await reopened.latestSnapshot()).toMatchObject({
      approved,
      run: { status: "WAITING_FOR_OWNER", runId: run.runId },
      runReceipt: null,
    });

    run = reduceRitualRun(run, approved, {
      type: "APPROVE_STEP",
      stepKey: approved.steps[0]!.stepKey,
      occurredAt: "2026-08-16T12:00:02.000Z",
    });
    await reopened.saveRun(run);
    run = reduceRitualRun(run, approved, {
      type: "COMPLETE_STEP",
      stepKey: approved.steps[0]!.stepKey,
      occurredAt: "2026-08-16T12:00:03.000Z",
    });
    await reopened.saveRun(run);
    run = reduceRitualRun(run, approved, {
      type: "COMPLETE_RUN",
      outcome: "NEEDS_REVIEW",
      occurredAt: "2026-08-16T12:00:04.000Z",
    });
    const runReceipt = createRitualRunReceipt({
      approved,
      run,
      receiptId: "rcp_01J00000000000000000000001",
      summary: "The fixture completed the approved orchestration steps.",
      recordedAt: "2026-08-16T12:00:04.000Z",
    });
    await reopened.completeRun(run, runReceipt);
    await expect(
      reopened.completeRun(run, runReceipt),
    ).resolves.toBeUndefined();
    await expect(
      reopened.completeRun(run, {
        ...runReceipt,
        receiptId: "rcp_01J00000000000000000000002",
      }),
    ).rejects.toThrow("RITUAL_RUN_RECEIPT_CONFLICT");

    expect(await new RitualRepository(path).latestSnapshot()).toMatchObject({
      run,
      runReceipt,
    });
    await expect(
      reopened.completeRun(run, { ...runReceipt, runId: receipt.runId }),
    ).rejects.toThrow("RITUAL_RUN_RECEIPT_MISMATCH");
    await expect(
      reopened.saveRun({
        ...run,
        status: "RUNNING",
        completedAt: null,
        updatedAt: "2026-08-16T12:00:05.000Z",
      }),
    ).rejects.toThrow();
  });

  it("finds the existing active Run for its exact approved revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-rituals-"));
    const repository = new RitualRepository(join(directory, "rituals.json"));
    await repository.save(approved);
    const active = runFor("rrn_01J00000000000000000000002");
    await repository.saveRun(active);

    await expect(
      repository.findNonterminalRun(approved.ritualId, approved.ritualRevision),
    ).resolves.toEqual(active);
    await expect(
      repository.findNonterminalRun(approved.ritualId, 2),
    ).resolves.toBe(null);
  });

  it("evicts the oldest terminal Run and paired Receipt before adding another Run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-rituals-"));
    const path = join(directory, "rituals.json");
    const terminalRuns = Array.from({ length: 100 }, (_, index) =>
      terminalRunFor(runId(index)),
    );
    const terminalReceipts = terminalRuns.map((run, index) =>
      runReceiptFor(run, receiptId(index)),
    );
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 4,
        rituals: [approved],
        receipts: [],
        learningProposals: [],
        runs: terminalRuns,
        runReceipts: terminalReceipts,
      }),
      { mode: 0o600 },
    );
    const repository = new RitualRepository(path);
    const next = runFor(runId(100));

    await repository.saveRun(next);

    const stored = JSON.parse(await readFile(path, "utf8"));
    expect(stored.runs).toHaveLength(100);
    expect(stored.runReceipts).toHaveLength(99);
    expect(
      stored.runs.some((run: { runId: string }) => run.runId === runId(0)),
    ).toBe(false);
    expect(
      stored.runReceipts.some(
        (receipt: { runId: string }) => receipt.runId === runId(0),
      ),
    ).toBe(false);
    expect(
      stored.runs.some((run: { runId: string }) => run.runId === runId(99)),
    ).toBe(true);
    expect(
      stored.runs.some((run: { runId: string }) => run.runId === next.runId),
    ).toBe(true);
  });

  it("rejects another Run when every retained Run is active", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-rituals-"));
    const path = join(directory, "rituals.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 4,
        rituals: [approved],
        receipts: [],
        learningProposals: [],
        runs: Array.from({ length: 100 }, (_, index) => runFor(runId(index))),
        runReceipts: [],
      }),
      { mode: 0o600 },
    );
    const repository = new RitualRepository(path);

    await expect(repository.saveRun(runFor(runId(100)))).rejects.toThrow(
      "RITUAL_RUN_STORE_FULL",
    );
  });

  it("rejects a terminal Run and Receipt binding mismatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-rituals-"));
    const repository = new RitualRepository(join(directory, "rituals.json"));
    await repository.save(approved);
    let active = runFor("rrn_01J00000000000000000000003");
    await repository.saveRun(active);
    active = reduceRitualRun(active, approved, {
      type: "START",
      occurredAt: "2026-08-16T12:00:01.000Z",
    });
    await repository.saveRun(active);
    active = reduceRitualRun(active, approved, {
      type: "APPROVE_STEP",
      stepKey: approved.steps[0]!.stepKey,
      occurredAt: "2026-08-16T12:00:02.000Z",
    });
    await repository.saveRun(active);
    active = reduceRitualRun(active, approved, {
      type: "COMPLETE_STEP",
      stepKey: approved.steps[0]!.stepKey,
      occurredAt: "2026-08-16T12:00:03.000Z",
    });
    await repository.saveRun(active);
    const terminal = reduceRitualRun(active, approved, {
      type: "COMPLETE_RUN",
      outcome: "NEEDS_REVIEW",
      occurredAt: "2026-08-16T12:00:04.000Z",
    });

    await expect(
      repository.completeRun(terminal, {
        ...runReceiptFor(terminal, "rcp_01J00000000000000000000003"),
        ritualId: "rtl_01J00000000000000000000001",
      }),
    ).rejects.toThrow();
  });

  it("keeps the prior active Run when the atomic completion write rejects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-rituals-"));
    const path = join(directory, "rituals.json");
    const persisted = new RitualRepository(path);
    await persisted.save(approved);
    let active = runFor("rrn_01J00000000000000000000004");
    await persisted.saveRun(active);
    active = reduceRitualRun(active, approved, {
      type: "START",
      occurredAt: "2026-08-16T12:00:01.000Z",
    });
    await persisted.saveRun(active);
    active = reduceRitualRun(active, approved, {
      type: "APPROVE_STEP",
      stepKey: approved.steps[0]!.stepKey,
      occurredAt: "2026-08-16T12:00:02.000Z",
    });
    await persisted.saveRun(active);
    active = reduceRitualRun(active, approved, {
      type: "COMPLETE_STEP",
      stepKey: approved.steps[0]!.stepKey,
      occurredAt: "2026-08-16T12:00:03.000Z",
    });
    await persisted.saveRun(active);
    const terminal = reduceRitualRun(active, approved, {
      type: "COMPLETE_RUN",
      outcome: "NEEDS_REVIEW",
      occurredAt: "2026-08-16T12:00:04.000Z",
    });
    const failing = new RitualRepository(path, {
      write: async () => {
        throw new Error("DISK_FULL");
      },
    });

    await expect(
      failing.completeRun(
        terminal,
        runReceiptFor(terminal, "rcp_01J00000000000000000000004"),
      ),
    ).rejects.toThrow("DISK_FULL");
    await expect(
      new RitualRepository(path).latestSnapshot(),
    ).resolves.toMatchObject({
      run: active,
      runReceipt: null,
    });
  });

  it("rejects a distinct 101st Ritual without corrupting the store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-rituals-"));
    const repository = new RitualRepository(join(directory, "rituals.json"));
    for (let index = 0; index < 100; index += 1) {
      await repository.save({
        ...approved,
        ritualId: `rtl_${String(index).padStart(26, "0")}`,
      });
    }
    await expect(
      repository.save({ ...approved, ritualId: `rtl_${"A".repeat(26)}` }),
    ).rejects.toThrow("RITUAL_STORE_FULL");
    expect(await repository.list()).toHaveLength(100);
  });
});
