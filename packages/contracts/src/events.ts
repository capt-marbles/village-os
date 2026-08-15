import { z } from "zod";
import {
  browserSessionIdSchema,
  eventIdSchema,
  humanGateIdSchema,
  instantSchema,
  jobIdSchema,
  principalIdSchema,
  effectIdSchema,
  receiptIdSchema,
  setupObjectiveSchema,
} from "./ids.js";
import { authenticationEvidenceSchema } from "./browser.js";
import { predicateIdSchema } from "./redaction.js";
import { humanGateReasonSchema } from "./secrets.js";

const base = {
  eventId: eventIdSchema,
  principalId: principalIdSchema,
  jobId: jobIdSchema,
  sequence: z.number().int().positive(),
  occurredAt: instantSchema,
};
const emptyPayload = z.strictObject({});

export const setupCompletionEvidenceSchema = z.strictObject({
  objective: setupObjectiveSchema,
  jobId: jobIdSchema,
  browserSessionId: browserSessionIdSchema,
  jobRevision: z.number().int().positive(),
  logicalStep: z.literal("FINALIZE_SETUP"),
  effectId: effectIdSchema,
  receiptId: receiptIdSchema,
  leaseEpoch: z.number().int().positive(),
  predicateVersion: predicateIdSchema,
});

export const jobCompletionEvidenceSchema = z.union([
  authenticationEvidenceSchema,
  setupCompletionEvidenceSchema,
]);

export const jobEventSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      ...base,
      type: z.literal("JOB_CREATED"),
      payload: emptyPayload,
    }),
    z.strictObject({
      ...base,
      type: z.literal("BROWSER_HOST_UNAVAILABLE"),
      payload: emptyPayload,
    }),
    z.strictObject({
      ...base,
      type: z.literal("BROWSER_HOST_AVAILABLE"),
      payload: z.strictObject({ browserSessionId: browserSessionIdSchema }),
    }),
    z.strictObject({
      ...base,
      type: z.literal("HUMAN_GATE_RAISED"),
      payload: z.strictObject({
        humanGateId: humanGateIdSchema,
        reason: humanGateReasonSchema,
      }),
    }),
    z.strictObject({
      ...base,
      type: z.literal("USER_CONTROL_ACKNOWLEDGED"),
      payload: emptyPayload,
    }),
    z.strictObject({
      ...base,
      type: z.literal("SECRET_BROKER_ACCEPTED"),
      payload: emptyPayload,
    }),
    z.strictObject({
      ...base,
      type: z.literal("SECRET_BROKER_DECLINED"),
      payload: emptyPayload,
    }),
    z.strictObject({
      ...base,
      type: z.literal("AGENT_CONTROL_RECONCILED"),
      payload: emptyPayload,
    }),
    z.strictObject({
      ...base,
      type: z.literal("VERIFICATION_STARTED"),
      payload: emptyPayload,
    }),
    z.strictObject({
      ...base,
      type: z.literal("VERIFICATION_RECONCILED"),
      payload: emptyPayload,
    }),
    z.strictObject({
      ...base,
      type: z.literal("VERIFICATION_UNKNOWN"),
      payload: z.strictObject({ humanGateId: humanGateIdSchema }),
    }),
    z.strictObject({
      ...base,
      type: z.literal("JOB_SUCCEEDED"),
      payload: jobCompletionEvidenceSchema,
    }),
    z.strictObject({
      ...base,
      type: z.literal("JOB_FAILED"),
      payload: z.strictObject({
        code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
      }),
    }),
    z.strictObject({
      ...base,
      type: z.literal("JOB_CANCELED"),
      payload: emptyPayload,
    }),
  ])
  .superRefine((event, context) => {
    if (
      event.type === "JOB_SUCCEEDED" &&
      "objective" in event.payload &&
      event.payload.jobId !== event.jobId
    ) {
      context.addIssue({
        code: "custom",
        path: ["payload", "jobId"],
        message: "Setup completion evidence must match the event Job",
      });
    }
  });

export type JobEvent = z.infer<typeof jobEventSchema>;

export interface SetupCompletionState {
  jobId: z.infer<typeof jobIdSchema>;
  browserSessionId: z.infer<typeof browserSessionIdSchema>;
  jobRevision: number;
  logicalStep: "FINALIZE_SETUP";
  effectId: z.infer<typeof effectIdSchema>;
  leaseEpoch: number;
  receiptedEffectIds: z.infer<typeof effectIdSchema>[];
  completionReceiptIds: z.infer<typeof receiptIdSchema>[];
}

export function validateSetupCompletion(
  candidate: unknown,
  state: SetupCompletionState,
):
  | { ok: true }
  | {
      ok: false;
      code:
        | "INVALID_COMPLETION_EVIDENCE"
        | "STALE_WORKFLOW_BINDING"
        | "EFFECT_NOT_RECEIPTED"
        | "DUPLICATE_COMPLETION";
    } {
  const parsed = setupCompletionEvidenceSchema.safeParse(candidate);
  if (!parsed.success)
    return { ok: false, code: "INVALID_COMPLETION_EVIDENCE" };
  const evidence = parsed.data;
  if (
    evidence.jobId !== state.jobId ||
    evidence.browserSessionId !== state.browserSessionId ||
    evidence.jobRevision !== state.jobRevision ||
    evidence.logicalStep !== state.logicalStep ||
    evidence.effectId !== state.effectId ||
    evidence.leaseEpoch !== state.leaseEpoch
  ) {
    return { ok: false, code: "STALE_WORKFLOW_BINDING" };
  }
  if (!state.receiptedEffectIds.includes(evidence.effectId)) {
    return { ok: false, code: "EFFECT_NOT_RECEIPTED" };
  }
  if (state.completionReceiptIds.includes(evidence.receiptId)) {
    return { ok: false, code: "DUPLICATE_COMPLETION" };
  }
  return { ok: true };
}
