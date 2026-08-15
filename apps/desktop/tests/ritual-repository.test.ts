import { chmod, lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveRitualLearningProposal } from "@village/contracts";
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

describe("RitualRepository", () => {
  it("atomically saves and restores an approved Ritual with private permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-rituals-"));
    const path = join(directory, "rituals.json");
    const repository = new RitualRepository(path);

    await repository.save(approved);

    expect(await repository.list()).toEqual([approved]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: 3,
      rituals: [approved],
      receipts: [],
      learningProposals: [],
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

    expect(await repository.latestSnapshot()).toEqual({ approved, receipt });
    const stored = await readFile(path, "utf8");
    expect(JSON.parse(stored)).toEqual({
      schemaVersion: 3,
      rituals: [approved],
      receipts: [receipt],
      learningProposals: [],
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
    expect(await repository.latestSnapshot()).toEqual({ approved, receipt });

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
