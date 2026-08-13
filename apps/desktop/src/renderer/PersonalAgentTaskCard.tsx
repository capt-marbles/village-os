import type {
  PersonalAgentTaskActivity,
  PersonalAgentTaskRequest,
  PersonalAgentTaskResult,
} from "@village/contracts";
import { useEffect, useState, type FormEvent } from "react";

type PersonalAgentTaskDisplayState =
  PersonalAgentTaskResult | { state: "IDLE" };

export interface PersonalAgentTaskBridge {
  runPersonalAgentTask(
    request: PersonalAgentTaskRequest,
  ): Promise<PersonalAgentTaskResult>;
  subscribePersonalAgentTaskActivity(
    listener: (activity: PersonalAgentTaskActivity) => void,
  ): () => void;
}

export function dispatchPersonalAgentTask(
  bridge: Pick<PersonalAgentTaskBridge, "runPersonalAgentTask">,
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

const activityLabels: Record<PersonalAgentTaskActivity["stage"], string> = {
  CLASSIFYING_BROWSER: "Checking the visible browser route",
  CONSULTING_CHATGPT: "Asking ChatGPT for the allowed read-only check",
  VERIFYING_BROWSER: "Re-checking the local browser state",
  WAITING_FOR_OWNER: "Waiting for your account confirmation",
};

export function mergePersonalAgentTaskActivity(
  current: readonly PersonalAgentTaskActivity[],
  next: PersonalAgentTaskActivity,
): readonly PersonalAgentTaskActivity[] {
  if (next.sequence === 1) return [next];
  if (current.some((event) => event.sequence === next.sequence)) {
    return current;
  }
  return [...current, next].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

export function PersonalAgentTaskCard({
  state,
  pending,
  activity,
  onSubmit,
}: {
  state: PersonalAgentTaskDisplayState;
  pending: boolean;
  activity: readonly PersonalAgentTaskActivity[];
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
      {activity.length > 0 ? (
        <div aria-live="polite" aria-label="Village activity">
          <h3>Village activity</h3>
          <ol>
            {activity.map((event, index) => (
              <li key={event.sequence}>
                {activityLabels[event.stage]}
                {pending && index === activity.length - 1 ? "…" : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {status ? (
        <div aria-live="polite">
          <h3>Result</h3>
          <p role="status">{status}</p>
        </div>
      ) : null}
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
  const [activity, setActivity] = useState<
    readonly PersonalAgentTaskActivity[]
  >([]);

  useEffect(
    () =>
      bridge.subscribePersonalAgentTaskActivity((candidate) => {
        setActivity((current) =>
          mergePersonalAgentTaskActivity(current, candidate),
        );
      }),
    [bridge],
  );

  const submit = async () => {
    if (pending) return;
    setState({ state: "IDLE" });
    setActivity([]);
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
      activity={activity}
      onSubmit={() => void submit()}
    />
  );
}
