import { z } from "zod";
import {
  browserSessionIdSchema,
  deviceIdSchema,
  hostIdSchema,
  instantSchema,
  jobIdSchema,
  principalIdSchema,
} from "./ids.js";

export const controllerSchema = z.enum(["NONE", "AGENT", "USER"]);
export const connectionStateSchema = z.enum(["ONLINE", "OFFLINE", "ABSENT"]);
export const takeoverStateSchema = z.enum([
  "NONE",
  "QUIESCING",
  "OFFLINE_MARKED",
  "RECONCILING",
]);

export const browserControlStateSchema = z
  .strictObject({
    principalId: principalIdSchema,
    deviceId: deviceIdSchema,
    jobId: jobIdSchema,
    browserSessionId: browserSessionIdSchema,
    controller: controllerSchema,
    connection: connectionStateSchema,
    leaseEpoch: z.number().int().nonnegative(),
    leaseExpiresAt: instantSchema.nullable(),
    lastAcceptedSequence: z.number().int().nonnegative(),
    automationBlocked: z.boolean(),
    takeover: takeoverStateSchema,
    profile: z.enum(["PRESENT", "FORGETTING", "ABSENT", "ERASURE_FAILED"]),
  })
  .superRefine((state, context) => {
    const invalid = (message: string) =>
      context.addIssue({ code: "custom", message });
    if (
      state.controller === "AGENT" &&
      (state.connection !== "ONLINE" ||
        state.leaseExpiresAt === null ||
        state.automationBlocked ||
        state.takeover !== "NONE")
    ) {
      invalid("AGENT control requires an online, unblocked active lease");
    }
    if (
      state.controller === "USER" &&
      (state.leaseExpiresAt !== null || !state.automationBlocked)
    ) {
      invalid("USER control requires automation to be fenced");
    }
    if (state.connection === "ABSENT" && state.controller !== "NONE") {
      invalid("An absent host cannot have a controller");
    }
    if (
      state.takeover === "QUIESCING" &&
      (state.connection !== "ONLINE" ||
        state.controller !== "NONE" ||
        !state.automationBlocked)
    ) {
      invalid("QUIESCING requires fenced online control");
    }
    if (
      state.takeover === "OFFLINE_MARKED" &&
      (state.connection !== "OFFLINE" || state.controller !== "USER")
    ) {
      invalid("OFFLINE_MARKED requires offline user control");
    }
    if (
      state.takeover === "RECONCILING" &&
      (state.connection !== "ONLINE" || state.controller !== "NONE")
    ) {
      invalid("RECONCILING requires online controller reconciliation");
    }
  });

export const browserLeaseSchema = z
  .strictObject({
    principalId: principalIdSchema,
    deviceId: deviceIdSchema,
    browserSessionId: browserSessionIdSchema,
    holder: z.literal("AGENT"),
    epoch: z.number().int().positive(),
    issuedAt: instantSchema,
    expiresAt: instantSchema,
    lastAcceptedSequence: z.number().int().nonnegative(),
  })
  .superRefine((lease, context) => {
    const lifetime = Date.parse(lease.expiresAt) - Date.parse(lease.issuedAt);
    if (lifetime <= 0 || lifetime > 60_000) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Lease lifetime must be between 1ms and 60s",
      });
    }
  });

export const browserSessionSchema = z
  .strictObject({
    principalId: principalIdSchema,
    deviceId: deviceIdSchema,
    hostId: hostIdSchema,
    browserSessionId: browserSessionIdSchema,
    site: z.enum(["OWNED_FIXTURE", "LINKEDIN"]),
    control: browserControlStateSchema,
  })
  .superRefine((session, context) => {
    if (
      session.principalId !== session.control.principalId ||
      session.deviceId !== session.control.deviceId ||
      session.browserSessionId !== session.control.browserSessionId
    ) {
      context.addIssue({
        code: "custom",
        path: ["control"],
        message: "Browser Session identity must match its control state",
      });
    }
  });

export const verificationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("authenticated"),
    predicateVersion: z.string().min(1).max(64),
  }),
  z.strictObject({
    status: z.literal("confirmed_by_user"),
    predicateVersion: z.string().min(1).max(64),
  }),
  z.strictObject({
    status: z.literal("not_authenticated"),
    predicateVersion: z.string().min(1).max(64),
  }),
  z.strictObject({
    status: z.literal("unknown"),
    predicateVersion: z.string().min(1).max(64),
  }),
]);

export type BrowserControlState = z.infer<typeof browserControlStateSchema>;
export type VerificationResult = z.infer<typeof verificationResultSchema>;
export type BrowserLease = z.infer<typeof browserLeaseSchema>;
