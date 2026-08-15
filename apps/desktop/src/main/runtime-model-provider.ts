import type { ModelProvider } from "@village/contracts";
import {
  createCodexAppServerProvider,
  type BoundedSetupModelProvider,
} from "../model-provider/codex-app-server.js";
import {
  ModelProviderAccountController,
  type ManagedModelProviderAccount,
  type ModelProviderAccountOperations,
  type OpenManagedLogin,
} from "./model-provider-account.js";
import {
  PersonalAgentTaskController,
  type PersonalAgentTaskOperations,
} from "./personal-agent-task.js";

export interface RuntimeModelProvider
  extends
    ManagedModelProviderAccount,
    ModelProvider,
    BoundedSetupModelProvider {}

export interface RuntimeModelProviderComposition {
  readonly provider: RuntimeModelProvider;
  readonly modelProviderAccount: ModelProviderAccountOperations;
  readonly personalAgentTask: PersonalAgentTaskOperations;
}

export function createRuntimeModelProviderComposition(
  openManagedLogin: OpenManagedLogin,
  createProvider: () => RuntimeModelProvider = createCodexAppServerProvider,
): RuntimeModelProviderComposition {
  const provider = createProvider();
  return {
    provider,
    modelProviderAccount: new ModelProviderAccountController(
      provider,
      openManagedLogin,
    ),
    personalAgentTask: new PersonalAgentTaskController(provider),
  };
}
