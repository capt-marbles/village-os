import { z } from "zod";
import {
  instantSchema,
  receiptIdSchema,
  ritualDraftIdSchema,
  ritualIdSchema,
  ritualLearningProposalIdSchema,
  ritualRunIdSchema,
} from "./ids.js";
import {
  webResearchRequestSchema,
  webResearchSuccessSchema,
  webResearchWaitingReasonSchema,
} from "./research.js";

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

export const ritualResearchSchema = z.strictObject({
  provider: z.literal("EXA"),
  query: webResearchRequestSchema.shape.query,
  maxResults: webResearchRequestSchema.shape.maxResults.max(5),
  lookbackDays: z.number().int().min(1).max(30),
  includeDomains: webResearchRequestSchema.shape.includeDomains
    .unwrap()
    .min(1)
    .optional(),
});

export const ritualStarterSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("LAST_30_DAYS"),
    topic: webResearchRequestSchema.shape.query.max(160),
  }),
]);

const ritualResearchEvidenceSourceSchema = z.strictObject({
  title: webResearchSuccessSchema.shape.sources.element.shape.title.max(160),
  url: webResearchSuccessSchema.shape.sources.element.shape.url,
  publishedAt: webResearchSuccessSchema.shape.sources.element.shape.publishedAt,
  author: webResearchSuccessSchema.shape.sources.element.shape.author
    .unwrap()
    .max(100)
    .nullable(),
  highlights: z
    .array(
      webResearchSuccessSchema.shape.sources.element.shape.highlights.element.max(
        500,
      ),
    )
    .max(1),
  taint: z.literal("UNTRUSTED_WEB"),
});

export const ritualResearchEvidenceSchema = z.strictObject({
  provider: z.literal("EXA"),
  requestId: webResearchSuccessSchema.shape.requestId,
  sources: z.array(ritualResearchEvidenceSourceSchema).max(5),
});

const ritualDefinition = {
  name: shortLabelSchema,
  purpose: sentenceSchema,
  trigger: ritualTriggerSchema,
  steps: z.array(ritualStepSchema).min(1).max(12),
  permissions: z.array(shortLabelSchema).max(12),
  completion: sentenceSchema,
  reviewPolicy: ritualReviewPolicySchema,
  research: ritualResearchSchema.optional(),
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

export const ritualRunRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ritualId: ritualIdSchema,
  ritualRevision: z.number().int().positive(),
});

export const ritualRunStepApprovalRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: ritualRunIdSchema,
  stepKey: ritualStepSchema.shape.stepKey,
});

export const ritualRunCancelRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: ritualRunIdSchema,
});

export const ritualRunStepStateSchema = z.strictObject({
  stepKey: ritualStepSchema.shape.stepKey,
  title: ritualStepSchema.shape.title,
  actor: ritualActorSchema,
  approval: ritualStepSchema.shape.approval,
  status: z.enum([
    "PENDING",
    "WAITING_FOR_OWNER",
    "RUNNING",
    "WAITING_FOR_RESOURCE",
    "COMPLETED",
    "FAILED",
    "CANCELED",
  ]),
  startedAt: instantSchema.nullable(),
  approvedAt: instantSchema.nullable(),
  completedAt: instantSchema.nullable(),
  research: ritualResearchEvidenceSchema.nullable().optional(),
});

export const ritualRunSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    runId: ritualRunIdSchema,
    revision: z.number().int().positive(),
    ritualId: ritualIdSchema,
    ritualRevision: z.number().int().positive(),
    executionProvider: z.enum(["DETERMINISTIC_FIXTURE", "LOCAL_RITUAL_V1"]),
    status: z.enum([
      "QUEUED",
      "RUNNING",
      "WAITING_FOR_OWNER",
      "WAITING_FOR_RESOURCE",
      "COMPLETED",
      "NEEDS_REVIEW",
      "FAILED",
      "CANCELED",
    ]),
    currentStepKey: ritualStepSchema.shape.stepKey.nullable(),
    steps: z.array(ritualRunStepStateSchema).min(1).max(12),
    permissions: z.array(shortLabelSchema).max(12),
    externalEffects: z.tuple([]),
    failureCode: z
      .enum(["EXECUTOR_FAILED", "INTERRUPTED", "POLICY_DENIED"])
      .nullable(),
    waitingReason: webResearchWaitingReasonSchema.nullable().optional(),
    createdAt: instantSchema,
    startedAt: instantSchema.nullable(),
    updatedAt: instantSchema,
    completedAt: instantSchema.nullable(),
  })
  .superRefine((run, context) => {
    if (
      new Set(run.steps.map((step) => step.stepKey)).size !== run.steps.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Run step keys must be unique",
      });
    }
    const terminal = [
      "COMPLETED",
      "NEEDS_REVIEW",
      "FAILED",
      "CANCELED",
    ].includes(run.status);
    if (terminal !== Boolean(run.completedAt)) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Only terminal Runs have a completion time",
      });
    }
    if (run.status === "QUEUED" && run.startedAt !== null) {
      context.addIssue({
        code: "custom",
        path: ["startedAt"],
        message: "Queued Runs have not started",
      });
    }
    if (
      run.status !== "QUEUED" &&
      run.startedAt === null &&
      run.status !== "CANCELED"
    ) {
      context.addIssue({
        code: "custom",
        path: ["startedAt"],
        message: "Started Runs require a start time",
      });
    }
    const active = run.steps.filter((step) =>
      ["WAITING_FOR_OWNER", "WAITING_FOR_RESOURCE", "RUNNING"].includes(
        step.status,
      ),
    );
    if (
      active.length > 1 ||
      (active[0]?.stepKey ?? null) !== run.currentStepKey
    ) {
      context.addIssue({
        code: "custom",
        path: ["currentStepKey"],
        message: "Current step must identify the only active step",
      });
    }
    if ((run.status === "RUNNING") !== (active[0]?.status === "RUNNING")) {
      if (!(run.status === "RUNNING" && active.length === 0)) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Run and step state must agree",
        });
      }
    }
    if (
      (run.status === "WAITING_FOR_OWNER") !==
      (active[0]?.status === "WAITING_FOR_OWNER")
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Owner gate and step state must agree",
      });
    }
    if (
      (run.status === "WAITING_FOR_RESOURCE") !==
      (active[0]?.status === "WAITING_FOR_RESOURCE")
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Resource wait and step state must agree",
      });
    }
    if (
      (run.status === "WAITING_FOR_RESOURCE") !==
      Boolean(run.waitingReason)
    ) {
      context.addIssue({
        code: "custom",
        path: ["waitingReason"],
        message: "Only resource waits carry a reason",
      });
    }
    if (
      (run.status === "COMPLETED" || run.status === "NEEDS_REVIEW") &&
      (run.currentStepKey !== null ||
        run.steps.some((step) => step.status !== "COMPLETED"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Successful terminal Runs complete every step",
      });
    }
    if ((run.status === "FAILED") !== Boolean(run.failureCode)) {
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "Only failed Runs carry a failure code",
      });
    }
  });

export const ritualRunReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  receiptId: receiptIdSchema,
  runId: ritualRunIdSchema,
  ritualId: ritualIdSchema,
  ritualRevision: z.number().int().positive(),
  mode: z.literal("RUN"),
  executionProvider: ritualRunSchema.shape.executionProvider,
  outcome: z.enum(["COMPLETED", "NEEDS_REVIEW"]),
  summary: z.string().trim().min(1).max(2_000),
  stepEvidence: z
    .array(
      z.strictObject({
        stepKey: ritualStepSchema.shape.stepKey,
        title: ritualStepSchema.shape.title,
        actor: ritualActorSchema,
        research: ritualResearchEvidenceSchema.nullable().optional(),
      }),
    )
    .min(1)
    .max(12),
  uncertainties: z.array(sentenceSchema).max(8),
  externalEffects: z.tuple([]),
  startedAt: instantSchema,
  recordedAt: instantSchema,
});

export const ritualRunControllerResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("run"), run: ritualRunSchema }),
  z.strictObject({
    status: z.literal("receipt"),
    run: ritualRunSchema,
    receipt: ritualRunReceiptSchema,
  }),
]);

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

const ritualLocalTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

const ritualTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/);

export const ritualScheduleOccurrenceSchema = z.strictObject({
  runId: ritualRunIdSchema,
  dueAt: instantSchema,
});

export const ritualScheduleSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ritualId: ritualIdSchema,
  ritualRevision: z.number().int().positive(),
  state: z.enum(["ENABLED", "PAUSED"]),
  cadence: z.enum(["DAILY", "WEEKDAYS"]),
  localTime: ritualLocalTimeSchema,
  timeZone: ritualTimeZoneSchema,
  nextRunAt: instantSchema,
  pendingOccurrence: ritualScheduleOccurrenceSchema.nullable(),
  lastTriggeredAt: instantSchema.nullable(),
  updatedAt: instantSchema,
});

export const ritualScheduleUpdateRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ritualId: ritualIdSchema,
  ritualRevision: z.number().int().positive(),
  cadence: ritualScheduleSchema.shape.cadence,
  localTime: ritualLocalTimeSchema,
  timeZone: ritualTimeZoneSchema,
});

export const ritualSchedulePauseRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ritualId: ritualIdSchema,
  ritualRevision: z.number().int().positive(),
});

export const ritualScheduledRunRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ritualId: ritualIdSchema,
  ritualRevision: z.number().int().positive(),
  runId: ritualRunIdSchema,
  dueAt: instantSchema,
});

export const ritualInboxItemSchema = z.strictObject({
  run: ritualRunSchema,
  receipt: ritualRunReceiptSchema.nullable(),
  attention: z
    .enum(["OWNER_APPROVAL", "RESOURCE", "REVIEW", "FAILURE"])
    .nullable(),
});

export const ritualInboxSchema = z.array(ritualInboxItemSchema).max(20);

export const ritualStoreV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  rituals: z.array(approvedRitualRevisionSchema).max(100),
  receipts: z.array(ritualTestReceiptSchema).max(100),
});

export const ritualStoreV3Schema = z.strictObject({
  schemaVersion: z.literal(3),
  rituals: z.array(approvedRitualRevisionSchema).max(100),
  receipts: z.array(ritualTestReceiptSchema).max(100),
  learningProposals: z.array(ritualLearningProposalSchema).max(100),
});

export const ritualStoreV4Schema = z.strictObject({
  schemaVersion: z.literal(4),
  rituals: z.array(approvedRitualRevisionSchema).max(100),
  receipts: z.array(ritualTestReceiptSchema).max(100),
  learningProposals: z.array(ritualLearningProposalSchema).max(100),
  runs: z.array(ritualRunSchema).max(100),
  runReceipts: z.array(ritualRunReceiptSchema).max(100),
});

export const ritualStoreSchema = z.strictObject({
  schemaVersion: z.literal(5),
  rituals: z.array(approvedRitualRevisionSchema).max(100),
  receipts: z.array(ritualTestReceiptSchema).max(100),
  learningProposals: z.array(ritualLearningProposalSchema).max(100),
  runs: z.array(ritualRunSchema).max(100),
  runReceipts: z.array(ritualRunReceiptSchema).max(100),
  schedules: z.array(ritualScheduleSchema).max(100),
});

export const ritualStewardContextSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    draftId: ritualDraftIdSchema,
    requestRevision: z.number().int().positive(),
    ownerPurpose: sentenceSchema,
    starter: ritualStarterSchema.optional(),
    clarifications: z
      .array(
        z.strictObject({
          questionId: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
          answer: sentenceSchema,
        }),
      )
      .max(4)
      .optional(),
  })
  .superRefine((context, refinement) => {
    const questionIds =
      context.clarifications?.map((answer) => answer.questionId) ?? [];
    if (new Set(questionIds).size !== questionIds.length) {
      refinement.addIssue({
        code: "custom",
        path: ["clarifications"],
        message: "clarification question ids must be unique",
      });
    }
  });

const ritualStewardProposalFields = {
  stewardMessage: sentenceSchema,
  name: ritualDefinition.name,
  purpose: ritualDefinition.purpose,
  steps: ritualDefinition.steps,
  permissions: ritualDefinition.permissions,
  completion: ritualDefinition.completion,
  research: ritualDefinition.research,
};

export const ritualStewardProposalContentSchema = z.strictObject({
  ...ritualStewardProposalFields,
  steps: ritualDefinition.steps.max(6),
});

export const ritualStewardProposalContentJsonSchema = z.toJSONSchema(
  ritualStewardProposalContentSchema,
);

const ritualStewardOptionSchema = z.strictObject({
  optionId: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
  label: shortLabelSchema,
  detail: z.string().trim().min(1).max(160),
});

export const ritualStewardQuestionContentSchema = z
  .strictObject({
    stewardMessage: sentenceSchema,
    questionId: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
    prompt: sentenceSchema,
    options: z.array(ritualStewardOptionSchema).min(2).max(4),
    allowFreeText: z.literal(true),
  })
  .superRefine((question, context) => {
    const optionIds = question.options.map((option) => option.optionId);
    if (new Set(optionIds).size !== optionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "clarification option ids must be unique",
      });
    }
    const optionLabels = question.options.map((option) =>
      option.label.normalize("NFKC").toLocaleLowerCase("en-US"),
    );
    if (new Set(optionLabels).size !== optionLabels.length) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "clarification option labels must be unique",
      });
    }
  });

export const ritualStewardTurnContentJsonSchema = z.toJSONSchema(
  z.union([
    ritualStewardProposalContentSchema,
    ritualStewardQuestionContentSchema,
  ]),
);

export const ritualStewardProposalSchema = z.strictObject({
  status: z.literal("proposal"),
  draftId: ritualDraftIdSchema,
  requestRevision: z.number().int().positive(),
  ...ritualStewardProposalContentSchema.shape,
});

export const ritualStewardQuestionSchema =
  ritualStewardQuestionContentSchema.safeExtend({
    status: z.literal("question"),
    draftId: ritualDraftIdSchema,
    requestRevision: z.number().int().positive(),
  });

export const ritualStewardResultSchema = z.discriminatedUnion("status", [
  ritualStewardProposalSchema,
  ritualStewardQuestionSchema,
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
export type RitualStewardQuestion = z.infer<typeof ritualStewardQuestionSchema>;
export type RitualStewardResult = z.infer<typeof ritualStewardResultSchema>;
export type RitualResearch = z.infer<typeof ritualResearchSchema>;
export type RitualStarter = z.infer<typeof ritualStarterSchema>;
export type RitualResearchEvidence = z.infer<
  typeof ritualResearchEvidenceSchema
>;
export type RitualTestRunRequest = z.infer<typeof ritualTestRunRequestSchema>;
export type RitualTestRunProviderContext = z.infer<
  typeof ritualTestRunProviderContextSchema
>;
export type RitualTestRunResult = z.infer<typeof ritualTestRunResultSchema>;
export type RitualTestReceipt = z.infer<typeof ritualTestReceiptSchema>;
export type RitualTestRunControllerResult = z.infer<
  typeof ritualTestRunControllerResultSchema
>;
export type RitualRunRequest = z.infer<typeof ritualRunRequestSchema>;
export type RitualRunStepApprovalRequest = z.infer<
  typeof ritualRunStepApprovalRequestSchema
>;
export type RitualRunCancelRequest = z.infer<
  typeof ritualRunCancelRequestSchema
>;
export type RitualRunStepState = z.infer<typeof ritualRunStepStateSchema>;
export type RitualRun = z.infer<typeof ritualRunSchema>;
export type RitualRunReceipt = z.infer<typeof ritualRunReceiptSchema>;
export type RitualRunControllerResult = z.infer<
  typeof ritualRunControllerResultSchema
>;
export type RitualScheduleOccurrence = z.infer<
  typeof ritualScheduleOccurrenceSchema
>;
export type RitualSchedule = z.infer<typeof ritualScheduleSchema>;
export type RitualScheduleUpdateRequest = z.infer<
  typeof ritualScheduleUpdateRequestSchema
>;
export type RitualSchedulePauseRequest = z.infer<
  typeof ritualSchedulePauseRequestSchema
>;
export type RitualScheduledRunRequest = z.infer<
  typeof ritualScheduledRunRequestSchema
>;
export type RitualInboxItem = z.infer<typeof ritualInboxItemSchema>;
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
  if (
    result.data.status === "proposal" &&
    context.starter &&
    !matchesStarterResearch(
      result.data.research,
      researchForRitualStarter(context.starter),
    )
  ) {
    return {
      status: "waiting",
      draftId: context.draftId,
      requestRevision: context.requestRevision,
      reason: "MALFORMED_PROVIDER_OUTPUT",
    };
  }
  if (result.data.status === "question") {
    const questionId = result.data.questionId;
    const repeated = context.clarifications?.some(
      (clarification) => clarification.questionId === questionId,
    );
    if (
      context.starter ||
      (context.clarifications?.length ?? 0) >= 4 ||
      repeated
    ) {
      return {
        status: "waiting",
        draftId: context.draftId,
        requestRevision: context.requestRevision,
        reason: "MALFORMED_PROVIDER_OUTPUT",
      };
    }
  }
  return result.data;
}

export function researchForRitualStarter(
  starterCandidate: unknown,
): RitualResearch {
  const starter = ritualStarterSchema.parse(starterCandidate);
  switch (starter.kind) {
    case "LAST_30_DAYS":
      return ritualResearchSchema.parse({
        provider: "EXA",
        query: starter.topic,
        maxResults: 5,
        lookbackDays: 30,
      });
  }
}

export function purposeForRitualStarter(starterCandidate: unknown): string {
  const starter = ritualStarterSchema.parse(starterCandidate);
  switch (starter.kind) {
    case "LAST_30_DAYS":
      return `Prepare a grounded brief on the most important public-web developments about ${starter.topic} from the last 30 days.`;
  }
}

function matchesStarterResearch(
  candidate: RitualResearch | undefined,
  expected: RitualResearch,
): boolean {
  return (
    candidate?.provider === expected.provider &&
    candidate.query === expected.query &&
    candidate.maxResults === expected.maxResults &&
    candidate.lookbackDays === expected.lookbackDays &&
    candidate.includeDomains === undefined
  );
}

export function createRitualRun(input: {
  approved: ApprovedRitualRevision;
  request: RitualRunRequest;
  runId: z.infer<typeof ritualRunIdSchema>;
  createdAt: string;
}): RitualRun {
  const approved = approvedRitualRevisionSchema.parse(input.approved);
  const request = ritualRunRequestSchema.parse(input.request);
  if (
    request.ritualId !== approved.ritualId ||
    request.ritualRevision !== approved.ritualRevision
  ) {
    throw new Error("STALE_RITUAL_RUN");
  }
  return ritualRunSchema.parse({
    schemaVersion: 1,
    runId: input.runId,
    revision: 1,
    ritualId: approved.ritualId,
    ritualRevision: approved.ritualRevision,
    executionProvider: "LOCAL_RITUAL_V1",
    status: "QUEUED",
    currentStepKey: null,
    steps: approved.steps.map((step) => ({
      stepKey: step.stepKey,
      title: step.title,
      actor: step.actor,
      approval: step.approval,
      status: "PENDING",
      startedAt: null,
      approvedAt: null,
      completedAt: null,
      research: null,
    })),
    permissions: approved.permissions,
    externalEffects: [],
    failureCode: null,
    waitingReason: null,
    createdAt: input.createdAt,
    startedAt: null,
    updatedAt: input.createdAt,
    completedAt: null,
  });
}

export type RitualRunEvent =
  | { type: "START"; occurredAt: string }
  | { type: "APPROVE_STEP"; stepKey: string; occurredAt: string }
  | {
      type: "COMPLETE_STEP";
      stepKey: string;
      research?: z.infer<typeof ritualResearchEvidenceSchema>;
      occurredAt: string;
    }
  | {
      type: "WAIT_FOR_RESOURCE";
      reason: z.infer<typeof webResearchWaitingReasonSchema>;
      occurredAt: string;
    }
  | { type: "RETRY_RESOURCE"; occurredAt: string }
  | {
      type: "COMPLETE_RUN";
      outcome: "COMPLETED" | "NEEDS_REVIEW";
      occurredAt: string;
    }
  | {
      type: "FAIL";
      failureCode: "EXECUTOR_FAILED" | "INTERRUPTED" | "POLICY_DENIED";
      occurredAt: string;
    }
  | { type: "CANCEL"; occurredAt: string };

export function reduceRitualRun(
  currentCandidate: unknown,
  approvedCandidate: unknown,
  event: RitualRunEvent,
): RitualRun {
  const current = ritualRunSchema.parse(currentCandidate);
  const approved = approvedRitualRevisionSchema.parse(approvedCandidate);
  assertRunDefinition(current, approved);
  instantSchema.parse(event.occurredAt);

  if (event.type === "START") {
    if (current.status !== "QUEUED") return illegalRunTransition();
    const steps = activateStep(current.steps, 0, event.occurredAt);
    const active = steps[0]!;
    return parseRun({
      ...current,
      revision: current.revision + 1,
      status:
        active.status === "WAITING_FOR_OWNER" ? "WAITING_FOR_OWNER" : "RUNNING",
      currentStepKey: active.stepKey,
      steps,
      startedAt: event.occurredAt,
      updatedAt: event.occurredAt,
    });
  }

  if (event.type === "APPROVE_STEP") {
    const index = current.steps.findIndex(
      (step) =>
        step.stepKey === event.stepKey && step.status === "WAITING_FOR_OWNER",
    );
    if (
      current.status !== "WAITING_FOR_OWNER" ||
      current.currentStepKey !== event.stepKey ||
      index < 0
    ) {
      return illegalRunTransition();
    }
    const steps = current.steps.map((step, stepIndex) =>
      stepIndex === index
        ? {
            ...step,
            status: "RUNNING" as const,
            approvedAt: event.occurredAt,
            startedAt: event.occurredAt,
          }
        : step,
    );
    return parseRun({
      ...current,
      revision: current.revision + 1,
      status: "RUNNING",
      steps,
      updatedAt: event.occurredAt,
    });
  }

  if (event.type === "WAIT_FOR_RESOURCE") {
    const index = current.steps.findIndex(
      (step) =>
        step.stepKey === current.currentStepKey && step.status === "RUNNING",
    );
    if (current.status !== "RUNNING" || index < 0) {
      return illegalRunTransition();
    }
    const steps = current.steps.map((step, stepIndex) =>
      stepIndex === index
        ? { ...step, status: "WAITING_FOR_RESOURCE" as const }
        : step,
    );
    return parseRun({
      ...current,
      revision: current.revision + 1,
      status: "WAITING_FOR_RESOURCE",
      steps,
      waitingReason: event.reason,
      updatedAt: event.occurredAt,
    });
  }

  if (event.type === "RETRY_RESOURCE") {
    const index = current.steps.findIndex(
      (step) =>
        step.stepKey === current.currentStepKey &&
        step.status === "WAITING_FOR_RESOURCE",
    );
    if (current.status !== "WAITING_FOR_RESOURCE" || index < 0) {
      return illegalRunTransition();
    }
    const steps = current.steps.map((step, stepIndex) =>
      stepIndex === index ? { ...step, status: "RUNNING" as const } : step,
    );
    return parseRun({
      ...current,
      revision: current.revision + 1,
      status: "RUNNING",
      steps,
      waitingReason: null,
      updatedAt: event.occurredAt,
    });
  }

  if (event.type === "COMPLETE_STEP") {
    const index = current.steps.findIndex(
      (step) => step.stepKey === event.stepKey && step.status === "RUNNING",
    );
    if (
      current.status !== "RUNNING" ||
      current.currentStepKey !== event.stepKey ||
      index < 0
    ) {
      return illegalRunTransition();
    }
    const completed = current.steps.map((step, stepIndex) =>
      stepIndex === index
        ? {
            ...step,
            status: "COMPLETED" as const,
            completedAt: event.occurredAt,
            research: event.research ?? step.research ?? null,
          }
        : step,
    );
    const nextIndex = index + 1;
    if (nextIndex >= completed.length) {
      return parseRun({
        ...current,
        revision: current.revision + 1,
        steps: completed,
        currentStepKey: null,
        updatedAt: event.occurredAt,
      });
    }
    const steps = activateStep(completed, nextIndex, event.occurredAt);
    const active = steps[nextIndex]!;
    return parseRun({
      ...current,
      revision: current.revision + 1,
      status:
        active.status === "WAITING_FOR_OWNER" ? "WAITING_FOR_OWNER" : "RUNNING",
      currentStepKey: active.stepKey,
      steps,
      updatedAt: event.occurredAt,
    });
  }

  if (event.type === "COMPLETE_RUN") {
    if (
      current.status !== "RUNNING" ||
      current.currentStepKey !== null ||
      current.steps.some((step) => step.status !== "COMPLETED")
    ) {
      return illegalRunTransition();
    }
    return parseRun({
      ...current,
      revision: current.revision + 1,
      status: event.outcome,
      updatedAt: event.occurredAt,
      completedAt: event.occurredAt,
    });
  }

  if (event.type === "FAIL") {
    if (!canStopRun(current.status)) return illegalRunTransition();
    return parseRun({
      ...current,
      revision: current.revision + 1,
      status: "FAILED",
      currentStepKey: null,
      steps: stopOpenSteps(current.steps, "FAILED", event.occurredAt),
      failureCode: event.failureCode,
      waitingReason: null,
      startedAt: current.startedAt ?? event.occurredAt,
      updatedAt: event.occurredAt,
      completedAt: event.occurredAt,
    });
  }

  if (!canStopRun(current.status)) return illegalRunTransition();
  return parseRun({
    ...current,
    revision: current.revision + 1,
    status: "CANCELED",
    currentStepKey: null,
    steps: stopOpenSteps(current.steps, "CANCELED", event.occurredAt),
    waitingReason: null,
    updatedAt: event.occurredAt,
    completedAt: event.occurredAt,
  });
}

export function createRitualRunReceipt(input: {
  approved: ApprovedRitualRevision;
  run: RitualRun;
  receiptId: z.infer<typeof receiptIdSchema>;
  summary: string;
  recordedAt: string;
}): RitualRunReceipt {
  const approved = approvedRitualRevisionSchema.parse(input.approved);
  const run = ritualRunSchema.parse(input.run);
  assertRunDefinition(run, approved);
  if (
    (run.status !== "COMPLETED" && run.status !== "NEEDS_REVIEW") ||
    !run.startedAt
  ) {
    throw new Error("RITUAL_RUN_INCOMPLETE");
  }
  return validateRitualRunReceipt(run, {
    schemaVersion: 1,
    receiptId: input.receiptId,
    runId: run.runId,
    ritualId: run.ritualId,
    ritualRevision: run.ritualRevision,
    mode: "RUN",
    executionProvider: run.executionProvider,
    outcome: run.status,
    summary: input.summary,
    stepEvidence: run.steps.map((step) => ({
      stepKey: step.stepKey,
      title: step.title,
      actor: step.actor,
      research: step.research ?? null,
    })),
    uncertainties: run.steps.some((step) => step.research)
      ? ["Web evidence is untrusted source material and requires owner review."]
      : [
          "No external provider was invoked; this Receipt proves orchestration only.",
        ],
    externalEffects: [],
    startedAt: run.startedAt,
    recordedAt: input.recordedAt,
  });
}

export function validateRitualRunReceipt(
  runCandidate: unknown,
  receiptCandidate: unknown,
): RitualRunReceipt {
  const run = ritualRunSchema.parse(runCandidate);
  const receipt = ritualRunReceiptSchema.parse(receiptCandidate);
  if (
    (run.status !== "COMPLETED" && run.status !== "NEEDS_REVIEW") ||
    receipt.runId !== run.runId ||
    receipt.ritualId !== run.ritualId ||
    receipt.ritualRevision !== run.ritualRevision ||
    receipt.executionProvider !== run.executionProvider ||
    receipt.outcome !== run.status ||
    receipt.stepEvidence.length !== run.steps.length ||
    receipt.stepEvidence.some((evidence, index) => {
      const step = run.steps[index];
      return (
        !step ||
        evidence.stepKey !== step.stepKey ||
        evidence.title !== step.title ||
        evidence.actor.kind !== step.actor.kind ||
        evidence.actor.role !== step.actor.role ||
        JSON.stringify(evidence.research ?? null) !==
          JSON.stringify(step.research ?? null)
      );
    })
  ) {
    throw new Error("RITUAL_RUN_RECEIPT_MISMATCH");
  }
  return receipt;
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
    ...(draft.research ? { research: draft.research } : {}),
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
    (result.data.proposedDefinition.permissions.some(
      (permission) => !context.ritual.permissions.includes(permission),
    ) ||
      !isResearchNoBroader(
        context.ritual.research,
        result.data.proposedDefinition.research,
      ))
  ) {
    return learningWaiting(context, "MALFORMED_PROVIDER_OUTPUT");
  }
  return result.data;
}

function isResearchNoBroader(
  current: RitualResearch | undefined,
  proposed: RitualResearch | undefined,
): boolean {
  if (!current) return !proposed;
  if (!proposed) return true;
  if (
    proposed.provider !== current.provider ||
    proposed.query !== current.query ||
    proposed.maxResults > current.maxResults ||
    proposed.lookbackDays > current.lookbackDays
  ) {
    return false;
  }
  if (!current.includeDomains) return true;
  return Boolean(
    proposed.includeDomains?.every((domain) =>
      current.includeDomains?.includes(domain),
    ),
  );
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

function assertRunDefinition(
  run: RitualRun,
  approved: ApprovedRitualRevision,
): void {
  if (
    run.ritualId !== approved.ritualId ||
    run.ritualRevision !== approved.ritualRevision ||
    JSON.stringify(run.permissions) !== JSON.stringify(approved.permissions) ||
    run.steps.length !== approved.steps.length ||
    run.steps.some((step, index) => {
      const definition = approved.steps[index];
      return (
        !definition ||
        step.stepKey !== definition.stepKey ||
        step.title !== definition.title ||
        step.approval !== definition.approval ||
        JSON.stringify(step.actor) !== JSON.stringify(definition.actor)
      );
    })
  ) {
    throw new Error("STALE_RITUAL_RUN");
  }
}

function activateStep(
  steps: readonly RitualRunStepState[],
  index: number,
  occurredAt: string,
): RitualRunStepState[] {
  return steps.map((step, stepIndex) => {
    if (stepIndex !== index) return step;
    if (step.status !== "PENDING") return illegalRunTransition();
    return step.approval === "OWNER_REQUIRED"
      ? { ...step, status: "WAITING_FOR_OWNER" }
      : { ...step, status: "RUNNING", startedAt: occurredAt };
  });
}

function canStopRun(status: RitualRun["status"]): boolean {
  return [
    "QUEUED",
    "RUNNING",
    "WAITING_FOR_OWNER",
    "WAITING_FOR_RESOURCE",
  ].includes(status);
}

function stopOpenSteps(
  steps: readonly RitualRunStepState[],
  activeStatus: "FAILED" | "CANCELED",
  occurredAt: string,
): RitualRunStepState[] {
  return steps.map((step) => {
    if (step.status === "COMPLETED") return step;
    const status =
      activeStatus === "FAILED" &&
      (step.status === "RUNNING" ||
        step.status === "WAITING_FOR_OWNER" ||
        step.status === "WAITING_FOR_RESOURCE")
        ? "FAILED"
        : "CANCELED";
    return { ...step, status, completedAt: occurredAt };
  });
}

function parseRun(candidate: unknown): RitualRun {
  return ritualRunSchema.parse(candidate);
}

function illegalRunTransition(): never {
  throw new Error("ILLEGAL_RITUAL_RUN_TRANSITION");
}
