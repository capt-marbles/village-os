import { z } from "zod";
import {
  actionIdSchema,
  browserStepIdSchema,
  browserSessionIdSchema,
  deviceIdSchema,
  instantSchema,
  jobIdSchema,
  principalIdSchema,
  receiptIdSchema,
} from "./ids.js";
import { predicateIdSchema } from "./redaction.js";

export const actionPhaseSchema = z.enum([
  "ACCEPTED",
  "DISPATCHED",
  "EFFECT_OBSERVED",
  "RECEIPTED",
  "RECONCILIATION_REQUIRED",
]);

export const browserActionSchema = z.strictObject({
  actionId: actionIdSchema,
  browserSessionId: browserSessionIdSchema,
  phase: actionPhaseSchema,
  mutationClass: z.enum(["READ_ONLY", "IDEMPOTENT", "NON_IDEMPOTENT"]),
  acceptedAt: instantSchema,
  updatedAt: instantSchema,
  postcondition: z.enum([
    "UNOBSERVED",
    "SATISFIED",
    "NOT_SATISFIED",
    "UNKNOWN",
  ]),
});

export const browserStepSchema = z.strictObject({
  stepId: browserStepIdSchema,
  principalId: principalIdSchema,
  deviceId: deviceIdSchema,
  jobId: jobIdSchema,
  browserSessionId: browserSessionIdSchema,
  ordinal: z.number().int().positive().max(10_000),
  capability: z.enum([
    "SESSION_OPEN",
    "NAVIGATE",
    "OBSERVE",
    "FIXTURE_INPUT",
    "REQUEST_SECRET_FILL",
    "REQUEST_HUMAN_GATE",
    "CHECKPOINT",
    "VERIFY_AUTHENTICATION",
  ]),
  state: z.enum(["PENDING", "ACTIVE", "COMPLETED", "WAITING", "FAILED"]),
  createdAt: instantSchema,
});

export const actionReceiptSchema = z.strictObject({
  receiptId: receiptIdSchema,
  principalId: principalIdSchema,
  deviceId: deviceIdSchema,
  jobId: jobIdSchema,
  browserSessionId: browserSessionIdSchema,
  actionId: actionIdSchema,
  stepId: browserStepIdSchema,
  outcome: z.enum([
    "POSTCONDITION_SATISFIED",
    "POSTCONDITION_NOT_SATISFIED",
    "OUTCOME_UNKNOWN",
  ]),
  predicateIds: z.array(predicateIdSchema).max(16),
  recordedAt: instantSchema,
});

export type ActionPhase = z.infer<typeof actionPhaseSchema>;
export type ActionEvidence =
  | "DISPATCHED"
  | "EFFECT_OBSERVED"
  | "RECEIPT_RECORDED"
  | "ACKNOWLEDGEMENT_LOST";

export function advanceActionPhase(
  current: ActionPhase,
  evidence: ActionEvidence,
):
  | { ok: true; phase: ActionPhase }
  | { ok: false; code: "ILLEGAL_ACTION_PHASE" } {
  if (evidence === "ACKNOWLEDGEMENT_LOST" && current !== "RECEIPTED") {
    return { ok: true, phase: "RECONCILIATION_REQUIRED" };
  }
  const next =
    current === "ACCEPTED" && evidence === "DISPATCHED"
      ? "DISPATCHED"
      : current === "DISPATCHED" && evidence === "EFFECT_OBSERVED"
        ? "EFFECT_OBSERVED"
        : current === "EFFECT_OBSERVED" && evidence === "RECEIPT_RECORDED"
          ? "RECEIPTED"
          : undefined;
  return next
    ? { ok: true, phase: next }
    : { ok: false, code: "ILLEGAL_ACTION_PHASE" };
}

export type BrowserAction = z.infer<typeof browserActionSchema>;

export function resolveActionReconciliation(
  mutationClass: "READ_ONLY" | "IDEMPOTENT" | "NON_IDEMPOTENT",
  postcondition: "SATISFIED" | "NOT_SATISFIED" | "UNKNOWN",
): "RECEIPTED" | "RETRY_ALLOWED" | "WAITING_FOR_USER" {
  if (postcondition === "SATISFIED") return "RECEIPTED";
  if (postcondition === "NOT_SATISFIED" && mutationClass !== "NON_IDEMPOTENT") {
    return "RETRY_ALLOWED";
  }
  return "WAITING_FOR_USER";
}
