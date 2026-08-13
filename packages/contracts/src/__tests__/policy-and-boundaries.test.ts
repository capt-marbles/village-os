import { describe, expect, it } from "vitest";
import {
  actionReceiptSchema,
  browserStepSchema,
  commandPolicyFor,
  executionHostSchema,
  isHostEligibleForSite,
  operationAuthorizationSchema,
  siteCommandPolicySchema,
  stepUpAuthorizationSchema,
} from "../index.js";

const binding = {
  principalId: "prn_01J00000000000000000000000",
  deviceId: "dev_01J00000000000000000000000",
  jobId: "job_01J00000000000000000000000",
  browserSessionId: "brs_01J00000000000000000000000",
};

describe("policy and boundary contracts", () => {
  it("declares bounded command policy and keeps LinkedIn local", () => {
    expect(
      siteCommandPolicySchema.parse(commandPolicyFor("LINKEDIN")),
    ).toMatchObject({
      site: "LINKEDIN",
      allowedOrigins: ["https://www.linkedin.com"],
    });
    const local = executionHostSchema.parse({
      hostId: "hst_01J00000000000000000000000",
      principalId: binding.principalId,
      deviceId: binding.deviceId,
      trustClass: "LOCAL_TRUSTED",
      networkClass: "USER_NETWORK",
      connection: "ONLINE",
      capabilities: ["VISIBLE_BROWSER", "LOCAL_PROFILE", "HUMAN_TAKEOVER"],
    });
    expect(isHostEligibleForSite(local, "LINKEDIN")).toBe(true);
    expect(
      isHostEligibleForSite(
        { ...local, trustClass: "REMOTE_ISOLATED", networkClass: "DATACENTER" },
        "LINKEDIN",
      ),
    ).toBe(false);
  });

  it("requires step and receipt identity plus bounded evidence", () => {
    const step = {
      stepId: "bsp_01J00000000000000000000000",
      ...binding,
      ordinal: 1,
      capability: "OBSERVE",
      state: "PENDING",
      createdAt: "2026-08-12T18:00:00.000Z",
    };
    expect(browserStepSchema.safeParse(step).success).toBe(true);
    expect(
      actionReceiptSchema.safeParse({
        receiptId: "rcp_01J00000000000000000000000",
        ...binding,
        actionId: "act_01J00000000000000000000000",
        stepId: step.stepId,
        outcome: "POSTCONDITION_SATISFIED",
        predicateIds: ["auth-form-visible-v1"],
        recordedAt: "2026-08-12T18:00:01.000Z",
      }).success,
    ).toBe(true);
  });

  it("rejects overlong sensitive authorizations", () => {
    const common = {
      ...binding,
      stateVersion: 1,
      issuedAt: "2026-08-12T18:00:00.000Z",
      nonce: "nonce_nonce_nonce",
      signature: "c2lnbmF0dXJl",
    };
    expect(
      operationAuthorizationSchema.safeParse({
        authorizationId: "opa_01J00000000000000000000000",
        issuer: "DESKTOP_MAIN",
        ...common,
        expiresAt: "2026-08-12T18:01:01.000Z",
        operation: "CONTROL_TRANSFER",
      }).success,
    ).toBe(false);
    expect(
      stepUpAuthorizationSchema.safeParse({
        authorizationId: "stp_01J00000000000000000000000",
        issuer: "CONTROL_PLANE",
        ...common,
        expiresAt: "2026-08-12T18:05:01.000Z",
        operation: "FORGET_SITE_SESSION",
        site: "LINKEDIN",
      }).success,
    ).toBe(false);
  });
});
