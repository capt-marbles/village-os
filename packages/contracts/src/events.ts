import { z } from "zod";
import {
  browserSessionIdSchema,
  eventIdSchema,
  humanGateIdSchema,
  instantSchema,
  jobIdSchema,
  principalIdSchema,
} from "./ids.js";
import { authenticationEvidenceSchema } from "./browser.js";
import { humanGateReasonSchema } from "./secrets.js";

const base = {
  eventId: eventIdSchema,
  principalId: principalIdSchema,
  jobId: jobIdSchema,
  sequence: z.number().int().positive(),
  occurredAt: instantSchema,
};
const emptyPayload = z.strictObject({});

export const jobEventSchema = z.discriminatedUnion("type", [
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
    payload: authenticationEvidenceSchema,
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
]);

export type JobEvent = z.infer<typeof jobEventSchema>;
