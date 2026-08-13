import { z } from "zod";
import {
  browserSessionIdSchema,
  eventIdSchema,
  humanGateIdSchema,
  instantSchema,
  jobIdSchema,
  principalIdSchema,
} from "./ids.js";

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
      reason: z.enum([
        "CREDENTIAL",
        "TWO_FACTOR",
        "CAPTCHA",
        "PASSKEY",
        "PASSWORD_RESET",
        "FEDERATED_IDENTITY",
        "TERMS_OR_CONSENT",
        "SECURITY_WARNING",
        "UNKNOWN_CHALLENGE",
      ]),
    }),
  }),
  z.strictObject({
    ...base,
    type: z.literal("USER_CONTROL_ACKNOWLEDGED"),
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
    type: z.literal("JOB_SUCCEEDED"),
    payload: emptyPayload,
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
