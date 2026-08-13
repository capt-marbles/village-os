import { describe, expect, it } from "vitest";
import {
  credentialFillRequestSchema,
  deviceCredentialSchema,
  executionHostSchema,
  humanGateSchema,
  operationAuthorizationSchema,
  observerIntentSchema,
  stepUpAuthorizationSchema,
  signedResultEnvelopeSchema,
} from "../index.js";

describe("portable trust-boundary schemas", () => {
  it("keeps execution hosts semantic and rejects adapter-specific locators", () => {
    const host = {
      hostId: "hst_01J00000000000000000000000",
      principalId: "prn_01J00000000000000000000000",
      deviceId: "dev_01J00000000000000000000000",
      trustClass: "LOCAL_TRUSTED",
      networkClass: "USER_NETWORK",
      connection: "ONLINE",
      capabilities: ["VISIBLE_BROWSER", "LOCAL_PROFILE", "HUMAN_TAKEOVER"],
    };
    expect(executionHostSchema.safeParse(host).success).toBe(true);
    expect(
      executionHostSchema.safeParse({
        ...host,
        cdpTargetId: "AABBCC",
        electronPartition: "persist:secret",
      }).success,
    ).toBe(false);
  });

  it("exposes only device public keys and binds one-use sensitive authorization", () => {
    const credential = {
      principalId: "prn_01J00000000000000000000000",
      deviceId: "dev_01J00000000000000000000000",
      algorithm: "Ed25519",
      publicKey: { kty: "OKP", crv: "Ed25519", x: "cHVibGljX2tleQ" },
      protection: "OS_PROTECTED_FALLBACK",
      status: "ACTIVE",
      createdAt: "2026-08-12T18:00:00.000Z",
    };
    expect(deviceCredentialSchema.safeParse(credential).success).toBe(true);
    expect(
      deviceCredentialSchema.safeParse({ ...credential, privateKey: "secret" })
        .success,
    ).toBe(false);

    const operation = {
      authorizationId: "opa_01J00000000000000000000000",
      issuer: "DESKTOP_MAIN",
      principalId: credential.principalId,
      deviceId: credential.deviceId,
      jobId: "job_01J00000000000000000000000",
      browserSessionId: "brs_01J00000000000000000000000",
      operation: "CONTROL_TRANSFER",
      stateVersion: 7,
      issuedAt: credential.createdAt,
      expiresAt: "2026-08-12T18:00:30.000Z",
      nonce: "nonce_1234567890",
      signature: "c2lnbmF0dXJl",
    };
    expect(operationAuthorizationSchema.safeParse(operation).success).toBe(
      true,
    );
    expect(
      operationAuthorizationSchema.safeParse({
        ...operation,
        operation: "SHELL_EXEC",
      }).success,
    ).toBe(false);

    expect(
      stepUpAuthorizationSchema.safeParse({
        ...operation,
        authorizationId: "stp_01J00000000000000000000000",
        issuer: "CONTROL_PLANE",
        operation: "FORGET_SITE_SESSION",
        site: "LINKEDIN",
      }).success,
    ).toBe(true);
  });

  it("scopes remote observer intents without granting browser control", () => {
    const base = {
      principalId: "prn_01J00000000000000000000000",
      deviceId: "dev_01J00000000000000000000000",
      jobId: "job_01J00000000000000000000000",
      browserSessionId: "brs_01J00000000000000000000000",
      requestedAt: "2026-08-12T18:00:00.000Z",
    };
    expect(
      observerIntentSchema.safeParse({
        ...base,
        intent: "CANCEL_FUTURE_AUTOMATION",
      }).success,
    ).toBe(true);
    expect(
      observerIntentSchema.safeParse({ ...base, intent: "CONTROL_BROWSER" })
        .success,
    ).toBe(false);
  });

  it("binds human and secret requests without carrying secret references or values", () => {
    const request = {
      authorizationId: "sfa_01J00000000000000000000000",
      principalId: "prn_01J00000000000000000000000",
      deviceId: "dev_01J00000000000000000000000",
      jobId: "job_01J00000000000000000000000",
      browserSessionId: "brs_01J00000000000000000000000",
      actionId: "act_01J00000000000000000000000",
      leaseEpoch: 3,
      exactOrigin: "https://fixture.village.test",
      documentId: "doc_01J00000000000000000000000",
      mainFrameId: "frm_01J00000000000000000000000",
      nodeId: "nod_01J00000000000000000000000",
      fieldSemantic: "PASSWORD",
      credentialSlot: "SITE_PRIMARY_CREDENTIAL",
      issuedAt: "2026-08-12T18:00:00.000Z",
      expiresAt: "2026-08-12T18:00:30.000Z",
      nonce: "nonce_1234567890",
    };
    expect(credentialFillRequestSchema.safeParse(request).success).toBe(true);
    expect(
      credentialFillRequestSchema.safeParse({
        ...request,
        secretRef: "vault://password",
      }).success,
    ).toBe(false);
    expect(
      credentialFillRequestSchema.safeParse({ ...request, value: "plaintext" })
        .success,
    ).toBe(false);

    expect(
      humanGateSchema.safeParse({
        humanGateId: "hgt_01J00000000000000000000000",
        principalId: request.principalId,
        jobId: request.jobId,
        browserSessionId: request.browserSessionId,
        reason: "TWO_FACTOR",
        resolver: "OWNER_ONLY",
        state: "OPEN",
        createdAt: request.issuedAt,
      }).success,
    ).toBe(true);
  });

  it("binds sanitized results to the full authenticated command identity", () => {
    const result = {
      protocolVersion: 1,
      principalId: "prn_01J00000000000000000000000",
      deviceId: "dev_01J00000000000000000000000",
      jobId: "job_01J00000000000000000000000",
      browserSessionId: "brs_01J00000000000000000000000",
      actionId: "act_01J00000000000000000000000",
      leaseEpoch: 3,
      sequence: 4,
      issuedAt: "2026-08-12T18:00:05.000Z",
      expiresAt: "2026-08-12T18:00:15.000Z",
      result: { status: "ACCEPTED" },
      signature: "c2lnbmF0dXJl",
    };
    expect(signedResultEnvelopeSchema.safeParse(result).success).toBe(true);
    const { principalId: _principalId, ...unscoped } = result;
    expect(signedResultEnvelopeSchema.safeParse(unscoped).success).toBe(false);
  });
});
