import { describe, expect, it, vi } from "vitest";
import { RitualBuilderController } from "../src/main/ritual-builder-controller.js";

const draftId = "rtd_01J00000000000000000000000";
const approved = {
  schemaVersion: 1 as const,
  ritualId: "rtl_01J00000000000000000000000",
  ritualRevision: 1 as const,
  status: "APPROVED" as const,
  approvedDraftId: draftId,
  approvedDraftRevision: 3,
  name: "Pipeline review",
  purpose: "Prepare my pipeline review.",
  trigger: { kind: "ON_DEMAND" as const, summary: "Whenever I ask" },
  steps: [
    {
      stepKey: "prepare-review",
      title: "Prepare the review",
      description: "Gather bounded records for the review.",
      actor: { kind: "STEWARD" as const, role: "Steward" },
      approval: "OWNER_REQUIRED" as const,
    },
  ],
  permissions: ["Read only connected records"],
  completion: "A reviewable result is ready.",
  reviewPolicy: {
    ownerReview: "EVERY_RUN" as const,
    learning: "PROPOSE_ONLY" as const,
  },
  approvedAt: "2026-08-15T16:03:00.000Z",
};

describe("RitualBuilderController", () => {
  it("passes a strict drafting request to the Steward and persists only approved Rituals", async () => {
    const provider = {
      draft: vi.fn(async (context) => ({
        status: "proposal" as const,
        draftId: context.draftId,
        requestRevision: context.requestRevision,
        stewardMessage: "I shaped a focused draft.",
        name: "Pipeline review",
        purpose: context.ownerPurpose,
        steps: [
          {
            stepKey: "prepare-review",
            title: "Prepare the review",
            description: "Gather bounded records for the review.",
            actor: { kind: "STEWARD" as const, role: "Steward" },
            approval: "OWNER_REQUIRED" as const,
          },
        ],
        permissions: ["Read only connected records"],
        completion: "A reviewable result is ready.",
      })),
      close: vi.fn(async () => undefined),
    };
    const repository = {
      latest: vi.fn(async () => null),
      save: vi.fn(async () => undefined),
    };
    const controller = new RitualBuilderController(provider, repository);

    await expect(
      controller.draft({
        schemaVersion: 1,
        draftId,
        requestRevision: 1,
        ownerPurpose: "Prepare my pipeline review.",
        ignored: "must be rejected",
      }),
    ).rejects.toThrow();
    const result = await controller.draft({
      schemaVersion: 1,
      draftId,
      requestRevision: 1,
      ownerPurpose: "Prepare my pipeline review.",
    });
    expect(result.status).toBe("proposal");
    expect(provider.draft).toHaveBeenCalledOnce();
    expect(repository.save).not.toHaveBeenCalled();
    await expect(controller.approve(approved)).resolves.toEqual(approved);
    expect(repository.save).toHaveBeenCalledWith(approved);
    await expect(
      controller.approve({ ...approved, extra: true }),
    ).rejects.toThrow();
    repository.latest.mockResolvedValue(approved);
    await expect(controller.loadLatest()).resolves.toEqual(approved);
    await controller.close();
    expect(provider.close).toHaveBeenCalledOnce();
  });
});
