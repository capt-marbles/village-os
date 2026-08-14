import type { DelegatedWorkflowSnapshot } from "@village/ui";
import type { WorkflowRuntimeResult } from "./delegated-workflow-controller.js";
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
  private runGeneration = 0;
  private running: Promise<void> | undefined;

  constructor(
    initialSnapshot: DelegatedWorkflowSnapshot,
    private readonly controller: {
      runOnce(): Promise<WorkflowRuntimeResult>;
      takeover(timeoutMs: number): Promise<WorkflowRuntimeResult>;
      handBack(): Promise<WorkflowRuntimeResult>;
      reconcile(): Promise<WorkflowRuntimeResult>;
      cancelFutureAutomation(): void;
      takeoverOffline(): void;
    },
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
    if (this.running) return this.current;
    this.publish({
      ...this.current,
      state: "STARTING",
      controller: "AGENT",
      connection: "ONLINE",
      inputOwner: "NONE",
    });
    this.startPump();
    return this.current;
  }

  async takeOver(): Promise<DelegatedWorkflowSnapshot> {
    this.runGeneration += 1;
    return this.after(await this.controller.takeover(5_000));
  }

  async handBack(): Promise<DelegatedWorkflowSnapshot> {
    const snapshot = await this.after(await this.controller.handBack());
    if (snapshot.state === "WORKING") {
      await this.running;
      this.startPump();
    }
    return snapshot;
  }

  async cancel(): Promise<DelegatedWorkflowSnapshot> {
    this.runGeneration += 1;
    this.controller.cancelFutureAutomation();
    return this.publish(
      await this.dependencies.readCanonicalSnapshot({
        status: "FENCED",
        reason: "CANCELED",
      }),
    );
  }

  async retry(): Promise<DelegatedWorkflowSnapshot> {
    const snapshot = await this.after(await this.controller.reconcile());
    if (snapshot.state === "WORKING") return this.start();
    return snapshot;
  }

  fence(_reason: "TASK_SWITCH" | "APP_CLOSE"): void {
    this.runGeneration += 1;
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

  private async pump(generation: number): Promise<void> {
    try {
      for (
        let step = 0;
        step < 4 && generation === this.runGeneration;
        step += 1
      ) {
        const logicalStep = this.current.logicalStep;
        const result = await this.controller.runOnce();
        if (generation !== this.runGeneration) return;
        const snapshot = await this.after(result);
        if (
          result.status !== "RECEIPTED" ||
          snapshot.state !== "WORKING" ||
          snapshot.logicalStep === logicalStep
        ) {
          return;
        }
      }
    } catch {
      if (generation === this.runGeneration) {
        this.publish({
          ...this.current,
          state: "FAILED",
          controller: "NONE",
          inputOwner: "NONE",
        });
      }
    }
  }

  private startPump(): void {
    if (this.running) return;
    const generation = ++this.runGeneration;
    const running = this.pump(generation);
    this.running = running;
    void running.finally(() => {
      if (this.running === running) this.running = undefined;
    });
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
