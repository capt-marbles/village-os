import type { DelegatedWorkflowSnapshot } from "@village/ui";
import type { LocalBrowserHost } from "../browser/local-browser-host.js";
import type { InternalDelegatedWorkflowOperations } from "./app-window.js";

type CreatedWorkflow = {
  operations: InternalDelegatedWorkflowOperations;
};

export class LazyDelegatedWorkflow<
  Created extends CreatedWorkflow,
> implements InternalDelegatedWorkflowOperations {
  private current: DelegatedWorkflowSnapshot;
  private readonly listeners = new Set<
    (snapshot: DelegatedWorkflowSnapshot) => void
  >();
  private created: Created | undefined;
  private creation: Promise<Created> | undefined;
  private fixtureHost: Promise<LocalBrowserHost> | undefined;
  private fixtureHostValue: LocalBrowserHost | undefined;
  private unsubscribeCreated: (() => void) | undefined;

  constructor(
    initialSnapshot: DelegatedWorkflowSnapshot,
    private readonly create: () => Promise<Created>,
  ) {
    this.current = initialSnapshot;
  }

  snapshot(): DelegatedWorkflowSnapshot {
    return this.current;
  }

  isCreated(): boolean {
    return this.created !== undefined;
  }

  isCreationStarted(): boolean {
    return this.creation !== undefined || this.created !== undefined;
  }

  subscribe(
    listener: (snapshot: DelegatedWorkflowSnapshot) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async result(): Promise<Created> {
    return this.ensureCreated();
  }

  async createFixtureHost(): Promise<LocalBrowserHost> {
    const created = await this.ensureCreated();
    if (!this.fixtureHost) {
      const fixtureHost = created.operations
        .createFixtureHost()
        .then((host) => {
          this.fixtureHostValue = host;
          return host;
        })
        .catch((error: unknown) => {
          if (this.fixtureHost === fixtureHost) {
            this.fixtureHost = undefined;
            this.fixtureHostValue = undefined;
          }
          this.publishFailure();
          throw error;
        });
      this.fixtureHost = fixtureHost;
    }
    return this.fixtureHost;
  }

  invalidateFixtureHost(host: LocalBrowserHost): void {
    if (this.fixtureHostValue !== host) return;
    this.fixtureHost = undefined;
    this.fixtureHostValue = undefined;
  }

  async start(): Promise<DelegatedWorkflowSnapshot> {
    const created = await this.ensureCreated();
    await this.createFixtureHost();
    const snapshot = this.publish(await created.operations.start());
    return snapshot;
  }

  async takeOver(): Promise<DelegatedWorkflowSnapshot> {
    const created = await this.ensureCreated();
    return this.publish(await created.operations.takeOver());
  }

  async handBack(): Promise<DelegatedWorkflowSnapshot> {
    const created = await this.ensureCreated();
    return this.publish(await created.operations.handBack());
  }

  async cancel(): Promise<DelegatedWorkflowSnapshot> {
    const created = await this.ensureCreated();
    return this.publish(await created.operations.cancel());
  }

  async retry(): Promise<DelegatedWorkflowSnapshot> {
    const created = await this.ensureCreated();
    await this.createFixtureHost();
    return this.publish(await created.operations.retry());
  }

  fence(reason: "TASK_SWITCH" | "APP_CLOSE"): void {
    this.created?.operations.fence(reason);
  }

  dispose(): void {
    this.unsubscribeCreated?.();
    this.unsubscribeCreated = undefined;
    this.listeners.clear();
  }

  private ensureCreated(): Promise<Created> {
    if (this.created) return Promise.resolve(this.created);
    if (!this.creation) {
      const creation = this.create()
        .then((created) => {
          this.created = created;
          this.unsubscribeCreated = created.operations.subscribe((snapshot) =>
            this.publish(snapshot),
          );
          this.replace(created.operations.snapshot());
          return created;
        })
        .catch((error: unknown) => {
          if (this.creation === creation) this.creation = undefined;
          this.publishFailure();
          throw error;
        });
      this.creation = creation;
    }
    return this.creation;
  }

  private publishFailure(): void {
    this.publish({
      ...this.current,
      state: "FAILED",
      controller: "NONE",
      connection: "ABSENT",
      inputOwner: "NONE",
      lastDurableUpdateAt: this.current.lastDurableUpdateAt,
    });
  }

  private publish(
    snapshot: DelegatedWorkflowSnapshot,
  ): DelegatedWorkflowSnapshot {
    if (snapshot === this.current) return this.current;
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

  private replace(
    snapshot: DelegatedWorkflowSnapshot,
  ): DelegatedWorkflowSnapshot {
    this.current = snapshot;
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }
}
