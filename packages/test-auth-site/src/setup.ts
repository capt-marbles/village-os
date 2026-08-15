import type { OwnedFixtureSetupCommand } from "@village/contracts";
import { setupObservationSchema } from "@village/contracts";
import {
  ownedSetupFixtureVariants,
  type SetupFixtureVariant,
} from "./variants.js";

export const setupFixtureVariants = ownedSetupFixtureVariants;
export type { SetupFixtureVariant };

export const desiredProfileSpec = Object.freeze({
  workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1" as const,
  workflowVersion: 1 as const,
  specVersion: 1 as const,
  displayName: "Village Demo Owner",
  role: "BUILDER" as const,
  roleOptions: ["BUILDER", "OPERATOR"] as const,
  preferredFocus: "RELIABILITY" as const,
  focusOptions: ["RELIABILITY", "VELOCITY"] as const,
});

type SetupObservation = ReturnType<typeof setupObservationSchema.parse>;
export type SetupLogicalStep = SetupObservation["logicalStep"];
export type SetupCapability = OwnedFixtureSetupCommand["capability"];

export const setupPredicateIds = Object.freeze({
  SET_DISPLAY_NAME: "setup-display-name-v1",
  SELECT_ROLE: "setup-role-v1",
  SET_PREFERRED_FOCUS: "setup-preferred-focus-v1",
  FINALIZE_SETUP: "setup-finalization-v1",
  HUMAN_GATE: "setup-human-gate-v1",
});

export const mutationCapabilityForStep = Object.freeze({
  SET_DISPLAY_NAME: "REPLACE_DISPLAY_NAME",
  SELECT_ROLE: "SELECT_ROLE",
  SET_PREFERRED_FOCUS: "REPLACE_PREFERRED_FOCUS",
  FINALIZE_SETUP: "FINALIZE_SETUP",
} satisfies Record<SetupLogicalStep, SetupCapability>);

export function setupVariantById(id: string | null): SetupFixtureVariant {
  return (
    setupFixtureVariants.find((variant) => variant.id === id) ??
    setupFixtureVariants[0]!
  );
}
