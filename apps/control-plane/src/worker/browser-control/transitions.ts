import {
  browserControlStateSchema,
  authorizeSiteCommand,
  signedCommandEnvelopeSchema,
  type BrowserControlState,
  type SignedCommandEnvelope,
  type Site,
} from "@village/contracts";

export type BrowserControlEvent =
  | { type: "ONLINE_TAKEOVER_REQUESTED" }
  | { type: "TAKEOVER_QUIESCED" }
  | { type: "HOST_WENT_OFFLINE" }
  | { type: "OFFLINE_TAKEOVER_REQUESTED" }
  | { type: "HOST_RECONNECTED" }
  | { type: "RETURN_CONTROL_REQUESTED" }
  | { type: "AGENT_RECONCILED"; leaseExpiresAt: string }
  | { type: "JOB_CANCELED" };

export type TransitionResult =
  | { ok: true; state: BrowserControlState }
  | { ok: false; code: "ILLEGAL_TRANSITION" };

export function transitionBrowserControl(
  current: BrowserControlState,
  event: BrowserControlEvent,
): TransitionResult {
  const state = browserControlStateSchema.parse(current);
  switch (event.type) {
    case "ONLINE_TAKEOVER_REQUESTED":
      if (
        state.controller !== "AGENT" ||
        state.connection !== "ONLINE" ||
        state.takeover !== "NONE"
      ) {
        return { ok: false, code: "ILLEGAL_TRANSITION" };
      }
      return {
        ok: true,
        state: {
          ...state,
          controller: "NONE",
          leaseEpoch: state.leaseEpoch + 1,
          leaseExpiresAt: null,
          automationBlocked: true,
          takeover: "QUIESCING",
        },
      };
    case "TAKEOVER_QUIESCED":
      if (state.controller !== "NONE" || state.takeover !== "QUIESCING") {
        return { ok: false, code: "ILLEGAL_TRANSITION" };
      }
      return {
        ok: true,
        state: { ...state, controller: "USER", takeover: "NONE" },
      };
    case "HOST_WENT_OFFLINE":
      if (state.connection !== "ONLINE") {
        return { ok: false, code: "ILLEGAL_TRANSITION" };
      }
      return {
        ok: true,
        state: {
          ...state,
          connection: "OFFLINE",
          controller: state.takeover === "QUIESCING" ? "USER" : "NONE",
          leaseExpiresAt: null,
          automationBlocked: true,
          takeover: state.takeover === "QUIESCING" ? "OFFLINE_MARKED" : "NONE",
        },
      };
    case "OFFLINE_TAKEOVER_REQUESTED":
      if (
        state.connection !== "OFFLINE" ||
        state.controller !== "NONE" ||
        state.takeover !== "NONE"
      ) {
        return { ok: false, code: "ILLEGAL_TRANSITION" };
      }
      return {
        ok: true,
        state: { ...state, controller: "USER", takeover: "OFFLINE_MARKED" },
      };
    case "HOST_RECONNECTED":
      if (
        state.connection !== "OFFLINE" ||
        state.controller !== "USER" ||
        state.takeover !== "OFFLINE_MARKED"
      ) {
        return { ok: false, code: "ILLEGAL_TRANSITION" };
      }
      return {
        ok: true,
        state: {
          ...state,
          connection: "ONLINE",
          leaseEpoch: state.leaseEpoch + 1,
          takeover: "NONE",
        },
      };
    case "RETURN_CONTROL_REQUESTED":
      if (
        state.connection !== "ONLINE" ||
        state.controller !== "USER" ||
        state.takeover !== "NONE"
      ) {
        return { ok: false, code: "ILLEGAL_TRANSITION" };
      }
      return {
        ok: true,
        state: { ...state, controller: "NONE", takeover: "RECONCILING" },
      };
    case "AGENT_RECONCILED":
      if (
        state.connection !== "ONLINE" ||
        state.controller !== "NONE" ||
        state.takeover !== "RECONCILING" ||
        Number.isNaN(Date.parse(event.leaseExpiresAt))
      ) {
        return { ok: false, code: "ILLEGAL_TRANSITION" };
      }
      return {
        ok: true,
        state: {
          ...state,
          controller: "AGENT",
          leaseEpoch: state.leaseEpoch + 1,
          leaseExpiresAt: event.leaseExpiresAt,
          automationBlocked: false,
          takeover: "NONE",
        },
      };
    case "JOB_CANCELED":
      return {
        ok: true,
        state: {
          ...state,
          controller: "NONE",
          leaseEpoch:
            state.connection === "ONLINE"
              ? state.leaseEpoch + 1
              : state.leaseEpoch,
          leaseExpiresAt: null,
          automationBlocked: true,
          takeover: "NONE",
        },
      };
  }
}

export type CommandAcceptance =
  | { ok: true; state: BrowserControlState; envelope: SignedCommandEnvelope }
  | {
      ok: false;
      code:
        | "INVALID_ENVELOPE"
        | "IDENTITY_MISMATCH"
        | "STALE_LEASE_EPOCH"
        | "AUTOMATION_UNAVAILABLE"
        | "LEASE_EXPIRED"
        | "EXPIRED"
        | "NOT_YET_VALID"
        | "REPLAYED_SEQUENCE"
        | "SITE_CAPABILITY_DENIED"
        | "DESTINATION_SITE_MISMATCH";
    };

export function acceptBrowserCommand(
  current: BrowserControlState,
  candidate: unknown,
  site: Site,
  now: string,
): CommandAcceptance {
  const state = browserControlStateSchema.parse(current);
  const parsed = signedCommandEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, code: "INVALID_ENVELOPE" };
  const envelope = parsed.data;
  const siteAuthorization = authorizeSiteCommand(site, envelope.command);
  if (!siteAuthorization.ok) return siteAuthorization;
  if (
    envelope.principalId !== state.principalId ||
    envelope.deviceId !== state.deviceId ||
    envelope.jobId !== state.jobId ||
    envelope.browserSessionId !== state.browserSessionId
  ) {
    return { ok: false, code: "IDENTITY_MISMATCH" };
  }
  if (envelope.leaseEpoch !== state.leaseEpoch) {
    return { ok: false, code: "STALE_LEASE_EPOCH" };
  }
  if (
    state.controller !== "AGENT" ||
    state.connection !== "ONLINE" ||
    state.automationBlocked
  ) {
    return { ok: false, code: "AUTOMATION_UNAVAILABLE" };
  }
  if (
    state.leaseExpiresAt === null ||
    Date.parse(state.leaseExpiresAt) <= Date.parse(now)
  ) {
    return { ok: false, code: "LEASE_EXPIRED" };
  }
  if (Date.parse(envelope.issuedAt) > Date.parse(now)) {
    return { ok: false, code: "NOT_YET_VALID" };
  }
  if (Date.parse(envelope.expiresAt) <= Date.parse(now)) {
    return { ok: false, code: "EXPIRED" };
  }
  if (envelope.sequence <= state.lastAcceptedSequence) {
    return { ok: false, code: "REPLAYED_SEQUENCE" };
  }
  return {
    ok: true,
    envelope,
    state: { ...state, lastAcceptedSequence: envelope.sequence },
  };
}
