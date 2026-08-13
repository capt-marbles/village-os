import type {
  PersonalAgentTaskRequest,
  PersonalAgentTaskResult,
} from "@village/contracts";
import { useState, type FormEvent } from "react";

type PersonalAgentTaskDisplayState =
  PersonalAgentTaskResult | { state: "IDLE" };

export interface PersonalAgentTaskBridge {
  runPersonalAgentTask(
    request: PersonalAgentTaskRequest,
  ): Promise<PersonalAgentTaskResult>;
}

export function dispatchPersonalAgentTask(
  bridge: PersonalAgentTaskBridge,
): Promise<PersonalAgentTaskResult> {
  return bridge.runPersonalAgentTask({ task: "CHECK_LINKEDIN_SIGN_IN" });
}

function statusText(state: PersonalAgentTaskDisplayState): string | null {
  switch (state.state) {
    case "IDLE":
      return null;
    case "COMPLETED":
      return state.outcome === "AUTHENTICATED"
        ? "Signed in, confirmed by you."
        : "Not signed in. The browser is on LinkedIn’s sign-in route.";
    case "NEEDS_HUMAN":
      switch (state.reason) {
        case "CHALLENGE":
          return "LinkedIn needs your attention in the browser.";
        case "ACCOUNT_CONFIRMATION":
          return "The route looks signed in, but Village needs you to confirm the account.";
        case "UNKNOWN_STATE":
          return "Village cannot safely classify this browser state.";
      }
    case "BLOCKED":
      switch (state.reason) {
        case "CHATGPT_AUTH_REQUIRED":
          return "Connect ChatGPT before running this task.";
        case "PROVIDER_UNAVAILABLE":
          return "ChatGPT is temporarily unavailable. Try again.";
        case "SENSITIVE_INPUT_DENIED":
          return "Remove passwords, tokens, or secrets from the task before sending it to ChatGPT.";
        case "TASK_IN_PROGRESS":
          return "Another Village task is still running.";
        default:
          return "Village blocked this task because it is outside the current safe capability.";
      }
  }
}

export function PersonalAgentTaskCard({
  state,
  pending,
  onSubmit,
}: {
  state: PersonalAgentTaskDisplayState;
  pending: boolean;
  onSubmit(): void;
}) {
  const status = statusText(state);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <section aria-labelledby="personal-agent-title" style={{ padding: "1rem" }}>
      <h2 id="personal-agent-title">Ask Village</h2>
      <p>
        Start with a read-only task. LinkedIn actions remain human-only. This
        fixed check sends no page contents or credentials to ChatGPT.
      </p>
      <form onSubmit={submit}>
        <p>Check whether I’m signed in to LinkedIn</p>
        <button type="submit" disabled={pending}>
          {pending ? "Village is checking…" : "Run task"}
        </button>
      </form>
      {status ? <p role="status">{status}</p> : null}
    </section>
  );
}

export function PersonalAgentTaskOnboarding({
  bridge,
}: {
  bridge: PersonalAgentTaskBridge;
}) {
  const [state, setState] = useState<PersonalAgentTaskDisplayState>({
    state: "IDLE",
  });
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (pending) return;
    setPending(true);
    try {
      setState(await dispatchPersonalAgentTask(bridge));
    } catch {
      setState({ state: "BLOCKED", reason: "PROVIDER_UNAVAILABLE" });
    } finally {
      setPending(false);
    }
  };

  return (
    <PersonalAgentTaskCard
      state={state}
      pending={pending}
      onSubmit={() => void submit()}
    />
  );
}
