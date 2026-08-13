import {
  browserObservationSchema,
  type BrowserObservation,
} from "@village/contracts";

function ownData(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

export function redactBrowserObservation(input: unknown): BrowserObservation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("INVALID_BROWSER_OBSERVATION_INPUT");
  }
  const canonicalOrigin = ownData(input, "canonicalOrigin");
  const authState = ownData(input, "authState");
  const challenge = ownData(input, "challenge");
  const visibleApprovedFieldCount = ownData(input, "visibleApprovedFieldCount");
  return browserObservationSchema.parse({
    schemaVersion: 1,
    source: "BROWSER_UNTRUSTED",
    canonicalOrigin,
    predicateIds: ["auth-state-v1", "human-gate-v1", "approved-field-count-v1"],
    facts: [
      { id: "AUTH_STATE", value: authState },
      { id: "HUMAN_GATE", value: challenge },
      { id: "VISIBLE_APPROVED_FIELD_COUNT", value: visibleApprovedFieldCount },
    ],
  });
}
