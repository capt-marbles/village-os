import {
  actionPhaseSchema,
  jobStateSchema,
  sanitizeBrowserObservation,
  sanitizedModelContextSchema,
  setupModelProviderContextSchema,
  type SanitizedModelContext,
  type SetupModelProviderContext,
} from "@village/contracts";

export interface SanitizedSetupProviderPrompt {
  readonly schemaVersion: 1;
  readonly objective: SetupModelProviderContext["objective"];
  readonly logicalStep: SetupModelProviderContext["logicalStep"];
  readonly allowedActions: SetupModelProviderContext["allowedActions"];
  readonly completedSteps: SetupModelProviderContext["completedSteps"];
  readonly observation: Pick<
    SetupModelProviderContext["observation"],
    "schemaVersion" | "source" | "predicateIds" | "facts"
  >;
}

function record(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : {};
}

export function createSanitizedModelContext(
  input: Omit<SanitizedModelContext, "schemaVersion">,
): SanitizedModelContext {
  const context: SanitizedModelContext = {
    schemaVersion: 1,
    jobState: jobStateSchema.parse(input.jobState),
    actionPhase: actionPhaseSchema.parse(input.actionPhase),
    observation: sanitizeBrowserObservation(input.observation),
    ...(input.objective === undefined ? {} : { objective: input.objective }),
  };
  return sanitizedModelContextSchema.parse(context);
}

/**
 * Copies only the closed durable setup fields. Callers may pass hostile browser
 * objects; extra keys and raw values never survive into the local provider context.
 */
export function createSanitizedSetupModelContext(
  input: unknown,
): SetupModelProviderContext {
  const source = record(input);
  const objective = record(source.objective);
  const observation = record(source.observation);
  const allowedActions = Array.isArray(source.allowedActions)
    ? source.allowedActions.map((action) => ({
        capability: record(action).capability,
      }))
    : source.allowedActions;
  const facts = Array.isArray(observation.facts)
    ? observation.facts.map((fact) => {
        const bounded = record(fact);
        return { id: bounded.id, value: bounded.value };
      })
    : observation.facts;

  return setupModelProviderContextSchema.parse({
    schemaVersion: source.schemaVersion,
    objective: { kind: objective.kind, version: objective.version },
    browserSessionId: source.browserSessionId,
    jobId: source.jobId,
    jobRevision: source.jobRevision,
    logicalStep: source.logicalStep,
    effectId: source.effectId,
    leaseEpoch: source.leaseEpoch,
    actionPhase: source.actionPhase,
    allowedActions,
    completedSteps: source.completedSteps,
    observation: {
      schemaVersion: observation.schemaVersion,
      source: observation.source,
      workflowKind: observation.workflowKind,
      workflowVersion: observation.workflowVersion,
      logicalStep: observation.logicalStep,
      effectId: observation.effectId,
      predicateIds: observation.predicateIds,
      facts,
    },
  });
}

/** The model sees semantic facts and choices, never local authority identifiers. */
export function createSanitizedSetupProviderPrompt(
  context: SetupModelProviderContext,
): SanitizedSetupProviderPrompt {
  const parsed = setupModelProviderContextSchema.parse(context);
  return {
    schemaVersion: 1,
    objective: parsed.objective,
    logicalStep: parsed.logicalStep,
    allowedActions: parsed.allowedActions,
    completedSteps: parsed.completedSteps,
    observation: {
      schemaVersion: parsed.observation.schemaVersion,
      source: parsed.observation.source,
      predicateIds: parsed.observation.predicateIds,
      facts: parsed.observation.facts,
    },
  };
}
