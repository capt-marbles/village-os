import { z } from "zod";
import {
  instantSchema,
  receiptIdSchema,
  ritualDraftIdSchema,
  ritualIdSchema,
  ritualLearningProposalIdSchema,
  ritualRunIdSchema,
} from "./ids.js";

const shortLabelSchema = z.string().trim().min(1).max(80);
const sentenceSchema = z.string().trim().min(1).max(320);

export const ritualProviderWaitingReasonSchema = z.enum([
  "AUTHENTICATION_REQUIRED",
  "PROVIDER_UNAVAILABLE",
  "MALFORMED_PROVIDER_OUTPUT",
  "TIME_BUDGET_EXHAUSTED",
  "STALE_STEWARD_RESULT",
]);

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

export const approvedRitualRevisionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    ritualId: ritualIdSchema,
    ritualRevision: z.number().int().positive(),
    status: z.literal("APPROVED"),
    approvedDraftId: ritualDraftIdSchema,
    approvedDraftRevision: z.number().int().positive(),
    learningProposalId: ritualLearningProposalIdSchema.optional(),
    basedOnReceiptId: receiptIdSchema.optional(),
    ...ritualDefinition,
    approvedAt: instantSchema,
  })
  .superRefine((revision, context) => {
    const learned = revision.ritualRevision > 1;
    if (learned !== Boolean(revision.learningProposalId)) {
      context.addIssue({
        code: "custom",
        path: ["learningProposalId"],
        message: "learned revisions require proposal lineage",
      });
    }
    if (learned !== Boolean(revision.basedOnReceiptId)) {
      context.addIssue({
        code: "custom",
        path: ["basedOnReceiptId"],
        message: "learned revisions require Receipt lineage",
      });
    }
  });

export const approvedRitualStoreSchema = z.strictObject({
  schemaVersion: z.literal(1),
  rituals: z.array(approvedRitualRevisionSchema).max(100),
});

export const ritualTestRunRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ritualId: ritualIdSchema,
  ritualRevision: z.number().int().positive(),
  sample: z.string().trim().min(16).max(4_000),
});

export const ritualTestRunProviderContextSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: ritualRunIdSchema,
  ritual: approvedRitualRevisionSchema,
  sample: ritualTestRunRequestSchema.shape.sample,
});

export const ritualTestRunResultContentSchema = z.strictObject({
  summary: z.string().trim().min(1).max(2_000),
  evidence: z.array(sentenceSchema).min(1).max(8),
  uncertainties: z.array(sentenceSchema).max(8),
});

export const ritualTestRunResultContentJsonSchema = z.toJSONSchema(
  ritualTestRunResultContentSchema,
);

const ritualTestRunBinding = {
  runId: ritualRunIdSchema,
  ritualId: ritualIdSchema,
  ritualRevision: z.number().int().positive(),
};

export const ritualTestRunResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("result"),
    ...ritualTestRunBinding,
    ...ritualTestRunResultContentSchema.shape,
  }),
  z.strictObject({
    status: z.literal("waiting"),
    ...ritualTestRunBinding,
    reason: ritualProviderWaitingReasonSchema,
  }),
]);

export const ritualTestReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  receiptId: receiptIdSchema,
  runId: ritualRunIdSchema,
  ritualId: ritualIdSchema,
  ritualRevision: z.number().int().positive(),
  mode: z.literal("TEST"),
  outcome: z.enum(["COMPLETED", "NEEDS_REVIEW"]),
  summary: ritualTestRunResultContentSchema.shape.summary,
  evidence: ritualTestRunResultContentSchema.shape.evidence,
  uncertainties: ritualTestRunResultContentSchema.shape.uncertainties,
  sampleDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sampleCharacterCount: z.number().int().positive().max(4_000),
  externalEffects: z.tuple([]),
  recordedAt: instantSchema,
});

export const ritualTestRunControllerResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("receipt"),
      receipt: ritualTestReceiptSchema,
    }),
    ritualTestRunResultSchema.options[1],
  ],
);

export const ritualLearningFeedbackRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ritualId: ritualIdSchema,
  ritualRevision: z.number().int().positive(),
  receiptId: receiptIdSchema,
  feedback: z.string().trim().min(8).max(1_000),
});

export const ritualLearningContextSchema = z.strictObject({
  schemaVersion: z.literal(1),
  proposalId: ritualLearningProposalIdSchema,
  ritual: approvedRitualRevisionSchema,
  receipt: ritualTestReceiptSchema,
  ownerFeedback: ritualLearningFeedbackRequestSchema.shape.feedback,
});

export const ritualLearningProposalContentSchema = z.strictObject({
  stewardMessage: sentenceSchema,
  rationale: sentenceSchema,
  proposedDefinition: z.strictObject(ritualDefinition),
});

export const ritualLearningProposalContentJsonSchema = z.toJSONSchema(
  ritualLearningProposalContentSchema,
);

const ritualLearningBinding = {
  proposalId: ritualLearningProposalIdSchema,
  ritualId: ritualIdSchema,
  fromRevision: z.number().int().positive(),
  receiptId: receiptIdSchema,
};

export const ritualLearningProposalSchema = z.strictObject({
  status: z.literal("proposal"),
  ...ritualLearningBinding,
  ownerFeedback: ritualLearningFeedbackRequestSchema.shape.feedback,
  ...ritualLearningProposalContentSchema.shape,
});

export const ritualLearningResultSchema = z.discriminatedUnion("status", [
  ritualLearningProposalSchema,
  z.strictObject({
    status: z.literal("waiting"),
    ...ritualLearningBinding,
    reason: ritualProviderWaitingReasonSchema,
  }),
]);

export const ritualLearningApprovalRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  proposalId: ritualLearningProposalIdSchema,
  ritualId: ritualIdSchema,
  expectedFromRevision: z.number().int().positive(),
  approvedAt: instantSchema,
});

export const ritualStoreV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  rituals: z.array(approvedRitualRevisionSchema).max(100),
  receipts: z.array(ritualTestReceiptSchema).max(100),
});

export const ritualStoreSchema = z.strictObject({
  schemaVersion: z.literal(3),
  rituals: z.array(approvedRitualRevisionSchema).max(100),
  receipts: z.array(ritualTestReceiptSchema).max(100),
  learningProposals: z.array(ritualLearningProposalSchema).max(100),
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
    reason: ritualProviderWaitingReasonSchema,
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
export type RitualTestRunRequest = z.infer<typeof ritualTestRunRequestSchema>;
export type RitualTestRunProviderContext = z.infer<
  typeof ritualTestRunProviderContextSchema
>;
export type RitualTestRunResult = z.infer<typeof ritualTestRunResultSchema>;
export type RitualTestReceipt = z.infer<typeof ritualTestReceiptSchema>;
export type RitualTestRunControllerResult = z.infer<
  typeof ritualTestRunControllerResultSchema
>;
export type RitualStore = z.infer<typeof ritualStoreSchema>;
export type RitualLearningFeedbackRequest = z.infer<
  typeof ritualLearningFeedbackRequestSchema
>;
export type RitualLearningContext = z.infer<typeof ritualLearningContextSchema>;
export type RitualLearningProposal = z.infer<
  typeof ritualLearningProposalSchema
>;
export type RitualLearningResult = z.infer<typeof ritualLearningResultSchema>;
export type RitualLearningApprovalRequest = z.infer<
  typeof ritualLearningApprovalRequestSchema
>;

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

export function createRitualTestReceipt(input: {
  approved: ApprovedRitualRevision;
  request: RitualTestRunRequest;
  result: Extract<RitualTestRunResult, { status: "result" }>;
  receiptId: z.infer<typeof receiptIdSchema>;
  sampleDigest: string;
  recordedAt: string;
}): RitualTestReceipt {
  const approved = approvedRitualRevisionSchema.parse(input.approved);
  const request = ritualTestRunRequestSchema.parse(input.request);
  const result = ritualTestRunResultSchema.parse(input.result);
  if (result.status !== "result") throw new Error("RITUAL_TEST_RUN_INCOMPLETE");
  if (
    request.ritualId !== approved.ritualId ||
    request.ritualRevision !== approved.ritualRevision ||
    result.ritualId !== approved.ritualId ||
    result.ritualRevision !== approved.ritualRevision
  ) {
    throw new Error("STALE_RITUAL_TEST_RUN");
  }
  return ritualTestReceiptSchema.parse({
    schemaVersion: 1,
    receiptId: input.receiptId,
    runId: result.runId,
    ritualId: approved.ritualId,
    ritualRevision: approved.ritualRevision,
    mode: "TEST",
    outcome: result.uncertainties.length === 0 ? "COMPLETED" : "NEEDS_REVIEW",
    summary: result.summary,
    evidence: result.evidence,
    uncertainties: result.uncertainties,
    sampleDigest: input.sampleDigest,
    sampleCharacterCount: request.sample.length,
    externalEffects: [],
    recordedAt: input.recordedAt,
  });
}

export function validateRitualTestRunResult(
  contextCandidate: unknown,
  resultCandidate: unknown,
): RitualTestRunResult {
  const context = ritualTestRunProviderContextSchema.parse(contextCandidate);
  const result = ritualTestRunResultSchema.safeParse(resultCandidate);
  if (!result.success) {
    return testRunWaiting(context, "MALFORMED_PROVIDER_OUTPUT");
  }
  if (
    result.data.runId !== context.runId ||
    result.data.ritualId !== context.ritual.ritualId ||
    result.data.ritualRevision !== context.ritual.ritualRevision
  ) {
    return testRunWaiting(context, "STALE_STEWARD_RESULT");
  }
  if (
    result.data.status === "result" &&
    containsRawTestSample(context.sample, [
      result.data.summary,
      ...result.data.evidence,
      ...result.data.uncertainties,
    ])
  ) {
    return testRunWaiting(context, "MALFORMED_PROVIDER_OUTPUT");
  }
  return result.data;
}

export function validateRitualLearningResult(
  contextCandidate: unknown,
  resultCandidate: unknown,
): RitualLearningResult {
  const context = ritualLearningContextSchema.parse(contextCandidate);
  const result = ritualLearningResultSchema.safeParse(resultCandidate);
  if (!result.success) {
    return learningWaiting(context, "MALFORMED_PROVIDER_OUTPUT");
  }
  if (
    result.data.proposalId !== context.proposalId ||
    result.data.ritualId !== context.ritual.ritualId ||
    result.data.fromRevision !== context.ritual.ritualRevision ||
    result.data.receiptId !== context.receipt.receiptId
  ) {
    return learningWaiting(context, "STALE_STEWARD_RESULT");
  }
  if (
    result.data.status === "proposal" &&
    result.data.proposedDefinition.permissions.some(
      (permission) => !context.ritual.permissions.includes(permission),
    )
  ) {
    return learningWaiting(context, "MALFORMED_PROVIDER_OUTPUT");
  }
  return result.data;
}

export function approveRitualLearningProposal(
  currentCandidate: unknown,
  proposalCandidate: unknown,
  requestCandidate: unknown,
): ApprovedRitualRevision {
  const current = approvedRitualRevisionSchema.parse(currentCandidate);
  const proposal = ritualLearningProposalSchema.parse(proposalCandidate);
  const request = ritualLearningApprovalRequestSchema.parse(requestCandidate);
  if (
    request.proposalId !== proposal.proposalId ||
    request.ritualId !== current.ritualId ||
    proposal.ritualId !== current.ritualId
  ) {
    throw new Error("RITUAL_LEARNING_ID_MISMATCH");
  }
  if (
    request.expectedFromRevision !== current.ritualRevision ||
    proposal.fromRevision !== current.ritualRevision
  ) {
    throw new Error("STALE_RITUAL_LEARNING_PROPOSAL");
  }
  return approvedRitualRevisionSchema.parse({
    schemaVersion: 1,
    ritualId: current.ritualId,
    ritualRevision: current.ritualRevision + 1,
    status: "APPROVED",
    approvedDraftId: current.approvedDraftId,
    approvedDraftRevision: current.approvedDraftRevision,
    learningProposalId: proposal.proposalId,
    basedOnReceiptId: proposal.receiptId,
    ...proposal.proposedDefinition,
    approvedAt: request.approvedAt,
  });
}

function learningWaiting(
  context: RitualLearningContext,
  reason: Extract<RitualLearningResult, { status: "waiting" }>["reason"],
): RitualLearningResult {
  return {
    status: "waiting",
    proposalId: context.proposalId,
    ritualId: context.ritual.ritualId,
    fromRevision: context.ritual.ritualRevision,
    receiptId: context.receipt.receiptId,
    reason,
  };
}

function containsRawTestSample(
  sample: string,
  persistedFields: readonly string[],
): boolean {
  const normalizedSample = sample.trim().replace(/\s+/g, " ").toLowerCase();
  return persistedFields.some((field) => {
    const normalizedField = field.trim().replace(/\s+/g, " ").toLowerCase();
    return normalizedField.includes(normalizedSample);
  });
}

function testRunWaiting(
  context: RitualTestRunProviderContext,
  reason: Extract<RitualTestRunResult, { status: "waiting" }>["reason"],
): RitualTestRunResult {
  return {
    status: "waiting",
    runId: context.runId,
    ritualId: context.ritual.ritualId,
    ritualRevision: context.ritual.ritualRevision,
    reason,
  };
}
