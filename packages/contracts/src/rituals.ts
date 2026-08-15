import { z } from "zod";
import { instantSchema, ritualDraftIdSchema, ritualIdSchema } from "./ids.js";

const shortLabelSchema = z.string().trim().min(1).max(80);
const sentenceSchema = z.string().trim().min(1).max(320);

export const ritualTriggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ON_DEMAND"),
    summary: shortLabelSchema,
  }),
  z.strictObject({
    kind: z.literal("SCHEDULED"),
    summary: shortLabelSchema,
  }),
  z.strictObject({
    kind: z.literal("EVENT"),
    summary: shortLabelSchema,
  }),
]);

export const ritualActorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("STEWARD"), role: shortLabelSchema }),
  z.strictObject({ kind: z.literal("VILLAGER"), role: shortLabelSchema }),
]);

export const ritualStepSchema = z.strictObject({
  stepKey: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/),
  title: shortLabelSchema,
  description: sentenceSchema,
  actor: ritualActorSchema,
  approval: z.enum(["NONE", "OWNER_REQUIRED"]),
});

export const ritualReviewPolicySchema = z.strictObject({
  ownerReview: z.enum(["EVERY_RUN", "EXCEPTIONS_ONLY"]),
  learning: z.enum(["PROPOSE_ONLY", "OFF"]),
});

const ritualDefinition = {
  name: shortLabelSchema,
  purpose: sentenceSchema,
  trigger: ritualTriggerSchema,
  steps: z.array(ritualStepSchema).min(1).max(12),
  permissions: z.array(shortLabelSchema).max(12),
  completion: sentenceSchema,
  reviewPolicy: ritualReviewPolicySchema,
};

export const ritualDraftSchema = z.strictObject({
  schemaVersion: z.literal(1),
  draftId: ritualDraftIdSchema,
  revision: z.number().int().positive(),
  status: z.literal("DRAFT"),
  ...ritualDefinition,
  updatedAt: instantSchema,
});

export const ritualApprovalRequestSchema = z.strictObject({
  draftId: ritualDraftIdSchema,
  expectedRevision: z.number().int().positive(),
  ritualId: ritualIdSchema,
  approvedAt: instantSchema,
});

export const approvedRitualRevisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ritualId: ritualIdSchema,
  ritualRevision: z.literal(1),
  status: z.literal("APPROVED"),
  approvedDraftRevision: z.number().int().positive(),
  ...ritualDefinition,
  approvedAt: instantSchema,
});

export type RitualDraft = z.infer<typeof ritualDraftSchema>;
export type RitualApprovalRequest = z.infer<typeof ritualApprovalRequestSchema>;
export type ApprovedRitualRevision = z.infer<
  typeof approvedRitualRevisionSchema
>;

export function approveRitualDraft(
  draftCandidate: RitualDraft,
  requestCandidate: RitualApprovalRequest,
): ApprovedRitualRevision {
  const draft = ritualDraftSchema.parse(draftCandidate);
  const request = ritualApprovalRequestSchema.parse(requestCandidate);
  if (draft.draftId !== request.draftId) {
    throw new Error("RITUAL_DRAFT_ID_MISMATCH");
  }
  if (draft.revision !== request.expectedRevision) {
    throw new Error("STALE_RITUAL_DRAFT");
  }
  return approvedRitualRevisionSchema.parse({
    schemaVersion: 1,
    ritualId: request.ritualId,
    ritualRevision: 1,
    status: "APPROVED",
    approvedDraftRevision: draft.revision,
    name: draft.name,
    purpose: draft.purpose,
    trigger: draft.trigger,
    steps: draft.steps,
    permissions: draft.permissions,
    completion: draft.completion,
    reviewPolicy: draft.reviewPolicy,
    approvedAt: request.approvedAt,
  });
}
