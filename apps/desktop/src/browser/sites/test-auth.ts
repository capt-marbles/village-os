import {
  browserObservationSchema,
  OWNED_FIXTURE_ORIGIN,
  type BrowserObservation,
} from "@village/contracts";

export interface FixtureObservationVariant {
  authState: "SIGNED_OUT" | "POSSIBLY_AUTHENTICATED" | "UNKNOWN";
  humanGate:
    | "NONE"
    | "TWO_FACTOR"
    | "PASSKEY"
    | "FEDERATED_IDENTITY"
    | "TERMS_OR_CONSENT"
    | "UNKNOWN_CHALLENGE";
  approvedActionAvailable: boolean;
  fieldCount: number;
  predicateIds: readonly string[];
}

export function createFixtureObservation(
  variant: FixtureObservationVariant,
): BrowserObservation {
  return browserObservationSchema.parse({
    schemaVersion: 1,
    source: "BROWSER_UNTRUSTED",
    canonicalOrigin: OWNED_FIXTURE_ORIGIN,
    predicateIds: variant.predicateIds,
    facts: [
      { id: "AUTH_STATE", value: variant.authState },
      { id: "HUMAN_GATE", value: variant.humanGate },
      {
        id: "APPROVED_ACTION_AVAILABLE",
        value: variant.approvedActionAvailable,
      },
      { id: "VISIBLE_APPROVED_FIELD_COUNT", value: variant.fieldCount },
    ],
  });
}
