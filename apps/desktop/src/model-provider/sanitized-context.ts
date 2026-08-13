import {
  actionPhaseSchema,
  jobStateSchema,
  sanitizeBrowserObservation,
  sanitizedModelContextSchema,
  type SanitizedModelContext,
} from "@village/contracts";

export function createSanitizedModelContext(
  input: Omit<SanitizedModelContext, "schemaVersion">,
): SanitizedModelContext {
  const context: SanitizedModelContext = {
    schemaVersion: 1,
    jobState: jobStateSchema.parse(input.jobState),
    actionPhase: actionPhaseSchema.parse(input.actionPhase),
    observation: sanitizeBrowserObservation(input.observation),
  };
  return sanitizedModelContextSchema.parse(context);
}
