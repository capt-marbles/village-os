import { z } from "zod";
import {
  browserSessionIdSchema,
  checkpointIdSchema,
  deviceIdSchema,
  effectIdSchema,
  humanGateIdSchema,
  instantSchema,
  jobIdSchema,
  principalIdSchema,
  actionIdSchema,
  setupLogicalStepSchema,
  setupObjectiveSchema,
} from "./ids.js";
import { actionPhaseSchema } from "./actions.js";
import { predicateIdSchema } from "./redaction.js";

export const jobStateSchema = z.enum([
  "QUEUED",
  "WAITING_FOR_BROWSER",
  "RUNNING_AGENT",
  "WAITING_FOR_SECRET",
  "WAITING_FOR_USER",
  "RUNNING_USER",
  "VERIFYING",
  "SUCCEEDED",
  "FAILED",
  "CANCELED",
]);

export const jobSchema = z
  .strictObject({
    principalId: principalIdSchema,
    jobId: jobIdSchema,
    browserSessionId: browserSessionIdSchema.nullable(),
    state: jobStateSchema,
    version: z.number().int().positive(),
    lastEventSequence: z.number().int().positive(),
    activeHumanGateId: humanGateIdSchema.nullable(),
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .superRefine((job, context) => {
    const requiresGate =
      job.state === "WAITING_FOR_SECRET" ||
      job.state === "WAITING_FOR_USER" ||
      job.state === "RUNNING_USER";
    if (requiresGate !== (job.activeHumanGateId !== null)) {
      context.addIssue({
        code: "custom",
        path: ["activeHumanGateId"],
        message:
          "Human-controlled and waiting states must have exactly one active gate",
      });
    }
  });

export const authenticationCheckpointSchema = z.strictObject({
  checkpointId: checkpointIdSchema,
  principalId: principalIdSchema,
  jobId: jobIdSchema,
  jobVersion: z.number().int().positive(),
  eventSequence: z.number().int().positive(),
  state: jobStateSchema,
  createdAt: instantSchema,
});

export const completedSetupEffectSchema = z.strictObject({
  logicalStep: setupLogicalStepSchema,
  effectId: effectIdSchema,
});

export const outstandingSetupActionSchema = z.strictObject({
  actionId: actionIdSchema,
  logicalStep: setupLogicalStepSchema,
  effectId: effectIdSchema,
  leaseEpoch: z.number().int().positive(),
});

export const setupCheckpointSchema = z
  .strictObject({
    checkpointId: checkpointIdSchema,
    principalId: principalIdSchema,
    deviceId: deviceIdSchema,
    jobId: jobIdSchema,
    browserSessionId: browserSessionIdSchema,
    jobRevision: z.number().int().positive(),
    eventSequence: z.number().int().positive(),
    state: jobStateSchema,
    objective: setupObjectiveSchema,
    site: z.literal("OWNED_FIXTURE"),
    currentStep: setupLogicalStepSchema,
    currentEffectId: effectIdSchema,
    completedEffects: z.array(completedSetupEffectSchema).max(4),
    outstandingAction: outstandingSetupActionSchema.nullable(),
    lastPredicateVersion: predicateIdSchema,
    actionPhase: actionPhaseSchema,
    reconciliation: z.enum([
      "NONE",
      "RETRY_ALLOWED",
      "RECEIPT_REQUIRED",
      "WAITING_FOR_USER",
    ]),
    createdAt: instantSchema,
  })
  .superRefine((checkpoint, context) => {
    const steps = checkpoint.completedEffects.map((entry) => entry.logicalStep);
    const effects = checkpoint.completedEffects.map((entry) => entry.effectId);
    if (new Set(steps).size !== steps.length) {
      context.addIssue({
        code: "custom",
        path: ["completedEffects"],
        message: "A logical step can have only one stable effect identity",
      });
    }
    if (new Set(effects).size !== effects.length) {
      context.addIssue({
        code: "custom",
        path: ["completedEffects"],
        message: "Effect identities cannot be reused across logical steps",
      });
    }
    if (
      checkpoint.outstandingAction !== null &&
      (checkpoint.outstandingAction.logicalStep !== checkpoint.currentStep ||
        checkpoint.outstandingAction.effectId !== checkpoint.currentEffectId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["outstandingAction"],
        message: "Outstanding action must match the current logical effect",
      });
    }
  });

export const checkpointSchema = z.union([
  authenticationCheckpointSchema,
  setupCheckpointSchema,
]);

export const observerIntentSchema = z.strictObject({
  principalId: principalIdSchema,
  deviceId: deviceIdSchema,
  jobId: jobIdSchema,
  browserSessionId: browserSessionIdSchema,
  intent: z.enum(["CANCEL_FUTURE_AUTOMATION", "NOTIFY_DESKTOP"]),
  requestedAt: instantSchema,
});

export type Job = z.infer<typeof jobSchema>;
export type JobState = z.infer<typeof jobStateSchema>;
