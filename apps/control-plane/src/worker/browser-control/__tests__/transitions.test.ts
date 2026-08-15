import { describe, expect, it } from "vitest";
import type {
  BrowserControlState,
  SignedCommandEnvelope,
} from "@village/contracts";
import {
  acceptBrowserCommand,
  transitionBrowserControl,
} from "../transitions.js";

const initial: BrowserControlState = {
  principalId: "prn_01J00000000000000000000000",
  deviceId: "dev_01J00000000000000000000000",
  jobId: "job_01J00000000000000000000000",
  browserSessionId: "brs_01J00000000000000000000000",
  controller: "AGENT",
  connection: "ONLINE",
  leaseEpoch: 4,
  leaseExpiresAt: "2026-08-12T18:01:00.000Z",
  lastAcceptedSequence: 7,
  automationBlocked: false,
  takeover: "NONE",
  profile: "PRESENT",
};

const oldCommand: SignedCommandEnvelope = {
  protocolVersion: 1,
  principalId: initial.principalId,
  deviceId: initial.deviceId,
  jobId: "job_01J00000000000000000000000",
  browserSessionId: initial.browserSessionId,
  actionId: "act_01J00000000000000000000000",
  leaseEpoch: 4,
  sequence: 8,
  issuedAt: "2026-08-12T18:00:00.000Z",
  expiresAt: "2026-08-12T18:00:10.000Z",
  command: { capability: "OBSERVE", facts: ["AUTH_STATE"] },
  signature: "c2lnbmF0dXJl",
};

describe("browser control transitions", () => {
  it("fences the agent before acknowledging online user takeover", () => {
    const requested = transitionBrowserControl(initial, {
      type: "ONLINE_TAKEOVER_REQUESTED",
    });
    expect(requested).toEqual({
      ok: true,
      state: {
        ...initial,
        controller: "NONE",
        leaseEpoch: 5,
        leaseExpiresAt: null,
        automationBlocked: true,
        takeover: "QUIESCING",
      },
    });
    if (!requested.ok) throw new Error("takeover request unexpectedly failed");

    expect(
      acceptBrowserCommand(
        requested.state,
        oldCommand,
        "OWNED_FIXTURE",
        "2026-08-12T18:00:05.000Z",
      ),
    ).toEqual({
      ok: false,
      code: "STALE_LEASE_EPOCH",
    });

    expect(
      transitionBrowserControl(requested.state, { type: "TAKEOVER_QUIESCED" }),
    ).toEqual({
      ok: true,
      state: { ...requested.state, controller: "USER", takeover: "NONE" },
    });
    expect(
      transitionBrowserControl(initial, { type: "TAKEOVER_QUIESCED" }),
    ).toEqual({
      ok: false,
      code: "ILLEGAL_TRANSITION",
    });
  });

  it("turns host loss during takeover quiescence into an offline resumable state", () => {
    const requested = transitionBrowserControl(initial, {
      type: "ONLINE_TAKEOVER_REQUESTED",
    });
    if (!requested.ok) throw new Error("takeover request unexpectedly failed");

    const lost = transitionBrowserControl(requested.state, {
      type: "HOST_WENT_OFFLINE",
    });
    expect(lost).toMatchObject({
      ok: true,
      state: {
        connection: "OFFLINE",
        controller: "USER",
        automationBlocked: true,
        takeover: "OFFLINE_MARKED",
      },
    });
  });

  it("blocks automation offline without minting an epoch and resumes only after reconciliation", () => {
    const lost = transitionBrowserControl(initial, {
      type: "HOST_WENT_OFFLINE",
    });
    expect(lost).toMatchObject({
      ok: true,
      state: {
        connection: "OFFLINE",
        controller: "NONE",
        leaseEpoch: 4,
        automationBlocked: true,
      },
    });
    if (!lost.ok) throw new Error("host loss unexpectedly failed");

    const taken = transitionBrowserControl(lost.state, {
      type: "OFFLINE_TAKEOVER_REQUESTED",
    });
    expect(taken).toMatchObject({
      ok: true,
      state: {
        connection: "OFFLINE",
        controller: "USER",
        leaseEpoch: 4,
        takeover: "OFFLINE_MARKED",
      },
    });
    if (!taken.ok) throw new Error("offline takeover unexpectedly failed");

    const reconnected = transitionBrowserControl(taken.state, {
      type: "HOST_RECONNECTED",
    });
    expect(reconnected).toMatchObject({
      ok: true,
      state: {
        connection: "ONLINE",
        controller: "USER",
        leaseEpoch: 5,
        automationBlocked: true,
      },
    });
    if (!reconnected.ok) throw new Error("reconnect unexpectedly failed");
    expect(
      acceptBrowserCommand(
        reconnected.state,
        oldCommand,
        "OWNED_FIXTURE",
        "2026-08-12T18:00:05.000Z",
      ),
    ).toEqual({
      ok: false,
      code: "STALE_LEASE_EPOCH",
    });

    const returning = transitionBrowserControl(reconnected.state, {
      type: "RETURN_CONTROL_REQUESTED",
    });
    if (!returning.ok)
      throw new Error("return-control request unexpectedly failed");
    expect(returning.state).toMatchObject({
      controller: "NONE",
      takeover: "RECONCILING",
    });

    const resumed = transitionBrowserControl(returning.state, {
      type: "AGENT_RECONCILED",
      leaseExpiresAt: "2026-08-12T18:02:00.000Z",
    });
    expect(resumed).toMatchObject({
      ok: true,
      state: {
        connection: "ONLINE",
        controller: "AGENT",
        leaseEpoch: 6,
        automationBlocked: false,
        takeover: "NONE",
      },
    });
  });

  it("cancels future automation without deleting the retained site profile", () => {
    expect(transitionBrowserControl(initial, { type: "JOB_CANCELED" })).toEqual(
      {
        ok: true,
        state: {
          ...initial,
          controller: "NONE",
          leaseEpoch: 5,
          leaseExpiresAt: null,
          automationBlocked: true,
          profile: "PRESENT",
        },
      },
    );
  });

  it("accepts one current command and deterministically rejects replay, expiry, and identity mismatch", () => {
    const accepted = acceptBrowserCommand(
      initial,
      oldCommand,
      "OWNED_FIXTURE",
      "2026-08-12T18:00:05.000Z",
    );
    expect(accepted).toMatchObject({
      ok: true,
      state: { lastAcceptedSequence: 8 },
    });
    if (!accepted.ok) throw new Error("current command unexpectedly failed");

    expect(
      acceptBrowserCommand(
        accepted.state,
        oldCommand,
        "OWNED_FIXTURE",
        "2026-08-12T18:00:05.000Z",
      ),
    ).toEqual({
      ok: false,
      code: "REPLAYED_SEQUENCE",
    });
    expect(
      acceptBrowserCommand(
        initial,
        oldCommand,
        "OWNED_FIXTURE",
        "2026-08-12T18:00:10.000Z",
      ),
    ).toEqual({
      ok: false,
      code: "EXPIRED",
    });
    expect(
      acceptBrowserCommand(
        initial,
        { ...oldCommand, deviceId: "dev_01J00000000000000000000001" },
        "OWNED_FIXTURE",
        "2026-08-12T18:00:05.000Z",
      ),
    ).toEqual({ ok: false, code: "IDENTITY_MISMATCH" });
    expect(
      acceptBrowserCommand(
        initial,
        { ...oldCommand, jobId: "job_01J00000000000000000000001" },
        "OWNED_FIXTURE",
        "2026-08-12T18:00:05.000Z",
      ),
    ).toEqual({ ok: false, code: "IDENTITY_MISMATCH" });
    expect(
      acceptBrowserCommand(
        { ...initial, leaseExpiresAt: "2026-08-12T18:00:04.000Z" },
        oldCommand,
        "OWNED_FIXTURE",
        "2026-08-12T18:00:05.000Z",
      ),
    ).toEqual({ ok: false, code: "LEASE_EXPIRED" });
    expect(
      acceptBrowserCommand(
        initial,
        {
          ...oldCommand,
          issuedAt: "2026-08-12T18:00:06.000Z",
          expiresAt: "2026-08-12T18:00:16.000Z",
        },
        "OWNED_FIXTURE",
        "2026-08-12T18:00:05.000Z",
      ),
    ).toEqual({ ok: false, code: "NOT_YET_VALID" });
    expect(
      acceptBrowserCommand(
        initial,
        { ...oldCommand, unexpected: true },
        "OWNED_FIXTURE",
        "2026-08-12T18:00:05.000Z",
      ),
    ).toEqual({
      ok: false,
      code: "INVALID_ENVELOPE",
    });
  });

  it("enforces site policy inside command acceptance", () => {
    expect(
      acceptBrowserCommand(
        initial,
        {
          ...oldCommand,
          workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
          workflowVersion: 1,
          jobRevision: 1,
          logicalStep: "SET_DISPLAY_NAME",
          effectId: "efx_01J00000000000000000000000",
          command: {
            capability: "REPLACE_DISPLAY_NAME",
          },
        },
        "LINKEDIN",
        "2026-08-12T18:00:05.000Z",
      ),
    ).toEqual({ ok: false, code: "SITE_CAPABILITY_DENIED" });
  });
});
