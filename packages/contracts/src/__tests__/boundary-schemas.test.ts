import { describe, expect, it } from "vitest";
import {
  credentialFillRequestSchema,
  deviceCredentialSchema,
  executionHostSchema,
  humanGateSchema,
  operationAuthorizationSchema,
  observerIntentSchema,
  personalAgentTaskActivitySchema,
  personalAgentTaskRequestSchema,
  personalAgentTaskResultSchema,
  stepUpAuthorizationSchema,
  signedResultEnvelopeSchema,
  setupModelProviderContextSchema,
  setupModelProviderResultSchema,
  validateSetupModelProviderResult,
  signedCommandEnvelopeSchema,
} from "../index.js";

describe("portable trust-boundary schemas", () => {
  it("keeps personal task IPC bounded and credential-free", () => {
    expect(
      personalAgentTaskRequestSchema.parse({ task: "CHECK_LINKEDIN_SIGN_IN" }),
    ).toEqual({ task: "CHECK_LINKEDIN_SIGN_IN" });
    expect(
      personalAgentTaskRequestSchema.safeParse({
        task: "CHECK_LINKEDIN_SIGN_IN",
        prompt: "my password is secret",
      }).success,
    ).toBe(false);
    expect(
      personalAgentTaskResultSchema.safeParse({
        state: "COMPLETED",
        outcome: "AUTHENTICATED",
        evidence: "OWNER_CONFIRMED",
        token: "must-not-cross-ipc",
      }).success,
    ).toBe(false);
    expect(
      personalAgentTaskActivitySchema.parse({
        sequence: 1,
        stage: "CLASSIFYING_BROWSER",
      }),
    ).toEqual({ sequence: 1, stage: "CLASSIFYING_BROWSER" });
    expect(
      personalAgentTaskActivitySchema.safeParse({
        sequence: 2,
        stage: "CONSULTING_CHATGPT",
        detail: "https://www.linkedin.com/feed/?token=secret",
      }).success,
    ).toBe(false);
  });

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

  it("binds setup provider turns to revision, step, effect, and lease", () => {
    const context = {
      schemaVersion: 1,
      objective: {
        kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
        version: 1,
      },
      jobId: "job_01J00000000000000000000000",
      browserSessionId: "brs_01J00000000000000000000000",
      jobRevision: 8,
      logicalStep: "SELECT_ROLE",
      effectId: "efx_01J00000000000000000000000",
      leaseEpoch: 3,
      actionPhase: "ACCEPTED",
      allowedActions: [{ capability: "SELECT_ROLE" }],
      completedSteps: ["SET_DISPLAY_NAME"],
      observation: {
        schemaVersion: 1,
        source: "BROWSER_UNTRUSTED",
        workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
        workflowVersion: 1,
        logicalStep: "SELECT_ROLE",
        effectId: "efx_01J00000000000000000000000",
        predicateIds: ["setup-role-v1"],
        facts: [
          { id: "ROLE_MATCH", value: "MISMATCH" },
          { id: "HUMAN_GATE", value: "NONE" },
        ],
      },
    } as const;
    expect(setupModelProviderContextSchema.safeParse(context).success).toBe(
      true,
    );
    expect(
      setupModelProviderResultSchema.safeParse({
        status: "action",
        jobId: context.jobId,
        jobRevision: context.jobRevision,
        logicalStep: context.logicalStep,
        effectId: context.effectId,
        leaseEpoch: context.leaseEpoch,
        command: { capability: "SELECT_ROLE" },
      }).success,
    ).toBe(true);
    const result = {
      status: "action",
      jobId: context.jobId,
      jobRevision: context.jobRevision,
      logicalStep: context.logicalStep,
      effectId: context.effectId,
      leaseEpoch: context.leaseEpoch,
      command: { capability: "SELECT_ROLE" },
    } as const;
    expect(validateSetupModelProviderResult(context, result)).toEqual(result);
    for (const stale of [
      { ...result, jobId: "job_01J00000000000000000000001" },
      { ...result, jobRevision: result.jobRevision + 1 },
      { ...result, logicalStep: "FINALIZE_SETUP" },
      { ...result, effectId: "efx_01J00000000000000000000001" },
      { ...result, leaseEpoch: result.leaseEpoch + 1 },
    ]) {
      expect(validateSetupModelProviderResult(context, stale)).toEqual({
        status: "waiting",
        reason: "STALE_PROVIDER_RESULT",
      });
    }
    expect(
      validateSetupModelProviderResult(context, {
        ...result,
        command: { capability: "FINALIZE_SETUP" },
      }),
    ).toEqual({
      status: "waiting",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });
    for (const smuggled of [
      { ...context, prompt: "go to LinkedIn" },
      { ...context, objective: { ...context.objective, text: "raw prompt" } },
      { ...context, url: "https://fixture.village.test/?secret=x" },
      {
        ...context,
        observation: { ...context.observation, pageText: "secret" },
      },
    ]) {
      expect(setupModelProviderContextSchema.safeParse(smuggled).success).toBe(
        false,
      );
    }
  });

  it("binds setup observations in signed result envelopes", () => {
    const binding = {
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
      workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
      workflowVersion: 1,
      jobRevision: 8,
      logicalStep: "SELECT_ROLE",
      effectId: "efx_01J00000000000000000000000",
      signature: "c2lnbmF0dXJl",
    } as const;
    const command = { ...binding, command: { capability: "SELECT_ROLE" } };
    expect(signedCommandEnvelopeSchema.safeParse(command).success).toBe(true);
    expect(
      signedResultEnvelopeSchema.safeParse({
        ...binding,
        result: {
          status: "OBSERVATION",
          observation: {
            schemaVersion: 1,
            source: "BROWSER_UNTRUSTED",
            workflowKind: binding.workflowKind,
            workflowVersion: binding.workflowVersion,
            logicalStep: binding.logicalStep,
            effectId: binding.effectId,
            predicateIds: ["setup-role-v1"],
            facts: [{ id: "ROLE_MATCH", value: "MATCH" }],
          },
        },
      }).success,
    ).toBe(true);
    expect(
      signedResultEnvelopeSchema.safeParse({
        ...binding,
        result: {
          status: "OBSERVATION",
          observation: {
            schemaVersion: 1,
            source: "BROWSER_UNTRUSTED",
            canonicalOrigin: "https://www.linkedin.com",
            predicateIds: ["linkedin-v1"],
            facts: [{ id: "AUTH_STATE", value: "SIGNED_OUT" }],
          },
        },
      }).success,
    ).toBe(false);
  });
});
