import { z } from "zod";
import {
  browserSessionIdSchema,
  deviceIdSchema,
  humanGateIdSchema,
  instantSchema,
  jobIdSchema,
  principalIdSchema,
} from "./ids.js";

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

export const checkpointSchema = z.strictObject({
  checkpointId: z.string().regex(/^chk_[0-9A-HJKMNP-TV-Z]{26}$/),
  principalId: principalIdSchema,
  jobId: jobIdSchema,
  jobVersion: z.number().int().positive(),
  eventSequence: z.number().int().positive(),
  state: jobStateSchema,
  createdAt: instantSchema,
});

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
