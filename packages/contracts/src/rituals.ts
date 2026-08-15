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
  schemaVersion: z.literal(1),
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
  approvedDraftId: ritualDraftIdSchema,
  approvedDraftRevision: z.number().int().positive(),
  ...ritualDefinition,
  approvedAt: instantSchema,
});

export const approvedRitualStoreSchema = z.strictObject({
  schemaVersion: z.literal(1),
  rituals: z.array(approvedRitualRevisionSchema).max(100),
});

export const ritualStewardContextSchema = z.strictObject({
  schemaVersion: z.literal(1),
  draftId: ritualDraftIdSchema,
  requestRevision: z.number().int().positive(),
  ownerPurpose: sentenceSchema,
});

const ritualStewardProposalFields = {
  stewardMessage: sentenceSchema,
  name: ritualDefinition.name,
  purpose: ritualDefinition.purpose,
  steps: ritualDefinition.steps,
  permissions: ritualDefinition.permissions,
  completion: ritualDefinition.completion,
};

export const ritualStewardProposalContentSchema = z.strictObject({
  ...ritualStewardProposalFields,
  steps: ritualDefinition.steps.max(6),
});

export const ritualStewardProposalContentJsonSchema = z.toJSONSchema(
  ritualStewardProposalContentSchema,
);

export const ritualStewardProposalSchema = z.strictObject({
  status: z.literal("proposal"),
  draftId: ritualDraftIdSchema,
  requestRevision: z.number().int().positive(),
  ...ritualStewardProposalContentSchema.shape,
});

export const ritualStewardResultSchema = z.discriminatedUnion("status", [
  ritualStewardProposalSchema,
  z.strictObject({
    status: z.literal("waiting"),
    draftId: ritualDraftIdSchema,
    requestRevision: z.number().int().positive(),
    reason: z.enum([
      "AUTHENTICATION_REQUIRED",
      "PROVIDER_UNAVAILABLE",
      "MALFORMED_PROVIDER_OUTPUT",
      "TIME_BUDGET_EXHAUSTED",
      "STALE_STEWARD_RESULT",
    ]),
  }),
]);

export type RitualDraft = z.infer<typeof ritualDraftSchema>;
export type RitualApprovalRequest = z.infer<typeof ritualApprovalRequestSchema>;
export type ApprovedRitualRevision = z.infer<
  typeof approvedRitualRevisionSchema
>;
export type ApprovedRitualStore = z.infer<typeof approvedRitualStoreSchema>;
export type RitualStewardContext = z.infer<typeof ritualStewardContextSchema>;
export type RitualStewardProposal = z.infer<typeof ritualStewardProposalSchema>;
export type RitualStewardResult = z.infer<typeof ritualStewardResultSchema>;

export function validateRitualStewardResult(
  contextCandidate: unknown,
  resultCandidate: unknown,
): RitualStewardResult {
  const context = ritualStewardContextSchema.parse(contextCandidate);
  const result = ritualStewardResultSchema.safeParse(resultCandidate);
  if (!result.success) {
    return {
      status: "waiting",
      draftId: context.draftId,
      requestRevision: context.requestRevision,
      reason: "MALFORMED_PROVIDER_OUTPUT",
    };
  }
  if (
    result.data.draftId !== context.draftId ||
    result.data.requestRevision !== context.requestRevision
  ) {
    return {
      status: "waiting",
      draftId: context.draftId,
      requestRevision: context.requestRevision,
      reason: "STALE_STEWARD_RESULT",
    };
  }
  return result.data;
}

export type RitualApprovalErrorCode =
  "RITUAL_DRAFT_ID_MISMATCH" | "STALE_RITUAL_DRAFT";

export class RitualApprovalError extends Error {
  constructor(readonly code: RitualApprovalErrorCode) {
    super(code);
    this.name = "RitualApprovalError";
  }
}

export function approveRitualDraft(
  draftCandidate: RitualDraft,
  requestCandidate: RitualApprovalRequest,
): ApprovedRitualRevision {
  const draft = ritualDraftSchema.parse(draftCandidate);
  const request = ritualApprovalRequestSchema.parse(requestCandidate);
  if (draft.draftId !== request.draftId) {
    throw new RitualApprovalError("RITUAL_DRAFT_ID_MISMATCH");
  }
  if (draft.revision !== request.expectedRevision) {
    throw new RitualApprovalError("STALE_RITUAL_DRAFT");
  }
  return approvedRitualRevisionSchema.parse({
    schemaVersion: 1,
    ritualId: request.ritualId,
    ritualRevision: 1,
    status: "APPROVED",
    approvedDraftId: draft.draftId,
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
