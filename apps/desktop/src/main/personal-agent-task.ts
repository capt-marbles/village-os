import {
  personalAgentTaskRequestSchema,
  type BrowserObservation,
  type ModelProvider,
  type PersonalAgentTaskActivity,
  type PersonalAgentTaskResult,
} from "@village/contracts";
import { verifyAuthentication } from "../browser/auth-verifier.js";
import { classifyLinkedInRoute } from "../browser/sites/linkedin.js";
import { createSanitizedModelContext } from "../model-provider/sanitized-context.js";

export interface PersonalAgentTaskEnvironment {
  readBrowserState(): {
    currentUrl: string;
    debuggerAttached: boolean;
  };
  confirmAccount(): Promise<boolean>;
}

export interface PersonalAgentTaskOperations {
  run(
    request: unknown,
    environment: PersonalAgentTaskEnvironment,
    onActivity?: (activity: PersonalAgentTaskActivity) => void,
  ): Promise<PersonalAgentTaskResult>;
}

const predicateVersion = "linkedin-route-v1" as const;
const objective = "Check whether the LinkedIn browser session is signed in";

function linkedInObservation(
  route: ReturnType<typeof classifyLinkedInRoute>,
): BrowserObservation {
  const authState =
    route === "SIGN_IN"
      ? "SIGNED_OUT"
      : route === "AUTHENTICATED"
        ? "POSSIBLY_AUTHENTICATED"
        : "UNKNOWN";
  return {
    schemaVersion: 1,
    source: "BROWSER_UNTRUSTED",
    canonicalOrigin: "https://www.linkedin.com",
    predicateIds: [predicateVersion],
    facts: [
      { id: "AUTH_STATE", value: authState },
      { id: "HUMAN_GATE", value: "NONE" },
      { id: "APPROVED_ACTION_AVAILABLE", value: true },
    ],
  };
}

/** Runs the first read-only personal task without granting model authority. */
export class PersonalAgentTaskController implements PersonalAgentTaskOperations {
  private inFlight:
    { key: string; result: Promise<PersonalAgentTaskResult> } | undefined;

  constructor(private readonly provider: ModelProvider) {}

  run(
    candidate: unknown,
    environment: PersonalAgentTaskEnvironment,
    onActivity?: (activity: PersonalAgentTaskActivity) => void,
  ): Promise<PersonalAgentTaskResult> {
    const request = personalAgentTaskRequestSchema.parse(candidate);
    const key = request.task;
    if (this.inFlight?.key === key) return this.inFlight.result;
    if (this.inFlight) {
      return Promise.resolve({ state: "BLOCKED", reason: "TASK_IN_PROGRESS" });
    }
    const task = this.runExclusive(environment, onActivity);
    this.inFlight = { key, result: task };
    const clear = () => {
      if (this.inFlight?.result === task) this.inFlight = undefined;
    };
    void task.then(clear, clear);
    return task;
  }

  private async runExclusive(
    environment: PersonalAgentTaskEnvironment,
    onActivity?: (activity: PersonalAgentTaskActivity) => void,
  ): Promise<PersonalAgentTaskResult> {
    let sequence = 0;
    const report = (stage: PersonalAgentTaskActivity["stage"]) => {
      try {
        onActivity?.({ sequence: (sequence += 1), stage });
      } catch {
        // Progress reporting must never change the task's safety outcome.
      }
    };
    report("CLASSIFYING_BROWSER");
    const initial = this.readBrowserState(environment);
    if (!initial) return { state: "NEEDS_HUMAN", reason: "UNKNOWN_STATE" };
    const route = classifyLinkedInRoute(initial.currentUrl);
    if (route === "HUMAN_CHALLENGE" || route === "FEDERATED_IDENTITY") {
      return { state: "NEEDS_HUMAN", reason: "CHALLENGE" };
    }
    if (route === "UNKNOWN") {
      return { state: "NEEDS_HUMAN", reason: "UNKNOWN_STATE" };
    }

    report("CONSULTING_CHATGPT");
    const providerResult = await this.provider.nextAction(
      createSanitizedModelContext({
        jobState: "RUNNING_AGENT",
        actionPhase: "ACCEPTED",
        observation: linkedInObservation(route),
        objective,
      }),
    );
    if (providerResult.status === "waiting") {
      switch (providerResult.reason) {
        case "AUTHENTICATION_REQUIRED":
          return { state: "BLOCKED", reason: "CHATGPT_AUTH_REQUIRED" };
        case "PROVIDER_UNAVAILABLE":
          return { state: "BLOCKED", reason: "PROVIDER_UNAVAILABLE" };
        default:
          return { state: "BLOCKED", reason: "UNSUPPORTED_TASK" };
      }
    }
    if (providerResult.status !== "action") {
      return { state: "BLOCKED", reason: "UNSUPPORTED_TASK" };
    }
    if (
      providerResult.command.capability !== "VERIFY_AUTHENTICATION" ||
      providerResult.command.predicateVersion !== predicateVersion
    ) {
      return { state: "BLOCKED", reason: "SITE_POLICY_DENIED" };
    }

    report("VERIFYING_BROWSER");
    const fresh = this.readBrowserState(environment);
    if (!fresh) return { state: "NEEDS_HUMAN", reason: "UNKNOWN_STATE" };
    const freshRoute = classifyLinkedInRoute(fresh.currentUrl);
    if (freshRoute !== route) {
      return { state: "NEEDS_HUMAN", reason: "UNKNOWN_STATE" };
    }
    if (freshRoute === "AUTHENTICATED") {
      report("WAITING_FOR_OWNER");
      if (!(await environment.confirmAccount())) {
        return { state: "NEEDS_HUMAN", reason: "ACCOUNT_CONFIRMATION" };
      }
      const confirmed = this.readBrowserState(environment);
      if (
        !confirmed ||
        classifyLinkedInRoute(confirmed.currentUrl) !== "AUTHENTICATED"
      ) {
        return { state: "NEEDS_HUMAN", reason: "UNKNOWN_STATE" };
      }
      return {
        state: "COMPLETED",
        outcome: "AUTHENTICATED",
        evidence: "OWNER_CONFIRMED",
      };
    }

    const verification = verifyAuthentication({
      site: "LINKEDIN",
      url: fresh.currentUrl,
      predicateVersion,
      debuggerAttached: fresh.debuggerAttached,
    });
    if (verification.status === "not_authenticated") {
      return {
        state: "COMPLETED",
        outcome: "NOT_AUTHENTICATED",
        evidence: "LOCAL_PREDICATE",
      };
    }
    return { state: "NEEDS_HUMAN", reason: "ACCOUNT_CONFIRMATION" };
  }

  private readBrowserState(
    environment: PersonalAgentTaskEnvironment,
  ): ReturnType<PersonalAgentTaskEnvironment["readBrowserState"]> | undefined {
    try {
      return environment.readBrowserState();
    } catch {
      return undefined;
    }
  }
}
