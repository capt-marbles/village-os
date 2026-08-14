import {
  delegatedWorkflowActionLabel,
  deriveDelegatedWorkflowModel,
  type DelegatedWorkflowAction,
  type DelegatedWorkflowSnapshot,
  type DelegatedWorkflowTask,
} from "@village/ui";
import { useEffect, useState } from "react";

export interface DelegatedWorkflowBridge {
  getDelegatedWorkflowState(): Promise<DelegatedWorkflowSnapshot>;
  subscribeDelegatedWorkflowState(
    listener: (snapshot: DelegatedWorkflowSnapshot) => void,
  ): () => void;
  runDelegatedWorkflowAction(
    action: DelegatedWorkflowAction,
  ): Promise<DelegatedWorkflowSnapshot>;
  selectDesktopTask(
    task: DelegatedWorkflowTask,
  ): Promise<DelegatedWorkflowTask>;
}

const initialSnapshot: DelegatedWorkflowSnapshot = {
  workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
  state: "DISCONNECTED",
  logicalStep: null,
  controller: "NONE",
  connection: "ABSENT",
  actionPhase: "NONE",
  lastEffectActor: null,
  humanGate: null,
  inputOwner: "NONE",
  lastDurableUpdateAt: new Date(0).toISOString(),
};

const stepLabels: Record<
  Exclude<DelegatedWorkflowSnapshot["logicalStep"], null>,
  string
> = {
  SET_DISPLAY_NAME: "Set display name",
  SELECT_ROLE: "Choose role",
  SET_PREFERRED_FOCUS: "Set preferred focus",
  FINALIZE_SETUP: "Finalize demo profile",
};

export function DelegatedWorkflowCard({
  snapshot,
  activeTask,
  pendingAction,
  onAction,
  onSelectTask,
}: {
  snapshot: DelegatedWorkflowSnapshot;
  activeTask: DelegatedWorkflowTask;
  pendingAction: DelegatedWorkflowAction | null;
  onAction(action: DelegatedWorkflowAction): void;
  onSelectTask(task: DelegatedWorkflowTask): void;
}) {
  const model = deriveDelegatedWorkflowModel(snapshot);
  const action = (candidate: DelegatedWorkflowAction) => (
    <button
      key={candidate}
      type="button"
      disabled={model.actionsDisabled || pendingAction !== null}
      onClick={() => onAction(candidate)}
      style={{ minWidth: 44, minHeight: 44 }}
    >
      {pendingAction === candidate
        ? "Working…"
        : delegatedWorkflowActionLabel(candidate)}
    </button>
  );
  return (
    <section aria-labelledby="delegated-workflow-title">
      <h2 id="delegated-workflow-title">Browser tasks</h2>
      <div role="tablist" aria-label="Local browser tasks">
        <button
          type="button"
          role="tab"
          aria-selected={activeTask === "LINKEDIN_PERSONAL"}
          onClick={() => onSelectTask("LINKEDIN_PERSONAL")}
          style={{ minWidth: 44, minHeight: 44 }}
        >
          LinkedIn (personal)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTask === "VILLAGE_FIXTURE"}
          onClick={() => onSelectTask("VILLAGE_FIXTURE")}
          style={{ minWidth: 44, minHeight: 44 }}
        >
          Village demo setup
        </button>
      </div>
      <div role="status" aria-live="polite" aria-atomic="true">
        <h3>{model.label}</h3>
        <p>{model.explanation}</p>
      </div>
      <dl>
        <dt>Current step</dt>
        <dd>
          {snapshot.logicalStep
            ? stepLabels[snapshot.logicalStep]
            : "Not started"}
        </dd>
        <dt>Controller</dt>
        <dd>
          {snapshot.controller === "USER"
            ? "You"
            : snapshot.controller === "AGENT"
              ? "Village agent"
              : "None"}
        </dd>
        <dt>Browser input</dt>
        <dd>{model.inputOwner === "OWNER" ? "Owned by you" : "Blocked"}</dd>
        <dt>Action phase</dt>
        <dd>{snapshot.actionPhase.replaceAll("_", " ").toLowerCase()}</dd>
        <dt>Last effect</dt>
        <dd>{snapshot.lastEffectActor ?? "None"}</dd>
        <dt>Last durable update</dt>
        <dd>
          <time dateTime={snapshot.lastDurableUpdateAt}>
            {snapshot.lastDurableUpdateAt}
          </time>
        </dd>
      </dl>
      {snapshot.humanGate ? (
        <p role="alert">Owner-only gate: {snapshot.humanGate}</p>
      ) : null}
      <div>
        {model.primaryAction ? action(model.primaryAction) : null}
        {model.secondaryActions.map(action)}
      </div>
    </section>
  );
}

export function InternalDelegatedWorkflowPanel({
  bridge,
  onError,
}: {
  bridge: DelegatedWorkflowBridge;
  onError(message: string): void;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [activeTask, setActiveTask] =
    useState<DelegatedWorkflowTask>("LINKEDIN_PERSONAL");
  const [pendingAction, setPendingAction] =
    useState<DelegatedWorkflowAction | null>(null);

  useEffect(() => {
    let active = true;
    const publish = (next: DelegatedWorkflowSnapshot) => {
      if (!active) return;
      setSnapshot((current) =>
        Date.parse(next.lastDurableUpdateAt) >=
        Date.parse(current.lastDurableUpdateAt)
          ? next
          : current,
      );
    };
    const unsubscribe = bridge.subscribeDelegatedWorkflowState(publish);
    void bridge
      .getDelegatedWorkflowState()
      .then(publish)
      .catch(() => onError("Demo workflow status is unavailable."));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge, onError]);

  const run = async (action: DelegatedWorkflowAction) => {
    if (pendingAction) return;
    setPendingAction(action);
    try {
      setSnapshot(await bridge.runDelegatedWorkflowAction(action));
      if (action === "START") setActiveTask("VILLAGE_FIXTURE");
    } catch {
      onError("The demo action did not complete. Durable state was preserved.");
    } finally {
      setPendingAction(null);
    }
  };
  const select = async (task: DelegatedWorkflowTask) => {
    if (task === activeTask) return;
    try {
      setActiveTask(await bridge.selectDesktopTask(task));
    } catch {
      onError(
        task === "VILLAGE_FIXTURE"
          ? "Return control explicitly before reopening the Village demo setup."
          : "The browser task could not be switched safely.",
      );
    }
  };

  return (
    <DelegatedWorkflowCard
      snapshot={snapshot}
      activeTask={activeTask}
      pendingAction={pendingAction}
      onAction={(action) => void run(action)}
      onSelectTask={(task) => void select(task)}
    />
  );
}
