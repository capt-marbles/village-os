import { chmod, lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("RitualRepository", () => {
  it("atomically saves and restores an approved Ritual with private permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-rituals-"));
    const path = join(directory, "rituals.json");
    const repository = new RitualRepository(path);

    await repository.save(approved);

    expect(await repository.list()).toEqual([approved]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: 1,
      rituals: [approved],
    });
    if (process.platform !== "win32") {
      expect((await lstat(path)).mode & 0o077).toBe(0);
      expect((await lstat(directory)).mode & 0o077).toBe(0);
    }
  });

  it("replaces the same Ritual idempotently and fails closed on corrupt state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-rituals-"));
    const path = join(directory, "rituals.json");
    const repository = new RitualRepository(path);
    await repository.save(approved);
    await repository.save(approved);
    expect(await repository.list()).toHaveLength(1);

    await writeFile(path, '{"schemaVersion":1,"rituals":[{"bad":true}]}');
    if (process.platform !== "win32") await chmod(path, 0o600);
    await expect(repository.list()).rejects.toThrow("RITUAL_STORE_CORRUPT");
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
    expect(await repository.latest()).toEqual(second);
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
