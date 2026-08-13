import { z } from "zod";
import {
  actionIdSchema,
  browserSessionIdSchema,
  instantSchema,
} from "./ids.js";

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
