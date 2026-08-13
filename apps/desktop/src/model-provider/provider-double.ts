import {
  parseModelProviderOutput,
  type ModelProvider,
  type ModelProviderResult,
  type SanitizedModelContext,
} from "@village/contracts";

type ScriptedResponse = unknown | Error;

export class DeterministicProviderDouble implements ModelProvider {
  readonly id = "deterministic-provider-double";
  private cursor = 0;

  constructor(private readonly script: readonly ScriptedResponse[] = []) {}

  async nextAction(
    context: SanitizedModelContext,
  ): Promise<ModelProviderResult> {
    const scripted = this.script[this.cursor++];
    if (scripted instanceof Error) {
      return { status: "waiting", reason: "PROVIDER_UNAVAILABLE" };
    }
    if (
      typeof scripted === "object" &&
      scripted !== null &&
      (scripted as { kind?: unknown }).kind === "AUTHENTICATION_REQUIRED"
    ) {
      return { status: "waiting", reason: "AUTHENTICATION_REQUIRED" };
    }
    if (scripted !== undefined) return parseModelProviderOutput(scripted);

    const gate = context.observation.facts.find(
      (fact) => fact.id === "HUMAN_GATE",
    );
    if (gate?.id !== "HUMAN_GATE" || gate.value !== "NONE") {
      return { status: "waiting", reason: "HUMAN_GATE_REQUIRED" };
    }
    const actionAvailable = context.observation.facts.some(
      (fact) => fact.id === "APPROVED_ACTION_AVAILABLE" && fact.value,
    );
    return actionAvailable
      ? {
          status: "action",
          command: {
            capability: "OBSERVE",
            facts: ["AUTH_STATE", "HUMAN_GATE", "ACTION_POSTCONDITION"],
          },
        }
      : { status: "waiting", reason: "NO_SAFE_ACTION" };
  }

  async close(): Promise<void> {}
}
