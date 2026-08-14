import { describe, expect, it } from "vitest";
import {
  automationSyncRequestSchema,
  automationSyncResponseSchema,
  canonicalAutomationSyncRequestBytes,
} from "../index.js";

const request = {
  protocolVersion: 1 as const,
  principalId: "prn_01J00000000000000000000000",
  deviceId: "dev_01J00000000000000000000000",
  browserSessionId: "brs_01J00000000000000000000000",
  connectionId: "connector-desktop",
  sequence: 4,
  cursor: 7,
  issuedAt: "2026-08-14T12:00:00.000Z",
  expiresAt: "2026-08-14T12:00:30.000Z",
  signature: "signature_value",
};

describe("automation synchronization contracts", () => {
  it("is strict, bounded, and canonical", () => {
    expect(automationSyncRequestSchema.parse(request)).toEqual(request);
    expect(
      automationSyncRequestSchema.safeParse({ ...request, rawPageText: "no" })
        .success,
    ).toBe(false);
    expect(
      automationSyncRequestSchema.safeParse({
        ...request,
        expiresAt: "2026-08-14T12:01:01.000Z",
      }).success,
    ).toBe(false);

    const { signature: _, ...unsigned } = request;
    expect(
      new TextDecoder().decode(canonicalAutomationSyncRequestBytes(unsigned)),
    ).toBe(
      '{"browserSessionId":"brs_01J00000000000000000000000","connectionId":"connector-desktop","cursor":7,"deviceId":"dev_01J00000000000000000000000","expiresAt":"2026-08-14T12:00:30.000Z","issuedAt":"2026-08-14T12:00:00.000Z","principalId":"prn_01J00000000000000000000000","protocolVersion":1,"sequence":4}',
    );
  });

  it("returns only authoritative automation state", () => {
    expect(
      automationSyncResponseSchema.parse({
        ok: true,
        cursor: 9,
        jobId: "job_01J00000000000000000000000",
        controller: "NONE",
        connection: "ONLINE",
        leaseEpoch: 5,
        automationBlocked: true,
      }),
    ).toEqual({
      ok: true,
      cursor: 9,
      jobId: "job_01J00000000000000000000000",
      controller: "NONE",
      connection: "ONLINE",
      leaseEpoch: 5,
      automationBlocked: true,
    });
    expect(
      automationSyncResponseSchema.safeParse({
        ok: true,
        cursor: 9,
        jobId: "job_01J00000000000000000000000",
        controller: "NONE",
        connection: "ONLINE",
        leaseEpoch: 5,
        automationBlocked: true,
        pageTitle: "private",
      }).success,
    ).toBe(false);
  });
});
