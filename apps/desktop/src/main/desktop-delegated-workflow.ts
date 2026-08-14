import type { DelegatedWorkflowSnapshot } from "@village/ui";
import type {
  DelegatedWorkflowController,
  WorkflowRuntimeResult,
} from "./delegated-workflow-controller.js";
import type { InternalDelegatedWorkflowOperations } from "./app-window.js";
import type { LocalBrowserHost } from "../browser/local-browser-host.js";

/**
 * Thin desktop projection over the durable controller. It never synthesizes
 * progress: after every operation it re-reads the canonical snapshot owned by
 * the coordinator composition.
 */
export class DesktopDelegatedWorkflow implements InternalDelegatedWorkflowOperations {
  private readonly listeners = new Set<
    (snapshot: DelegatedWorkflowSnapshot) => void
  >();
  private current: DelegatedWorkflowSnapshot;

  constructor(
    initialSnapshot: DelegatedWorkflowSnapshot,
    private readonly controller: DelegatedWorkflowController,
    private readonly dependencies: {
      createFixtureHost(): Promise<LocalBrowserHost>;
      readCanonicalSnapshot(
        result?: WorkflowRuntimeResult,
      ): Promise<DelegatedWorkflowSnapshot>;
      providerConnected(): boolean;
    },
  ) {
    this.current = initialSnapshot;
  }

  createFixtureHost(): Promise<LocalBrowserHost> {
    return this.dependencies.createFixtureHost();
  }

  snapshot(): DelegatedWorkflowSnapshot {
    return this.current;
  }

  subscribe(
    listener: (snapshot: DelegatedWorkflowSnapshot) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<DelegatedWorkflowSnapshot> {
    if (!this.dependencies.providerConnected()) {
      return this.publish({ ...this.current, state: "DISCONNECTED" });
    }
    return this.after(await this.controller.runOnce());
  }

  async takeOver(): Promise<DelegatedWorkflowSnapshot> {
    return this.after(await this.controller.takeover(5_000));
  }

  async handBack(): Promise<DelegatedWorkflowSnapshot> {
    return this.after(await this.controller.handBack());
  }

  async cancel(): Promise<DelegatedWorkflowSnapshot> {
    this.controller.cancelFutureAutomation();
    return this.publish(
      await this.dependencies.readCanonicalSnapshot({
        status: "FENCED",
        reason: "CANCELED",
      }),
    );
  }

  async retry(): Promise<DelegatedWorkflowSnapshot> {
    return this.after(await this.controller.reconcile());
  }

  fence(_reason: "TASK_SWITCH" | "APP_CLOSE"): void {
    this.controller.takeoverOffline();
    void this.dependencies
      .readCanonicalSnapshot({
        status: "OWNER_CONTROL",
        outcome: "QUIESCED",
        coordinatorSynchronized: false,
      })
      .then((snapshot) => this.publish(snapshot));
  }

  private async after(
    result: WorkflowRuntimeResult,
  ): Promise<DelegatedWorkflowSnapshot> {
    return this.publish(await this.dependencies.readCanonicalSnapshot(result));
  }

  private publish(
    snapshot: DelegatedWorkflowSnapshot,
  ): DelegatedWorkflowSnapshot {
    if (
      Date.parse(snapshot.lastDurableUpdateAt) <
      Date.parse(this.current.lastDurableUpdateAt)
    ) {
      return this.current;
    }
    this.current = snapshot;
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }
}
